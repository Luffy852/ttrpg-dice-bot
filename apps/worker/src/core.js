/* ============================================================================
 * core.js —— 房间内核（**纯逻辑**，不含任何 Cloudflare / WebSocket API）
 * ----------------------------------------------------------------------------
 * 【为什么把内核单独抽出来】
 *   M3 最容易错的三个机制 —— 幂等防重掷、游标补齐、状态写回 —— 全部是纯逻辑。
 *   如果它们写在 Durable Object 里，就只能靠部署到 Cloudflare 才能验，
 *   而沙盒**不能**部署。抽成纯逻辑 + 注入 storage，就能在 node 里真跑真断言。
 *   room.js（DO）只剩 IO 胶水：ws 收发、序列化、alarm。
 *
 * 【★ 三条硬规矩（都是踩过/必然踩的坑）】
 *   ① 掷骰只发生在 handleCommand 里，且**必须先过幂等键**——重试拿到的是 dup，不是第二颗骰
 *   ② 游标用 seq（DO 单线程自增整数，严格单调），**不用 ts**（时钟会回拨、同一毫秒会撞）
 *   ③ 客户端状态一律以后端为准回写：core 返回的 msgs / state 是唯一事实来源
 *
 * 【storage 接口（注入）】getRoom / setRoom / allocSeq / getCard / setCard /
 *   getIdem / putIdem / insertMsgs / recentRolls / since / history / brief / hasIds / reflow
 * ========================================================================== */
import * as Engine from '../../../packages/engine/src/index.js';
import {factsFromView} from '../../../packages/engine/src/replay.js';
import {checkText, normalize, checkPayload, KIND} from '../../../packages/protocol/src/payload.js';
import {tokenBucket, msgId, cursorOf} from '../../../packages/protocol/src/cursor.js';
import {ymd as ymdOf} from '../../../packages/engine/src/util.js';

const HISTORY_LIMIT = 200;      // 首屏 / 补齐条数（has_more 继续向上翻）
const IDLE_ROLLS = 5;           // .h 用：我的最近 5 条投掷
const KEEP_MS = 30 * 86400000;  // ★ 续期窗口：与房间留存期一致（导出 / 导入各续一次）

export function createRoomCore(storage, opts){
  const code = storage.code;
  const now = (opts && opts.now) || (() => Date.now());
  const rate = new Map();       // anonId → 令牌桶状态
  const log = (opts && opts.log) || (() => {});
  /* ★ 在线人数由 DO 注入（core 是纯逻辑，碰不到 WebSocket 列表）。
   *   不注入时是 null —— .status 显示「—」而不是编一个数字（保守：宁可少说，不可说错）。 */
  const onlineOf = (opts && opts.online) || null;
  const memberCountOf = (opts && opts.memberCount) || null;

  /* ---------- 引擎 ctx：房间状态 ⇄ 引擎 ---------- */
  async function buildCtx(anonId, nick){
    const room = await storage.getRoom();
    const card = await storage.getCard(anonId);
    // .h 只查我自己的最近投掷 —— 不把整个房间历史塞进内存
    const rolls = await storage.recentRolls(anonId, IDLE_ROLLS);
    const history = rolls.map(m => ({kind:m.kind, actor:m.actor, ts:m.ts, view:Engine.viewFromPayload(m.payload)}));
    /* ★ .status 的「本房间共 N 条」必须是**现存量 COUNT(*)**，不是 room.seq。
     * 【为什么】seq 是"已分配到的最大序号"，删除后不回退 —— 30 天清理删掉旧消息后，
     *   seq 仍指向一个不存在的序号，数字会一直虚高（实际 200 条显示 700）。
     *   .status 是给人看的房间概况，语义必须是"现在还有多少条"（用户已定口径）。
     * 【为什么不在引擎里自己数】引擎拿不到库；房间状态一律由 core 注入（ctx.room 的既有约定）。 */
    const msgCount = await storage.countMsgs();
    /* ★ 续期截止（.status 要显示"已续期至 X"）：取库里最大的 keep_until。
     *   它代表"房间里最晚到期那批" —— 用户看这一行就知道下次该什么时候再导出。 */
    const keepUntil = await storage.maxKeepUntil();
    let seq = room.seq || 0;
    return {
      room: {
        rule: room.rule || 'generic',
        baredice: !!room.baredice,
        ruleSetBy: room.ruleSetBy || null,
        ruleSetAt: room.ruleSetAt || null,
        msgCount,
        online: onlineOf ? onlineOf() : null,      // 当前在线（ws 连接数）；null = 未知（纯逻辑测不到）
        members: memberCountOf ? memberCountOf() : null,  // 累计接入人次
        keepUntil: keepUntil ? ymdOf(keepUntil) : null,
        /* ★ 引擎里所有"现在几点"一律用**服务端时钟**（本项目铁律：客户端时间不可信，
         *   而引擎既跑在 Worker 也可能跑在浏览器侧 —— 不注入就会出现两个时钟）。
         *   注入后 .set rule 落库的时间串与消息 ts 保证同源；不注入时退回 Date.now()。 */
        nowMs: now(),
        seq: 0,
        nextId(){ return ++seq; },     // id 是占位：真正的 id 由 allocSeq 分配
      },
      me: nick, card, history,
      _roomBefore: {rule:room.rule, baredice:room.baredice, ruleSetBy:room.ruleSetBy, ruleSetAt:room.ruleSetAt},
    };
  }

  /* ---------- 事实化：view（含派生）→ payload（只存事实） ---------- */
  function factsOf(msg, ruleAt){
    if(msg.kind === 'roll'){
      const p = factsFromView(msg.view);
      const bad = checkPayload(KIND.ROLL, p);
      if(bad) throw new Error('roll payload 非法：' + bad);
      return normalize(KIND.ROLL, p);
    }
    if(msg.kind === 'html')  return normalize(KIND.HTML,  {defs:msg.defs});
    if(msg.kind === 'notice')return normalize(KIND.NOTICE,{html:msg.html});
    if(msg.kind === 'sys')   return normalize(KIND.SYS,   {title:msg.title, line1:msg.line1, line2:msg.line2});
    return null;
  }

  /**
   * 执行一条指令（服务端权威掷骰的唯一入口）
   * @returns {{dup:boolean, msgs:Array, seq:number|null, reject?:{code:string}, state?:object}}
   */
  async function apply({reqId, text, anonId, nick}){
    const t0 = now();
    // ① 文本上限：超了显式拒，绝不静默截断（截断会掷出用户没点的结果）
    const bad = checkText(text);
    if(bad) return {dup:false, msgs:[], reject:{code:bad}};

    // ② 限流（同连接令牌桶）
    const st = rate.get(anonId) || {tokens:10, ts:t0};
    const tb = tokenBucket(st, t0, 10, 5);
    rate.set(anonId, st);
    if(!tb.ok) return {dup:false, msgs:[], reject:{code:'rate_limited'}};

    // ③ ★ 幂等：命中即返回原结果，绝不重掷
    const hit = await storage.getIdem(reqId);
    if(hit){
      const alive = await storage.existsSeq(hit.seq);
      return {dup:true, msgs:[], seq:hit.seq, deleted:!alive};
    }

    const ctx = await buildCtx(anonId, nick);
    const before = ctx._roomBefore;
    const hadCard = !!ctx.card;      // ★ 执行前是否绑着卡 —— 解绑要靠它区分"删"与"本来就没有"

    /* ④ ★★ 用户原文**无条件**进消息记录（呈现原则 3：用户指令必须可回看）
     *    —— 不是"只在引擎没输出时才记"。
     * 【为什么必须无条件】M2 的 LocalSource.send() 就是无条件先 emit 用户消息再 emit 结果。
     *   写成 `if(!out.length)` 的后果：**所有成功的指令**用户原文都被丢掉 ——
     *   而骰点类指令占消息的 60–80%，等于绝大多数"我当时打了什么"无法回溯，
     *   导出的战报也只剩骰娘的结果、没有玩家的输入。
     * 【为什么在 handleCommand 之前定型】用**指令执行前**的房间状态判断是不是指令
     *   （裸骰开关若被本条指令自己打开，不该把这条 retroactive 算成指令），
     *   且与 M2 的 emit 顺序一致。isCommandText 的第二个参数就是房间状态，不能省。 */
    const userMsg = {kind:Engine.isCommandText(text, ctx.room) ? KIND.CMD : KIND.CHAT, payload:{text}};
    const r = Engine.handleCommand(text, ctx);
    const out = r.msgs;

    const n = out.length + (userMsg ? 1 : 0);
    const base = await storage.allocSeq(n);
    const ts = now();
    const msgs = [];
    let i = 0;
    if(userMsg){
      const seq = base + i++;
      msgs.push({seq, id:msgId(code, seq), ts, kind:userMsg.kind, from:nick, actor:nick,
                 anon_id:anonId, req_id:reqId, rule_at:before.rule, payload:userMsg.payload});
    }
    for(const m of out){
      const seq = base + i++;
      msgs.push({
        seq, id:msgId(code, seq), ts,
        kind:m.kind, from:m.from || '骰娘', actor:m.actor || nick, anon_id:(m.from === '骰娘' ? null : anonId),
        req_id:reqId, rule_at:ctx.room.rule,
        payload:factsOf(m, ctx.room.rule) || {text:''},
      });
    }

    // ⑤ 落库（幂等键与消息同事务语义：先写 idem 再写 msgs，崩了也不会重掷两次）
    await storage.putIdem(reqId, base, ts);
    await storage.insertMsgs(msgs);

    // ⑥ 状态写回：规则 / 裸骰 / 卡 —— 引擎改了什么就存什么（diff，不整存）
    const after = {rule:ctx.room.rule, baredice:ctx.room.baredice, ruleSetBy:ctx.room.ruleSetBy, ruleSetAt:ctx.room.ruleSetAt};
    const changed = before.rule !== after.rule || before.baredice !== after.baredice;
    if(changed) await storage.setRoom(after);
    /* ★ 解绑必须真的删库（真机反馈 · B 组）：`.st clear` 把 ctx.card 置成 null，
     *   而这里原先只写 `if(ctx.card)` —— null 就什么都不做，库里的卡原封不动。
     *   于是：clear → 提示"已解绑" → 再发 `.st` 又从库里读回来，卡"复活"。
     *   （同一时间别的玩家发 `.st` 只是让你看到自己的卡复活，不是他把你卡改回来了。）
     *   hadCard 必须在**执行前**记下，否则分不清"本来就没卡"和"刚解绑"。 */
    if(ctx.card) await storage.setCard(anonId, ctx.card);
    else if(hadCard) await storage.delCard(anonId);
    if(ctx.me !== nick) await storage.setNick(anonId, ctx.me);

    log('apply', {reqId, n, base, changed});
    return {
      dup:false, msgs, seq:base,
      state:changed ? {rule:after.rule, baredice:after.baredice, rule_set_by:after.ruleSetBy, rule_set_at:after.ruleSetAt} : null,
      nick:ctx.me !== nick ? ctx.me : null,
    };
  }

  /** 首屏 / 补齐：cursor 之后最多 HISTORY_LIMIT 条
   *  ★ cursor = 客户端已渲染的**最大 seq**，补齐是"它之后"，含它自己会重复渲染一条 */
  async function since(cursor, limit){
    const msgs = await storage.since(cursor, limit || HISTORY_LIMIT);
    return {msgs, cursor:cursorOf(msgs), has_more:msgs.length >= (limit || HISTORY_LIMIT)};
  }

  /** ★ 首屏：取**最近** HISTORY_LIMIT 条（真机反馈 · C 组）
   * 【坑】刷新时客户端 cursor 归 0，若走 since(0) 拿到的是**最早** 200 条 ——
   *   房间超过 200 条后，刷新后看到的是开头那一段，后面的消息再也出不来
   *   （没有上滚加载就永远看不到，而战报导出是全量，用户会以为消息丢了）。
   *   不刷新时一直走 ws 增量，所以这个 bug 只在"刷新/重进"时出现 —— 最难发现的一种。
   * 【为什么是最近而不是最早】跑团看的是"刚才发生了什么"，最近 200 条才是有效信息。 */
  async function recent(limit){
    const n = limit || HISTORY_LIMIT;
    const msgs = await storage.recent(n);
    const total = await storage.countMsgs();
    return {msgs, cursor:cursorOf(msgs), has_more:total > msgs.length, total};
  }

  /** 向上翻页 */
  async function history(beforeSeq, limit){
    return {msgs:await storage.history(beforeSeq, limit || HISTORY_LIMIT)};
  }

  return {apply, since, recent, history, factsOf, code};
}

/* ============================================================================
 * 战报导入：跨房间 + 按绝对时间重排（★ 用户已定口径）
 * ----------------------------------------------------------------------------
 * 【要什么】
 *   ① 旧房间的消息要能带去**另一个**房间（不只是导回原房间）
 *   ② 导入后按**绝对时间 ts** 并入总消息库并重排，客户端显示重排后的最新 200 条
 *      —— 不是"接在最后重新打时间戳"。时间顺序是理解跑团内容的线索。
 *
 * 【★★ 为什么必须整体重排 seq，不能只改排序规则 ★★】
 *   seq 身兼三职：① 房间内的显示顺序 ② 客户端游标（since(cursor) 补齐）
 *   ③ 上翻锚点（history(before_seq)）。只改渲染排序、不动 seq，
 *   游标语义立刻崩：客户端报"我已渲染到 seq 500"，而 500 在 ts 序里可能在中间，
 *   补齐就会漏掉一半、或把已渲染的再补一遍。所以顺序 = seq，必须重排。
 *
 * 【★ 排序键 = (ts, batch, origSeq)】
 *   ts       —— 用户要的绝对时间顺序
 *   batch    —— 同秒时的兜底：**现有消息(0) 在前，本次导入(1) 在后**（用户已定）
 *   origSeq  —— 同秒同批时按原 seq，保住"指令 → 骰娘回复"的内部顺序
 *               同一条指令产生的多条消息 ts 完全相同，靠 ts 分不出先后，
 *               必须用原 seq 兜底，否则回复可能跑到指令前面。
 *
 * 【★ 新 seq 一律从 room.seq + 1 开始分配（关键，防 id 撞车）】
 *   msg_id 的形式是 `code:seq`，且**导入进来的消息保留原 id**（这样重复导入才认得出）。
 *   如果重排时把 seq 压回 1..N，就可能生成已被占用的 id：
 *     例：清理删掉了老消息，剩余 40 条的 id 是 B:461..B:500，压回 1..40 后
 *         新分配 B:41 → 以后分到 B:461 时与保留的 id 撞车 → UNIQUE 报错 → 指令丢失。
 *   从 room.seq+1 起分配，新 id 的序号恒大于历史上分配过的任何序号，**不可能撞**。
 *   代价是 seq 每次导入都跳一段数字 —— seq 只是顺序，不是连续编号，无副作用。
 *
 * 【★ 导入消息的 req_id 一律清空】
 *   req_id 是**幂等键**：同键再发 = dup，不掷第二次骰。
 *   把外房间的 req_id 带进来，万一与本机未来的 req_id 撞车，
 *   玩家的一条正常指令会被判成"已掷过" —— 骰娘最不能犯的错。宁可丢掉这个调试信息。
 * ========================================================================== */

/** 纯函数：现有消息 + 新消息 → 重排后的顺序（返回 id 序列）。抽出来是为了能直接断言。 */
export function mergeOrder(cur, incoming){
  const rows = [];
  (cur || []).forEach(m => rows.push({id:m.id, ts:m.ts, batch:0, orig:m.seq}));
  (incoming || []).forEach(m => rows.push({id:m.id, ts:m.ts, batch:1, orig:m.seq}));
  rows.sort((a, b) => (a.ts - b.ts) || (a.batch - b.batch) || (a.orig - b.orig));
  return rows.map(r => r.id);
}

/**
 * 规划一次导入。只依赖 storage 的只读方法，产出"怎么改"，由后端一次性落库。
 * @returns {null|{add, reseq, seqEnd, idem, skipped}}
 */
export async function planImport(storage, incoming, nowMs){
  const ids = (incoming || []).map(m => m.id).filter(Boolean);
  const have = await storage.hasIds(ids);
  const fresh = (incoming || []).filter(m => !m.id || !have.has(m.id));
  if(!fresh.length) return {add:[], reseq:[], seqEnd:null, idem:[], skipped:have.size, errs:[]};
  const cur = await storage.brief();
  const room = await storage.getRoom();
  const S = room.seq || 0;
  const order = mergeOrder(cur, fresh);
  /* id → 新 seq */
  const seqOf = new Map();
  order.forEach((id, i) => seqOf.set(id, S + 1 + i));
  /* ① 已有的：只改 seq（id 不动 —— id 是跨重排的稳定身份，重排只动顺序） */
  const reseq = [];
  cur.forEach(m => { if(seqOf.has(m.id)) reseq.push([m.id, seqOf.get(m.id)]); });
  /* ② 新来的：带上新 seq 落库，id 保留原值（重复导入靠它认出来）
   *   ★ keep_until：导入就是一次"我要这些内容" —— 与导出一样给它们续 30 天。
   *     「来源房间」始终保留最初的出生房间（用户已定），所以接力链 A→B→C 里
   *     C 看到的标签仍是 A —— 而且 id 不变意味着去重在整条链上都有效。 */
  const until = (nowMs != null ? nowMs : Date.now()) + KEEP_MS;
  const add = fresh.map(m => Object.assign({}, m,
    {seq:seqOf.get(m.id), req_id:null, keep_until:until}));
  /* ③ 幂等表里的 seq 也要跟着搬：否则重试那条指令会拿到一个已经不存在的 seq */
  const idem = [];
  cur.forEach(m => { if(seqOf.has(m.id)) idem.push([m.seq, seqOf.get(m.id)]); });
  return {add, reseq, seqEnd:S + order.length, idem, skipped:have.size, errs:[]};
}

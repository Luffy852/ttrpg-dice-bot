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
 *   getIdem / putIdem / insertMsgs / recentRolls / since / history
 * ========================================================================== */
import * as Engine from '../../../packages/engine/src/index.js';
import {factsFromView} from '../../../packages/engine/src/replay.js';
import {checkText, normalize, checkPayload, KIND} from '../../../packages/protocol/src/payload.js';
import {tokenBucket, msgId, cursorOf} from '../../../packages/protocol/src/cursor.js';

const HISTORY_LIMIT = 200;      // 首屏 / 补齐条数（has_more 继续向上翻）
const IDLE_ROLLS = 5;           // .h 用：我的最近 5 条投掷

export function createRoomCore(storage, opts){
  const code = storage.code;
  const now = (opts && opts.now) || (() => Date.now());
  const rate = new Map();       // anonId → 令牌桶状态
  const log = (opts && opts.log) || (() => {});

  /* ---------- 引擎 ctx：房间状态 ⇄ 引擎 ---------- */
  async function buildCtx(anonId, nick){
    const room = await storage.getRoom();
    const card = await storage.getCard(anonId);
    // .h 只查我自己的最近投掷 —— 不把整个房间历史塞进内存
    const rolls = await storage.recentRolls(anonId, IDLE_ROLLS);
    const history = rolls.map(m => ({kind:m.kind, actor:m.actor, ts:m.ts, view:Engine.viewFromPayload(m.payload)}));
    let seq = room.seq || 0;
    return {
      room: {
        rule: room.rule || 'generic',
        baredice: !!room.baredice,
        ruleSetBy: room.ruleSetBy || null,
        ruleSetAt: room.ruleSetAt || null,
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
    if(ctx.card) await storage.setCard(anonId, ctx.card);
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

  /** 向上翻页 */
  async function history(beforeSeq, limit){
    return {msgs:await storage.history(beforeSeq, limit || HISTORY_LIMIT)};
  }

  return {apply, since, history, factsOf, code};
}

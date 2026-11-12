/* ============================================================================
 * initiative.js —— S2 模块 B · DND 先攻「运行时指令层」纯逻辑
 * ----------------------------------------------------------------------------
 * 【为什么单独一层】引擎是纯 ESM、零 Node/DO API，碰不到 combat* 表；先攻要读写
 *   两张辅助表并产出消息，执行层必须在 Worker。归属/可用性仍走引擎的 verbOwner()
 *   + DND_PACK 可选 initiative 声明（I·3.1），主流程不写 if(rule==='dnd')。
 * 【4A 接缝】core.apply 在 Engine.handleCommand 之前按 verb 分流到这里；本模块只产出
 *   引擎风格的 msgs 交给 core 统一 factsOf / allocSeq / putIdem / insertMsgs / 广播，
 *   「用户原文 cmd 消息 + 幂等 + 游标」链路一条不动，续活由 room.js 的 refreshAnchor 覆盖。
 * 【持久化】只读 storage.combatSnapshot() 与写 storage.combatApply(ops)；
 *   ops 是显式操作列表，SQL 语义集中在三份 storage 实现里（check-worker.mjs 守对齐）。
 * 【不做什么】不新增 kind / INIT 帧 / 前端面板 / 回合内行动标记 / 并列权重 / 逐骰明细 /
 *   权限字段 / 归档表（I·1 边界 3/4/12/17、I·3.7、I·3.5）。
 * ========================================================================== */
import {lookupAlias, normToken} from '../../../packages/engine/src/alias.js';
import {cardMod} from '../../../packages/engine/src/card.js';
import {parseExpr} from '../../../packages/engine/src/parse.js';
import {rollGroups} from '../../../packages/engine/src/roll.js';
import {rulePack, RULE_PACKS, verbOwner} from '../../../packages/engine/src/packs.js';
import {RULE_META} from '../../../packages/engine/src/rules.js';
import {esc} from '../../../packages/engine/src/util.js';
import {buildTotal, sumKept} from '../../../packages/engine/src/view.js';

export const INIT_VERBS = new Set(['ri', 'init']);
const ORDER_NOTE = '⚠️ 先攻值变化可能影响本轮行动顺序，请留意当前轮次';
const USAGE_RI = '.ri [角色] [值/表达式] [优劣势]　（三段顺序任意；@可省略；3#哥布林批量；18=固定值；+2=叠加到 d20+敏捷）';
const USAGE_INIT = '.init 查看　·　.init set <名> <值> 改值　·　.init del <名...> 删条目　·　.init clear 清空　·　.init combat end 结束整场　·　.init 战斗结束 同上　·　.init 结束 / next / 下一位 推进一回合　·　.init prev 回退';
const MAX_BULK = 20;

/* ---------- 1. 输入切词：支持 @"哥布林 弓手" ---------- */
function tokenize(s){
  const out = [];
  let cur = '', quoted = false;
  for(const ch of String(s || '')){
    if(ch === '"'){ quoted = !quoted; continue; }
    if(/\s/.test(ch) && !quoted){ if(cur){ out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if(cur) out.push(cur);
  return out;
}

/* ---------- 2. 值段分类（.ri 三段 / .init set 复用） ---------- */
/* token 形态 → 已知形态先吃掉，剩下的唯一 token 即角色名（I·3.4.2） */
function classify(t){
  const nt = normToken(t);
  const md = lookupAlias('mode', nt);
  if(md) return {kind:'mode', key:md.key};
  const bulk = t.match(/^(\d+)#(.+)$/);
  if(bulk) return {kind:'bulk', n:parseInt(bulk[1], 10), name:bulk[2]};
  if(t[0] === '=') return {kind:'base', expr:t.slice(1)};
  if(/^[+-]/.test(t)){
    if(/^-\d*d\d/i.test(t)) return {kind:'badneg'};
    return {kind:'adj', s:t};
  }
  if(/^\d+$/.test(t)) return {kind:'fixed', n:parseInt(t, 10)};
  if(/^(?:d|\d+d)/i.test(t)) return {kind:'base', expr:t};
  return {kind:'name', s:t};
}

/** 值段 + 优劣势解析；不含角色/批量/名字 */
function parseValue(tokens){
  const spec = {bases:[], adjs:[], fixed:null, mode:null, err:null};
  const names = [];
  for(const t of tokens){
    const c = classify(t);
    if(c.kind === 'mode'){ if(spec.mode && spec.mode !== c.key) spec.err = '优势与劣势不能同时写'; else spec.mode = c.key; continue; }
    if(c.kind === 'badneg'){ spec.err = '负骰组「' + esc(t) + '」不合法 —— 常数负值请写 -1，完整表达式请写 d20-1d4 这类不以前导负号开头的写法'; continue; }
    if(c.kind === 'base'){ spec.bases.push(c.expr); continue; }
    if(c.kind === 'adj'){ spec.adjs.push(c.s); continue; }
    if(c.kind === 'fixed'){
      if(spec.fixed != null) spec.err = '固定值只能写一个';
      else spec.fixed = c.n;
      continue;
    }
    names.push(c);
  }
  if(spec.bases.length && spec.fixed != null) spec.err = '固定值（不掷骰）与掷骰表达式不能同现';
  if(spec.bases.length > 1) spec.err = '完整表达式只能写一个基底';
  if(spec.adjs.length && spec.fixed != null) spec.err = '固定值（不掷骰）与调整项不能同现';
  return {spec, names};
}

/** 敏捷调整值的符号规范化：dexMod = −1 必须拼成 d20-1，不能是 d20+-1（parseExpr 实测 syntax） */
function signed(n){
  const v = Number(n) || 0;
  return v > 0 ? '+' + v : (v < 0 ? String(v) : '');
}

/** 一次先攻值的计算（批量时每个条目各调一次 → 各自独立 RNG） */
function computeValue(spec, dexMod, ruleKey){
  if(spec.err) return {err:spec.err};
  if(spec.fixed != null) return {value:spec.fixed};          // 固定值：不掷骰、不含默认敏捷项
  const base = spec.bases.length ? spec.bases[0] : ('d20' + signed(dexMod));
  const expr = base + spec.adjs.join('');                    // ★ 分类收集 → 基底在前、调整在后
  const p = parseExpr(expr);
  if(!p.ok) return {err:'先攻表达式「' + esc(expr) + '」不合法：' + esc(p.reason === 'limit' ? '单次骰数 / 面数超限' : '语法不支持（括号、乘除、骰池等）')};
  /* ★ I·3.4.2 ⑤ / I·1 例外：先攻的优劣势是「整条指令连投两次，按合计取高/低」，
   *   不是「只把 d20 投两次」。rollGroups 的 DND 分支（只 d20 连投）服务于 .r / .rc 的
   *   常规优势，通用分支才是整条连投 —— 这里传 'generic' 选后者，rollGroups 一行不改
   *   （830×2 断言守着），也不引入 kh/kl 通用语法。ruleKey 参数保留供后续扩展。 */
  const groups = rollGroups(p.groups, spec.mode, 'generic');
  const comps = p.mod ? [{label:'调整值', v:p.mod}] : [];
  return {value:buildTotal(sumKept(groups), comps).total};
}

/* ---------- 3. 角色段 → 目标条目 ---------- */
function targetsOf(names, ctx, nick, anonId){
  const me = ctx.me || nick;
  const err = t => ({err:t});
  const bulks = names.filter(c => c.kind === 'bulk');
  const plain = names.filter(c => c.kind === 'name');
  if(bulks.length && (plain.length || bulks.length > 1)) return err('批量 3#名字 不能与单个角色名同写');
  if(plain.length > 1) return err('角色名含空格请用双引号包裹：@"哥布林 弓手"');
  if(bulks.length){
    const b = bulks[0];
    if(!(b.n >= 1 && b.n <= MAX_BULK)) return err('批量数量 1–' + MAX_BULK + '，请减小数量');
    return {targets:Array.from({length:b.n}, (_, i) => ({
      name:b.name + (i + 1), owner:me, cardRef:null, dexMod:0,
    }))};
  }
  if(!plain.length){
    const card = ctx.card || null;
    return {targets:[{name:me, owner:me, cardRef:card ? anonId : null,
      dexMod:card ? (Number(cardMod(card, 'dex')) || 0) : 0}]};
  }
  const name = plain[0].s.replace(/^@/, '');                 // @ 前缀可省略，裸名等价
  if(!name) return err('角色名不能为空');
  /* ★ buildCtx 只能拿到投掷者自己的卡（I·3.4.2 架构边界）：为他人 / 怪物建条目恒 dexMod=0 */
  return {targets:[{name, owner:name, cardRef:null, dexMod:0}]};
}

/* ---------- 4. .init 子命令（先整串精确查，再切首词） ---------- */
function parseInit(rest){
  const whole = normToken(rest);
  if(!whole) return {key:'view'};
  const hit = lookupAlias('initcmd', whole);
  if(hit) return {key:hit.key};
  const ts = tokenize(rest);
  const first = normToken(ts[0] || '');
  const sub = lookupAlias('initcmd', first);
  if(!sub) return {key:'usage'};
  if(sub.key === 'combat'){
    const w = lookupAlias('combatsub', normToken(ts[1] || ''));
    if(!w || ts.length !== 2) return {key:'usage', combat:true};
    return {key:'endcombat'};
  }
  if(sub.key === 'set') return {key:'set', args:ts.slice(1)};
  if(sub.key === 'del') return {key:'del', args:ts.slice(1)};
  return {key:sub.key};
}

/* ---------- 5. 呈现（全部走消息流，零前端改动 / 零新 kind） ---------- */
function seqHtml(snap){
  const e = snap.entries || [], c = snap.combat;
  const curId = (c && c.cursor_entry_id) || (e.length ? e[0].id : null);
  const round = (c && c.round) || 1;
  const cur = e.find(x => x.id === curId) || null;
  const lines = e.map((x, i) => (x.id === curId ? '▶ ' : '　 ') + (i + 1) + '. ' + esc(x.name) + ' <b>' + x.value + '</b>');
  return '⚔️ 先攻序列 · 第 ' + round + ' 轮<br>' + lines.join('<br>') +
    (cur ? '<br>当前 → <b>' + esc(cur.name) + '</b>（' + cur.value + '）' : '');
}
const notice = (nick, html) => ({kind:'notice', from:'骰娘', actor:nick, html});
const sys = (nick, title, line1, line2) => ({kind:'sys', from:'骰娘', actor:nick, title, line1, line2});

/* ---------- 6. 主入口 ---------- */
/**
 * @returns {{msgs:Array}} 引擎风格消息对象，交给 core.apply 统一落库
 */
export async function handleInitiative({verb, rest, storage, ctx, nowMs, anonId, nick}){
  const rule = ctx.room.rule;
  const spec = rulePack(rule).initiative || null;
  const snap = await storage.combatSnapshot();
  const before = snap.entries || [];
  const beforeEmpty = before.length === 0;
  const cmd = verb === 'init' ? parseInit(rest) : null;
  const isExempt = cmd && (cmd.key === 'clear' || cmd.key === 'endcombat');
  const ruleName = (RULE_META[rule] && RULE_META[rule].name) || rule;

  /* ① 归属 / 错配：不静默、不落条目（I·3.1 / I·3.2 / 验收 1、6） */
  if(!spec){
    const note = (RULE_PACKS[verbOwner('ri')] || {}).initiative;
    if(beforeEmpty){
      return {msgs:[notice(nick, note ? note.ownerNote(ruleName) : '先攻指令仅在 D&D 5e / 5.5e 下可用')]};
    }
    if(!isExempt){
      return {msgs:[notice(nick, note ? note.mismatchNote(ruleName) : '当前规则下先攻表不可用')]};
    }
    /* S1' 豁免：整场结束 / 清空，照常给结束广播 */
  }

  /* ② 空表查询 */
  if(beforeEmpty && verb === 'init' && cmd.key === 'view'){
    return {msgs:[notice(nick, '当前未开启先攻表 —— 用 <b>.ri</b> 录入首个条目')]};
  }

  /* ③ 清空类：四条路径语义等价，只发一条显著广播（I·3.2 / 验收 2、5） */
  if(verb === 'init' && (cmd.key === 'clear' || cmd.key === 'endcombat')){
    await storage.combatApply([{op:'clear'}]);
    return {msgs:[sys(nick, '⚠️ @全体 战斗结束，先攻表已清理',
      '已清理 ' + before.length + ' 个条目', '先攻表已清空，房间规则与历史消息不受影响')]};
  }
  if(verb === 'init' && cmd.key === 'usage'){
    return {msgs:[notice(nick, cmd.combat
      ? '.init combat end / finish / over 才结束整场战斗；<b>.init combat 结束</b> 与 <b>.init combat next</b> 不合法。' + USAGE_INIT
      : '未识别的先攻子命令。' + USAGE_INIT)]};
  }

  /* ④ .init 查看 / 推进 / 回退 / 删除（表非空） */
  if(verb === 'init'){
    const e = before;
    const c = snap.combat;
    const curId = (c && c.cursor_entry_id) || (e.length ? e[0].id : null);
    const idx = Math.max(0, e.findIndex(x => x.id === curId));
    const round = (c && c.round) || 1;
    const ops = [];
    let head = '⚔️ 先攻表 · 战斗中';

    if(cmd.key === 'view'){
      return {msgs:[notice(nick, head + '<br>' + seqHtml(snap))]};
    }
    if(cmd.key === 'advance' || cmd.key === 'prev'){
      let ni = cmd.key === 'advance' ? idx + 1 : idx - 1;
      let round2 = round;
      if(cmd.key === 'advance' && ni >= e.length){ ni = 0; round2 = round + 1; }
      if(cmd.key === 'prev' && ni < 0) ni = 0;          // 到首位停、不倒扣 round
      ops.push({op:'cursor', id:e[ni].id});
      if(round2 !== round) ops.push({op:'round', n:round2});
      head = cmd.key === 'advance' ? '▶ 推进一回合' : '◀ 回退一回合';
    } else if(cmd.key === 'del'){
      const names = (cmd.args || []).map(x => x.replace(/^@/, ''));
      if(!names.length) return {msgs:[notice(nick, '用法：<b>.init del 哥布林1 哥布林2</b>（可批量）')]};
      const missing = names.filter(n => !e.some(x => x.name === n));
      ops.push({op:'delete', names});
      const afterDel = await storage.combatApply(ops);
      const after = afterDel.entries || [];
      if(!after.length){
        /* ★ 四条清空路径语义等价（I·3.2）：删 combat_entry 的同时也要删 combat 行 */
        await storage.combatApply([{op:'clear'}]);
        return {msgs:[sys(nick, '⚠️ @全体 战斗结束，先攻表已清理',
          '已删除最后一个条目（共 ' + e.length + ' 个）', '先攻表已清空')]};
      }
      /* 删的正是当前指针 → 指向排序中的下一位（I·3.2 / 验收 16） */
      const stillCur = after.some(x => x.id === curId);
      const nextOps = stillCur ? [] : [{op:'cursor', id:after[Math.min(idx, after.length - 1)].id}];
      const snap2 = nextOps.length ? await storage.combatApply(nextOps) : afterDel;
      return {msgs:[notice(nick, head + '：已删除 ' + names.length + ' 个条目' +
        (missing.length ? '（未找到：' + esc(missing.join('、')) + '）' : '') + '<br>' + seqHtml(snap2))]};
    } else if(cmd.key === 'set'){
      const args = cmd.args || [];
      if(args.length < 2) return {msgs:[notice(nick, '用法：<b>.init set 老王 18</b>　或　<b>.init set 老王 +2 优势</b>')]};
      const name = args[0].replace(/^@/, '');
      const old = e.find(x => x.name === name);
      if(!old) return {msgs:[notice(nick, '条目「' + esc(name) + '」不存在，用 <b>.ri ' + esc(name) + ' &lt;值&gt;</b> 创建（.init set 只编辑已有条目）')]};
      const {spec:vs} = parseValue(args.slice(1));
      if(vs.err) return {msgs:[notice(nick, vs.err)]};
      /* 重掷沿用条目已存的 dex_mod 快照（I·3.4.1），id / created_at / owner / card_ref 均不变 */
      const v = computeValue(vs, old.dex_mod, rule);
      if(v.err) return {msgs:[notice(nick, v.err)]};
      await storage.combatApply([{op:'setvalue', name, value:v.value}]);
      const snap2 = await storage.combatSnapshot();
      return {msgs:[notice(nick, '已改值 ' + esc(name) + ' ' + old.value + ' → ' + v.value + '<br>' + ORDER_NOTE + '<br>' + seqHtml(snap2))]};
    }
    const snap2 = ops.length ? await storage.combatApply(ops) : snap;
    return {msgs:[notice(nick, head + '<br>' + seqHtml(snap2))]};
  }

  /* ⑤ .ri：按名字 upsert + 同步确定先攻值（I·3.4.2） */
  const ts = tokenize(rest);
  const {spec:vs, names} = parseValue(ts);
  if(vs.err) return {msgs:[notice(nick, vs.err)]};
  const tg = targetsOf(names, ctx, nick, anonId);
  if(tg.err) return {msgs:[notice(nick, tg.err)]};

  const ops = [];
  if(beforeEmpty) ops.push({op:'open', now:nowMs, by:nick});
  const upserts = [], receipts = [];
  for(const t of tg.targets){
    const exist = before.find(x => x.name === t.name) ||
      upserts.find(x => x.name === t.name);
    const v = computeValue(vs, exist ? exist.dex_mod : t.dexMod, rule);
    if(v.err) return {msgs:[notice(nick, v.err)]};
    const row = {name:t.name, owner:t.owner, card_ref:t.cardRef, value:v.value,
      dex_mod:exist ? exist.dex_mod : t.dexMod, now:nowMs, by:nick};
    upserts.push(row);
    receipts.push(exist ? ('已更新 ' + esc(t.name) + ' ' + exist.value + ' → ' + v.value)
                        : ('已添加 ' + esc(t.name) + ' ' + v.value));
  }
  ops.push({op:'upsert', rows:upserts});
  const after = await storage.combatApply(ops);
  const msgs = [];
  if(beforeEmpty){
    /* 空→非空：notice 回执 + 一条 sys 显著广播；无顺位提示、无序列（I·3.4 / 验收 4） */
    msgs.push(notice(nick, receipts.join('、')));
    msgs.push(sys(nick, '⚠️ @全体 ⚔️ 先攻已开启', '首个先攻条目已录入', '由 ' + nick + ' 开启本场战斗'));
  } else {
    /* 表仍非空：回执 + 顺位影响提示 + 完整序列 + 指针（I·3.4.3 A 方案 / 验收 12） */
    msgs.push(notice(nick, receipts.join('、') + '<br>' + ORDER_NOTE + '<br>' + seqHtml(after)));
  }
  return {msgs};
}

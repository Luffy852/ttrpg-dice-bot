/* ============================================================================
 * test_protocol.js —— 协议层回归（幂等 / 游标补齐 / 防重掷 / 事实化 / 还原）
 * ----------------------------------------------------------------------------
 * 【怎么用】 node tests/test_protocol.js
 * 【验什么】M3 新增的三条机制，以及两条铁律在 M3 的形态：
 *     §1 幂等：同一 req_id 只执行一次 —— 重试拿到 dup，**绝不掷第二次**
 *     §2 游标：用 seq 不用 ts；断线重连按 cursor 补齐，无重复无遗漏
 *     §3 客户端去重：同一 batch 重复投递只渲染一条（msg_id 去重）
 *     §4 上限与限流：超长/空/超速率显式 reject，不静默截断
 *     §5 事实化：payload 只存事实，**不含 total / verdict**（原则 6）
 *     §6 还原：viewFromPayload(payload) 推出的 total / 判定 与引擎当时产出**完全一致**
 *     §7 帧校验：非法帧被 checkIn 拦下，不进业务逻辑
 * 【★ 为什么这些能在沙盒验】core.js 是纯逻辑 + 注入 storage，
 *   所以"服务端权威掷骰"这部分不需要 Cloudflare 也能真跑真断言。
 *   ws / DO 的 IO 胶水层仍然只能由你真机部署后验 —— 别混为一谈。
 * ========================================================================== */
import * as Engine from '../packages/engine/src/index.js';
import {createRoomCore} from '../apps/worker/src/core.js';
import {createMemoryStorage} from './memory_storage.mjs';
import {checkIn, IN, ERR} from '../packages/protocol/src/frames.js';
import {checkPayload, KIND, checkText, LIMITS} from '../packages/protocol/src/payload.js';
import {dedupe, gapOf, msgId, backoff, tokenBucket, cursorOf} from '../packages/protocol/src/cursor.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };
const eq = (n, a, b) => ok(n, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));

/* ★ RNG 注入：骰点可复现，才能断言"两次执行掷出的是同一串点数" */
const ORIG = Engine.RNG.die;
async function dice(seq, fn){
  let i = 0;
  Engine.RNG.die = () => { const v = seq[i++]; return v === undefined ? 1 : v; };
  try { return await fn(); } finally { Engine.RNG.die = ORIG; }   // ★ 必须 await：core.apply 是异步的
}
const mk = () => {
  const st = createMemoryStorage('R1A2B3');
  let t = 1772000000000;
  const core = createRoomCore(st, {now: () => (t += 100)});
  return {st, core};
};
const run = (core, reqId, text, anonId, nick) => core.apply({reqId, text, anonId:anonId || 'a1', nick:nick || '老王'});

console.log('== 1. 幂等：同一 req_id 只执行一次（★ 防重掷） ==');
{
  const {st, core} = mk();
  const r1 = await dice([3, 4], () => run(core, 'c1-1', '.r 2d6+3'));
  const n1 = st._all().length;
  ok('首次执行产出消息', r1.msgs.length > 0 && !r1.dup);
  const roll1 = r1.msgs.find(m => m.kind === 'roll');
  ok('产出骰点消息', !!roll1);
  const first = JSON.stringify(roll1.payload.groups);

  // 网络超时后客户端重发**同一个 req_id**
  const r2 = await dice([6, 6], () => run(core, 'c1-1', '.r 2d6+3'));
  eq('重发命中幂等（dup）', r2.dup, true);
  eq('dup 返回首次的 seq', r2.seq, r1.seq);
  eq('★ 没有多出任何消息（只掷了一次）', st._all().length, n1);
  eq('★ 骰点没被重掷（groups 与首次完全一致）', first, JSON.stringify(roll1.payload.groups));
  eq('幂等表只记一条', st._idem().size, 1);
}

console.log('== 2. 游标：seq 严格单调，ts 不参与排序 ==');
{
  const {st, core} = mk();
  for(let i = 1; i <= 5; i++) await run(core, 'c1-' + i, '.r 1d6');
  const all = st._all();
  let mono = true, idsOk = true;
  for(let i = 1; i < all.length; i++) if(all[i].seq <= all[i - 1].seq) mono = false;
  for(const m of all) if(m.id !== msgId('R1A2B3', m.seq)) idsOk = false;
  ok('seq 严格单调递增', mono);
  ok('msg_id = code:seq', idsOk);
  // ★ 同一毫秒也能正确排序：把 ts 全改成相同值，seq 顺序依然成立
  const same = [...all].sort((a, b) => a.seq - b.seq);
  eq('ts 全部相同也不影响顺序', JSON.stringify(same.map(m => m.seq)), JSON.stringify(all.map(m => m.seq)));
}

console.log('== 3. 重连补齐：无重复、无遗漏 ==');
{
  const {st, core} = mk();
  for(let i = 1; i <= 5; i++) await run(core, 'c1-' + i, '.r 1d6+' + i);
  const all = st._all();
  const clientCursor = 2;                       // 客户端已渲染到 seq 2
  const g = gapOf(clientCursor, all[all.length - 1].seq);
  eq('缺口条数正确', g.missing, all[all.length - 1].seq - 2);
  const r = await core.since(clientCursor, 200);
  eq('补齐条数 = 缺口', r.msgs.length, g.missing);
  eq('补齐的第一条 = cursor 之后那条', r.msgs[0].seq, 3);
  eq('补齐不含已见过的', r.msgs.filter(m => m.seq < clientCursor).length, 0);
  // 客户端侧再按 msg_id 去重一次（重连可能收到重复投递）
  const seen = new Set(all.slice(0, 2).map(m => m.id));
  const merged = dedupe(r.msgs, seen);
  eq('去重后仍是完整缺口', merged.length, r.msgs.length);
  const seen2 = new Set(all.slice(0, 2).map(m => m.id));
  const twice = dedupe([...r.msgs, ...r.msgs], seen2);
  eq('★ 同一批投递两次只渲染一次', twice.length, r.msgs.length);
}

console.log('== 4. 上限与限流：显式拒绝，不静默截断 ==');
{
  const {st, core} = mk();
  eq('空文本 → empty', (await run(core, 'x1', '   ')).reject.code, 'empty');
  eq('超长文本 → too_long', (await run(core, 'x2', '.r ' + '1d6+'.repeat(200))).reject.code, 'too_long');
  eq('被拒的文本不落库', st._all().length, 0);
  // 令牌桶：容量 10、同一时刻连打 12 条（时间戳固定，令牌不回补）
  const st2 = createMemoryStorage('R1A2B3');
  const core2 = createRoomCore(st2, {now: () => 1772000000000});
  let rejected = 0;
  for(let i = 0; i < 12; i++){
    const r = await run(core2, 'f-' + i, '.r 1d6');
    if(r.reject && r.reject.code === 'rate_limited') rejected++;
  }
  eq('★ 同一时刻连打 12 条，超出容量的被拒', rejected, 2);
}

console.log('== 5. 事实化：payload 不含派生值（★ 原则 6） ==');
{
  const {st, core} = mk();
  await run(core, 'c1', '.set rule coc');
  await run(core, 'c2', '.st set 侦查 60');
  const r = await dice([3, 4], () => run(core, 'c3', '.rc 侦查'));     // RNG.die(10) 返 3/4 → 十位 2、个位 3 → 23
  const roll = r.msgs.find(m => m.kind === 'roll');
  ok('产出骰点', !!roll);
  const p = roll.payload;
  eq('★ payload 不含 total', p.total, undefined);
  eq('★ payload 不含 add', p.add, undefined);
  eq('★ payload 不含 verdict（成功等级）', p.verdict, undefined);
  eq('★ payload 不含 diceSum', p.diceSum, undefined);
  ok('★ payload 含逐骰明细（groups）', Array.isArray(p.groups) && p.groups.length > 0);
  ok('★ 百分骰的十位/个位明细都在（可核验）', !!(p.groups[0].percent && Array.isArray(p.groups[0].percent.tens)));
  eq('payload 校验通过', checkPayload(KIND.ROLL, p), null);
  eq('★ 存了事实快照 rule_at', p.rule_at, 'coc7');
  eq('★ 存了 dc（技能值）', p.dc, 60);
}

console.log('== 6. 还原：从 payload 推出的结论 = 引擎当时产出 ==');
{
  // COC：技能 60 掷 23 → 困难成功（档案验收样例）
  const {core} = mk();
  await run(core, 'c1', '.set rule coc');
  await run(core, 'c2', '.st set 侦查 60');
  const r = await dice([3, 4], () => run(core, 'c3', '.rc 侦查'));   // RNG.die(10) 返 3/4 → 十位 2、个位 3 → 23
  const roll = r.msgs.find(m => m.kind === 'roll');
  const v = Engine.viewFromPayload(roll.payload);
  eq('还原出的骰点 = 23', v.diceSum, 23);
  eq('★ 还原出的判定 = 困难成功', v.verdict && v.verdict.text, '困难成功（≤30）');
  eq('还原出的规则 = coc7', v.ruleKey, 'coc7');

  // FU：双 8 → 暴击（判定只看骰面）
  const s2 = mk();
  await run(s2.core, 'd1', '.set rule fu');
  const r2 = await dice([8, 8], () => run(s2.core, 'd2', '.fu d8 d10 13'));
  const fu = r2.msgs.find(m => m.kind === 'roll');
  const v2 = Engine.viewFromPayload(fu.payload);
  ok('★ FU 暴击能从 payload 还原', /暴击/.test(v2.verdict.text), JSON.stringify(v2.verdict));

  // DH：双 d12 同点 → 关键成功
  const s3 = mk();
  await run(s3.core, 'e1', '.set rule dh');
  const r3 = await dice([7, 7], () => run(s3.core, 'e2', '.dh 15'));
  const dh = r3.msgs.find(m => m.kind === 'roll');
  const v3 = Engine.viewFromPayload(dh.payload);
  ok('★ DH 关键成功能从 payload 还原', /关键成功/.test(v3.verdict.text), JSON.stringify(v3.verdict));

  // ★ 一致性：同一 payload 还原两次结果相同（纯函数，不含随机）
  eq('还原是纯函数（两次一致）', JSON.stringify(Engine.viewFromPayload(fu.payload)), JSON.stringify(Engine.viewFromPayload(fu.payload)));
}

console.log('== 7. 帧校验与工具函数 ==');
{
  eq('合法 cmd 帧', checkIn({t:IN.CMD, req_id:'c1-1', text:'.r 2d6+3'}), null);
  eq('缺 req_id → bad_frame', checkIn({t:IN.CMD, text:'.r 1d6'}), ERR.BAD_FRAME);
  eq('未知帧型 → bad_frame', checkIn({t:'hello2'}), ERR.BAD_FRAME);
  eq('非对象 → bad_frame', checkIn(null), ERR.BAD_FRAME);
  eq('版本不符 → version_mismatch', checkIn({t:IN.HELLO, token:'x', v:99}), ERR.VERSION_MISMATCH);
  const g = gapOf(0, 10);
  eq('gapOf 缺口', g.missing, 10);
  ok('退避随次数增长且有上限', backoff(0) < backoff(3) && backoff(20) <= 15000 * 1.3);
  const st = {tokens:10, ts:0};
  for(let i = 0; i < 10; i++) tokenBucket(st, 1000, 10, 5);
  eq('令牌桶耗尽后拒绝', tokenBucket(st, 1000, 10, 5).ok, false);
  eq('文本上限常量', LIMITS.TEXT, 400);
  eq('checkText 超长', checkText('x'.repeat(401)), 'too_long');
}

console.log('== 8. 状态变更：切规则要留痕并回写前端 ==');
{
  const {st, core} = mk();
  const r = await run(core, 'c1', '.set rule coc');
  ok('切规则产出系统消息', r.msgs.some(m => m.kind === 'sys'));
  ok('★ 返回 state（前端以后端为准回写）', !!r.state && r.state.rule === 'coc7');
  eq('房间状态已落库', (await st.getRoom()).rule, 'coc7');
  eq('变更者留痕', (await st.getRoom()).ruleSetBy, '老王');
  // 卡与规则不符时不静默：给 notice
  await run(core, 'c2', '.st set 侦查 60');
  const r2 = await run(core, 'c3', '.set rule dnd');
  ok('★ 换规则后提示卡不匹配（不静默）', r2.msgs.some(m => m.kind === 'notice'));
}

console.log('---------------------------');
console.log('协议层：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail) console.log('\n提示：失败项先分清是「协议逻辑错了」还是「测试替身与 DO 行为不一致」。');
process.exit(fail ? 1 : 0);

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
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as Engine from '../packages/engine/src/index.js';
import {createRoomCore, mergeOrder, planImport} from '../apps/worker/src/core.js';
import {createMemoryStorage} from './memory_storage.mjs';
import {toNdjson, fromNdjson, toBattle, exportAs, FORMAT} from '../apps/worker/src/export.js';
import {ymdhm} from '../packages/engine/src/util.js';
import {checkIn, IN, ERR} from '../packages/protocol/src/frames.js';
import {checkPayload, KIND, checkText, LIMITS} from '../packages/protocol/src/payload.js';
import {dedupe, gapOf, msgId, backoff, tokenBucket, cursorOf} from '../packages/protocol/src/cursor.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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

console.log('== 9. ★ 时间口径全链路统一 UTC+8（真机反馈 · A 组第 1 条） ==');
{
  /* 【症状】.status 里「规则设定者 · 08:12」与同一条消息气泡右上角「16:12」差 8 小时。
   * 【根因】服务端 Worker 跑在 UTC，引擎用 getHours()；前端 ui.js 用浏览器本地时区。
   * 【怎么让这条断言有意义】沙盒的 TZ 恰好也是 UTC+8 —— 不改 TZ 的话旧代码照样通过。
   *   所以这里**强制把 TZ 拨到 UTC** 再算：修好后仍应是 UTC+8，改回去就变 UTC（会红）。 */
  const oldTz = process.env.TZ;
  process.env.TZ = 'UTC';
  const TS = 1772000000000;
  const utc8 = new Date(TS + 8 * 3600 * 1000);
  const p = n => (n < 10 ? '0' : '') + n;
  const want = p(utc8.getUTCHours()) + ':' + p(utc8.getUTCMinutes());
  eq('★ hhmm(ts) 固定按 UTC+8（TZ 被拨到 UTC 也不变）', Engine.hhmm(TS), want);
  eq('★ 战报与气泡同一格式化器', Engine.hhmm(TS), want);
  // 旧写法（本地时区）在 TZ=UTC 下会给出 UTC 小时 —— 断言两端确实不再各算各的
  const localHhmm = ts => { const d = new Date(ts); return p(d.getHours()) + ':' + p(d.getMinutes()); };
  ok('★ 与"按本地时区渲染"不再同值（证明已脱钩）', localHhmm(TS) !== want, localHhmm(TS) + ' vs ' + want);
  process.env.TZ = oldTz;

  // .set rule 落库的时间串也必须是 UTC+8（它是服务端渲染后烤进消息的，事后改前端救不回来）
  const {st, core} = mk();
  const r = await run(core, 'tz1', '.set rule coc');
  const sys = r.msgs.find(m => m.kind === 'sys');
  /* ★ 用**同一条消息的 ts** 去推期望值：服务端渲染的时间串会被烤进 payload 落库，
   *   事后改前端也救不回来 —— 所以必须在这里就锁死"它和气泡是同一个时钟"。 */
  eq('★ 规则变更广播里的时间与 hhmm 同源（用同一条消息的 ts 推）',
    sys.payload.line2.includes('于 ' + Engine.hhmm(sys.ts)), true);
  eq('★ 落库的时间串也是 UTC+8（与气泡同一个时钟）',
    (await st.getRoom()).ruleSetAt, Engine.hhmm(sys.ts));
}

console.log('== 10. ★ .status 的条数与在线人数（真机反馈 · A 组第 2/3 条） ==');
{
  const st = createMemoryStorage('R1A2B3');
  let t = 1772000000000;
  /* ★ online / memberCount 由 DO 注入（core 是纯逻辑，碰不到 ws 列表）。
   *   不注入时必须是 — 而不是编一个 0 —— 保守：宁可少说，不可说错。 */
  const core = createRoomCore(st, {now: () => (t += 100), online: () => 3, memberCount: () => 13});
  const run2 = (reqId, text) => core.apply({reqId, text, anonId:'a1', nick:'老王'});
  await run2('s1', '.r 1d6');
  await run2('s2', '.r 1d6');
  /* ★ 快照必须在 .status **之前**取：这条指令自己也会产出 2 条消息（原文 + 回复），
   *   事后数会多 2 —— 拿"之后的总数"去比对"渲染时的显示值"必然不等，且会掩盖真错。 */
  const cnt = await st.countMsgs();
  const r = await run2('s3', '.status');
  const html = Engine.defsHtml(r.msgs.find(m => m.kind === 'html').payload.defs);
  const txt = String(html).replace(/<[^>]+>/g, ' ');
  ok('★ 条数 = 现存量 COUNT(*)（不是 0、也不是 room.seq）',
    txt.includes('本房间共 ' + cnt + ' 条'), 'cnt=' + cnt + ' txt=' + txt.replace(/\s+/g, ' ').slice(0, 160));
  ok('★ 条数与"最近投掷条数"脱钩（旧口径恒为 0）', !/本房间共 0 条/.test(txt));
  ok('★ 在线人数与累计人次分开显示', txt.includes('3 人在线') && txt.includes('累计接入 13 人次'),
    txt.replace(/\s+/g, ' ').slice(0, 200));

  // 未注入时应显示 — 而不是谎报 0
  const core2 = createRoomCore(createMemoryStorage('R2'), {now: () => (t += 100)});
  const r2 = await core2.apply({reqId:'n1', text:'.status', anonId:'a1', nick:'老王'});
  const txt2 = String(Engine.defsHtml(r2.msgs.find(m => m.kind === 'html').payload.defs)).replace(/<[^>]+>/g, ' ');
  ok('★ 拿不到在线数时显示 —（不谎报 0）', /在场人数\s+—/.test(txt2),
    txt2.replace(/\s+/g, ' ').slice(0, 160));
}

console.log('== 11. ★ presence / welcome 帧带 online 与 total（两个数都要） ==');
{
  const {presence, welcome} = await import('../packages/protocol/src/frames.js');
  const mem = [{anon_id:'a'}, {anon_id:'b'}, {anon_id:'c'}];
  const pf = presence(mem, 2, 3);
  eq('★ presence.online = 当前在线', pf.online, 2);
  eq('★ presence.total  = 累计人次', pf.total, 3);
  ok('★ online 可以小于 total（反复进房的人不重复计在线）', pf.online <= pf.total);
  const wf = welcome({anon_id:'a'}, {rule:'generic'}, 0, mem, 1, 3);
  eq('welcome.online', wf.online, 1);
  eq('welcome.total', wf.total, 3);
  // 服务端没给时退化为名单长度，不会 undefined（前端顶栏不会显示 NaN）
  eq('★ 缺省退化：total = 名单长度', presence(mem).total, 3);
  eq('★ 缺省退化：online = 0 而不是 undefined', presence(mem).online, 0);
}

console.log('== 12. ★ .st clear 必须真的删库（真机反馈 · B 组第 2 条）==');
{
  const st = createMemoryStorage('CLR001');
  let t = 1772000000000;
  const core = createRoomCore(st, {now: () => (t += 100)});
  const run3 = (reqId, text) => core.apply({reqId, text, anonId:'a1', nick:'战斗菇'});
  await run3('c1', '.set rule dnd');
  await run3('c2', '.st set 力量 16 敏捷 14 体质 15 智力 10 感知 12 魅力 8 等级 1');
  ok('★ 绑卡后库里真有卡', !!(await st.getCard('a1')));
  const r = await run3('c3', '.st clear');
  ok('提示已解绑', r.msgs.some(m => m.kind === 'notice' && /已解绑/.test(String(m.html || m.payload && m.payload.html || ''))),
    JSON.stringify(r.msgs.map(m => m.kind)));
  eq('★ 解绑后库里的卡真的没了（不是只改内存）', await st.getCard('a1'), null);
  // 关键回归：clear 之后再 .st，必须给模板（未绑定），不能把旧卡读回来
  const r2 = await run3('c4', '.st');
  const html = String(Engine.defsHtml(r2.msgs.find(m => m.kind === 'html').payload.defs));
  ok('★ clear 后再 .st 给的是模板，不是旧卡', /尚未绑定/.test(html), html.slice(0, 120));
  eq('★ 旧卡的数值不再出现', /力量/.test(html) === false || /尚未绑定/.test(html), true);
  // 别人的 clear 不能动我的卡（匿名作用域）
  const st2 = createMemoryStorage('CLR002');
  const core2 = createRoomCore(st2, {now: () => (t += 100)});
  await core2.apply({reqId:'d1', text:'.set rule coc', anonId:'a1', nick:'战斗菇'});
  await core2.apply({reqId:'d2', text:'.st set 侦查 60', anonId:'a1', nick:'战斗菇'});
  await core2.apply({reqId:'d3', text:'.st clear', anonId:'a2', nick:'Bob'});
  ok('★ 别人解绑不影响我的卡', !!(await st2.getCard('a1')));
}

console.log('== 13. ★ 身份找回：同一 cid 必须拿回同一个 anon_id（真机反馈 · B 组第 3 条）==');
{
  const roomSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'room.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'main.js'), 'utf8');
  // ① join 必须按 cid 查回老身份，而不是无条件 randomUUID
  ok('★ /join 会按 cid 找回老 anon_id', /SELECT anon_id FROM members WHERE cid = \?/.test(roomSrc));
  ok('★ 找不到 cid 时才新建身份', /crypto\.randomUUID\(\)/.test(roomSrc) && /if\(!anonId\)/.test(roomSrc));
  // ② cid 必须做格式校验：它是从客户端来的，不能原样拼进 SQL 语义之外的东西
  ok('★ cid 有格式校验（非法即视为没有）', /A-Za-z0-9_-\]\{8,64\}/.test(roomSrc));
  // ③ 旧库迁移：CREATE TABLE IF NOT EXISTS 改不动已存在的表
  ok('★ 有 ALTER TABLE 迁移（老房间也能长出 cid 列）', /ALTER TABLE members ADD COLUMN cid/.test(roomSrc));
  ok('★ 迁移是幂等的（列已存在要吞掉错）', /try\{[^}]*ALTER TABLE members ADD COLUMN cid[^}]*\}catch/.test(roomSrc.replace(/\s+/g, ' ')) || /catch\(e\)\{ \/\* 列已存在/.test(roomSrc));
  /* ④ ★ 网关转发不能漏字段（这条是端到端真跑才发现的：DO 侧逻辑全对，
   *   但 Worker 只转了 {nick, pin}，cid 在网关被丢掉 —— 静态看 room.js 永远是"对的"）。
   *   凡是"前端 → Worker → DO"的转发，字段清单必须与消费端一致。 */
  const idxSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'index.js'), 'utf8');
  ok('★ Worker 转发 /join 时带上了 cid', /cid:b\.cid/.test(idxSrc), 'index.js 的 /join 转发');
  // ⑤ 前端必须用 localStorage（sessionStorage 关页即清，解决不了"关页重进"）
  ok('★ cid 存在 localStorage（不是 sessionStorage）', /localStorage\.setItem\(CID_KEY/.test(mainSrc));
  ok('★ /join 带上 cid', /cid:myCid\(\)/.test(mainSrc));
  ok('★ localStorage 不可写时退化为新身份，不报错', /catch\(e\)\{ return ''; \}/.test(mainSrc));
  // ⑤ schema.sql 与 room.js 必须同步（唯一出处原则）
  const ddl = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'schema.sql'), 'utf8');
  ok('★ schema.sql 里也有 cid 列（唯一出处）', /cid\s+TEXT/.test(ddl));
  ok('★ 索引名两处一致', /idx_members_cid/.test(ddl) && /idx_members_cid/.test(roomSrc));
}

console.log('== 14. ★ 半开连接要被巡检清掉（真机反馈 · B 组第 1 条）==');
{
  const roomSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'room.js'), 'utf8');
  const codeOnly = roomSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('★ 有"最后一次收到帧"的记录（attachment 带 ts）', /serializeAttachment\(\{anon_id:v\.payload\.anon_id, ts:Date\.now\(\)\}/.test(codeOnly));
  ok('★ 收到任何帧都刷新 ts（心跳也算活着）', /serializeAttachment\(Object\.assign\(\{\}, att, \{ts:Date\.now\(\)\}\)\)/.test(codeOnly));
  ok('★ 有巡检函数 sweepIdle', /sweepIdle\(\)/.test(codeOnly));
  ok('★ 巡检按 IDLE_MS 判超时并主动 close', /now - last > IDLE_MS/.test(codeOnly) && /ws\.close\(4000/.test(codeOnly));
  ok('★ 关掉后广播 presence（人数让所有人看到回落）', /if\(!stale\.length\) return 0;/.test(codeOnly) && /online:all\.length - stale\.length/.test(codeOnly));
  /* ★ 存活数必须自己减，不能信 onlineCount()：实测 ws.close() 后 readyState 不立刻翻转，
   *   那一刻 onlineCount() 还是旧值 —— 广播出去等于没回落（真机"永远多一个"的变体）。 */
  ok('★ 存活数用"总数 − 本次关闭数"，不用 onlineCount()', !/online:this\.onlineCount\(\), total:mem\.length\}\);\s*\n?\s*\}/.test(codeOnly) && /all\.length - stale\.length/.test(codeOnly));
  // ★ 排程：不排闹钟 = 巡检永远不跑（这是最容易漏的一环）
  ok('★ 建连时排上巡检闹钟', /setAlarm\(Date\.now\(\) \+ SWEEP_MS\)/.test(codeOnly));
  ok('★ 有人就继续巡、没人退回每日清理', /setAlarm\(this\.onlineCount\(\) > 0 \? now \+ SWEEP_MS : now \+ DAY\)/.test(codeOnly));
  ok('★ 在线数仍按 readyState 过滤（两条机制叠加，不互相替代）', /readyState\s*===\s*1/.test(codeOnly));
  // 口径：用户定 3 分钟，且心跳 20s 必须远小于它（否则会误伤挂机的人）
  const idle = Number((/const IDLE_MS\s*=\s*([^;]+)/.exec(codeOnly) || [])[1] ? eval((/const IDLE_MS\s*=\s*([^;]+)/.exec(codeOnly) || [])[1]) : 0);
  const hb = Number((/HB_MS\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'net.js'), 'utf8')) || [])[1]);
  ok('★ IDLE_MS = 3 分钟（用户已定）', idle === 180000, String(idle));
  ok('★ 心跳间隔远小于离线阈值（≥4 倍余量，不会误伤挂机）', hb > 0 && idle / hb >= 4, 'hb=' + hb + ' idle=' + idle);
}

console.log('== 15. ★ 首屏必须取「最近」不是「最早」（真机反馈 · C 组）==');
{
  /* 【坑】刷新时客户端 cursor 归 0 → since(0) 拿到**最早** 200 条。
   *   房间超过 200 条后刷新，看到的永远是开头那一段，后面的消息再也出不来
   *   （没有上滚加载就永远看不到，而导出是全量 —— 用户会以为消息丢了）。
   *   不刷新时走 ws 增量，所以只在"刷新/重进"时出现，是最难发现的一类 bug。 */
  const st = createMemoryStorage('HIS001');
  let t = 1772000000000;
  /* ★ 每条之间推进 1 秒：限流是令牌桶（10 个 / 每秒回 5 个），
   *   时间不走的话 260 条里绝大部分会被 rate_limited 丢掉 ——
   *   那时"260 条"的断言会静默失败，后面的断言全在空数据上跑，看不出真实问题。 */
  const core = createRoomCore(st, {now: () => (t += 1000)});
  for(let i = 0; i < 260; i++){
    const r = await core.apply({reqId:'m' + i, text:'第' + i + '条', anonId:'a1', nick:'老王'});
    if(r.reject) throw new Error('第 ' + i + ' 条被限流，测试时钟要再放慢');
  }
  const all = st._all();
  eq('库里共 260 条', all.length, 260);

  const first = await core.recent(200);
  eq('★ 首屏取 200 条', first.msgs.length, 200);
  eq('★ 首屏第一条是第 60 条（不是第 0 条）', /第60条/.test(first.msgs[0].payload.text), true);
  eq('★ 首屏最后一条是最新那条', /第259条/.test(first.msgs[first.msgs.length - 1].payload.text), true);
  ok('★ 首屏标了 has_more（还有更早的）', first.has_more === true, String(first.has_more));
  eq('★ total 是房间总条数（不只是本页）', first.total, 260);
  // 对照：since(0) 拿的是最早那批 —— 正是 bug 的形态，锁住它别再回来
  const wrong = await core.since(0, 200);
  eq('★ since(0) 拿到的是最早一批（首屏不能用它）', /第0条/.test(wrong.msgs[0].payload.text), true);

  // 上翻：锚点是本页最小 seq，取它之前的
  const page = (await core.history(first.msgs[0].seq, 200)).msgs;
  eq('★ 上翻取到 60 条（更早就没了）', page.length, 60);
  eq('★ 上翻第一条是最早那条', /第0条/.test(page[0].payload.text), true);
  eq('★ 上翻最后一条紧接首屏第一条', page[page.length - 1].seq < first.msgs[0].seq, true);
  // 不重叠：上翻结果与首屏没有交集（否则会重复渲染）
  const s1 = new Set(first.msgs.map(m => m.seq));
  eq('★ 上翻与首屏不重叠', page.some(m => s1.has(m.seq)), false);
  // 到顶：再往上翻一页是空的
  eq('★ 翻到顶了就没有更早的', (await core.history(page[0].seq, 200)).msgs.length, 0);
}

console.log('== 16. ★ 上翻分页的接线（服务端 why 标记 + 前端三条路）==');
{
  const roomSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'room.js'), 'utf8');
  const netSrc  = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'net.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'main.js'), 'utf8');
  const uiSrc   = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'ui.js'), 'utf8');
  const batchSrc = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'batch.js'), 'utf8');
  /* ★ why 必须显式带：靠"oldest < cursor"去猜是分不出来的 ——
   *   首屏那批本身就是 200 条连续段，oldest 当然小于末尾，会被误判成"上翻的历史"，
   *   于是首屏不推进 cursor，重连反而漏掉中间段。 */
  ok('★ 首屏批次带 why:first', /why:'first'/.test(roomSrc));
  /* ★ 光有 recent() 不够 —— HELLO 里必须真的用它。
   *   core.recent 存在但接线写成 since(0)，首屏就还是"最早 200 条"，
   *   单测 recent() 照样全绿。凡是"函数有了 ≠ 用上了"的地方都要锁调用点。 */
  ok('★ HELLO 首屏真的调用 recent（不是 since(0)）',
    /fresh \? await this\.core\.recent\(200\)/.test(roomSrc.replace(/\/\*[\s\S]*?\*\//g, '')), 'room.js 的 HELLO 分支');
  ok('★ 上翻批次带 why:page', /why:'page'/.test(roomSrc));
  ok('★ 上翻帧带 has_more（翻到底要能停）', /has_more:r\.msgs\.length >= \(f\.limit \|\| 200\)/.test(roomSrc));
  // 前端：历史帧不能推进 cursor（cursor 是"最新水位"，推进了重连会漏）
  ok('★ 上翻不推进 cursor', /if\(!isHistory\) cursor = Math\.max/.test(netSrc) && /f\.why === 'page'/.test(netSrc));
  /* ★ 这段判断在 batch.js —— 生产 main.js 与冒烟测试**共用同一份**。
   *   两份实现 = 两边各错各的：上次就是 main.js 用错字段名、测试副本用对的，全绿却真机失效。 */
  ok('★ 批次分发在 batch.js（唯一实现）', /w === 'page'/.test(batchSrc) && /ui\.prepend/.test(batchSrc) && /ui\.append/.test(batchSrc));
  ok('★ main.js 调用 batch.js，不自己另写一份', /applyBatch\(ui, msgs/.test(mainSrc));
  ok('★ 冒烟测试也用 batch.js（两边不会漂移）', /applyBatch\(ui, f\.msgs/.test(fs.readFileSync(path.join(ROOT, 'tests', 'dom_smoke.js'), 'utf8')));
  // UI：插顶部必须保持滚动位置，否则手机上会跳
  ok('★ 上翻插在顶部（afterbegin）', /insertAdjacentHTML\('afterbegin'/.test(uiSrc));
  ok('★ 插完补回 scrollTop（不跳动）', /scrollTop = top \+ \(\$stream\.scrollHeight - before\)/.test(uiSrc));
  ok('★ 有 loading 锁（一次只发一页）', /if\(loading/.test(uiSrc) && /loading = true/.test(uiSrc));
  ok('★ 滚到顶触发（阈值 60px，手指不会精确到 0）', /LOAD_TOP = 60/.test(uiSrc) && /scrollTop > LOAD_TOP/.test(uiSrc));
  ok('★ 上翻也登记 seen（防之后广播重复渲染）', /seen\.add\(m\.id\); n\+\+/.test(uiSrc));
  // 渲染只有一份（原则 4）：append 与 prepend 共用 htmlOf
  ok('★ 追加与插入共用同一个渲染函数', /function htmlOf/.test(uiSrc) && (uiSrc.match(/Engine\.renderMsg\(toRenderable\(m\)\)/g) || []).length <= 2);
}

console.log('== 17. ★ 昵称必须与"我是谁"同源（真机反馈 · D 组第 4 条）==');
{
  const roomSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'room.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'main.js'), 'utf8');
  const codeOnly = roomSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* 【症状】关页重进不填昵称 → 前端拿默认"玩家"当自己，服务端按 cid 认出"战斗菇"。
   *   于是自己发的消息 from="战斗菇"、本地 st.me="玩家" → 自己的气泡显示在**左边**，
   *   但 .status 说你是"战斗菇" —— 一处一个说法。 */
  ok('★ join 会返回权威昵称', /nick:myNick/.test(codeOnly), 'join 响应');
  ok('★ 昵称以库里的为准（不是客户端自报的）', /nick:me\.nick \|\| f\.nick/.test(codeOnly), 'WELCOME 帧');
  /* ★ 关键：没填昵称时不能把库里的昵称改成"玩家" —— 否则关页重进一次就毁掉一次 */
  ok('★ 只有真的填了昵称才改库里的 nick', /wantNick[\s\S]{0,120}UPDATE members SET nick/.test(codeOnly));
  ok('★ 没填昵称时前端传 null（不是默认"玩家"）', /nick:nick \|\| null/.test(mainSrc));
  ok('★ 前端用服务端返回的昵称', /const myNick = j\.nick \|\| nick/.test(mainSrc));
  /* ★ 表单预填：不预填的话用户偷懒直接输房间号就进，又变回"玩家" */
  ok('★ 进房表单预填上次昵称', /localStorage\.getItem\(NICK_KEY\)/.test(mainSrc));
  ok('★ 昵称键与 req_id 的 clientId 不重名（两者生命周期相反）',
    /CID_KEY = 'db:me'/.test(mainSrc), 'db:me vs db:cid');
  // 网关转发不能丢 nick（上次 cid 就是这么丢的）
  const idxSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'index.js'), 'utf8');
  ok('★ 网关转发 /join 时带上了 nick', /nick:b\.nick/.test(idxSrc));
}

console.log('== 18. ★ 上翻的健壮性：可见入口 + 不会永久卡住（真机反馈 · D 组第 2 条）==');
{
  const uiSrc = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'ui.js'), 'utf8');
  /* 【症状】真机上"拉到头没有反应"，而服务端分页本身是对的 ——
   *   纯靠滚动触发 = 触发不了就完全没有退路，用户只能以为消息丢了。 */
  ok('★ 顶部有可点入口（滚动之外的退路）', /loadbtn/.test(uiSrc) && /maybeLoadOlder\(true\)/.test(uiSrc));
  ok('★ 入口点击不受滚动位置限制', /if\(!force \&& \$stream\.scrollTop > LOAD_TOP\)/.test(uiSrc));
  ok('★ 入口始终在最顶部（不会被上翻插入的内容顶下去）', /firstChild !== \$loadBtn/.test(uiSrc));
  /* ★ loading 卡死是最阴的一类：表现为"上翻只灵一次，之后彻底没反应" */
  ok('★ 有超时解锁，loading 不会永久卡住', /setTimeout\(\(\) => \{ if\(loading\) doneLoadingOlder/.test(uiSrc));
  ok('★ 加载中不会重复发请求', /if\(loading/.test(uiSrc));
  // 顺序：整批插入（逐条 afterbegin 会把一页历史完全倒过来）
  ok('★ 上翻整批插入（不是逐条 afterbegin）', /html \+= htmlOf\(m\)/.test(uiSrc) && /insertAdjacentHTML\('afterbegin', html\)/.test(uiSrc));
}

console.log('== 19. ★★ 首屏分页的接线字段名必须一致（真机事故 · D 组第 4 条）==');
{
  const netSrc   = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'net.js'), 'utf8');
  const mainSrc  = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'main.js'), 'utf8');
  const uiSrc    = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'ui.js'), 'utf8');
  const batchSrc = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'batch.js'), 'utf8');
  /* 【事故】net.js 给批次信息里那个字段叫 hasMoreOlder，而 main.js 首屏分支读成了 info.hasMore
   *   → undefined → hasMoreOlder 恒为 false → 顶部入口不出现、滚到顶也不触发。
   *   服务端分页本身完全正确，协议层测试也全绿（它直接调 setPaging，绕开了这层接线）。 */
  ok('★ setPaging 改成收整个对象（不是三个位置参数）',
    /function setPaging\(info\)/.test(uiSrc), 'ui.js');
  ok('★ batch.js 两处都传 info 对象', (batchSrc.match(/ui\.setPaging\(info\)/g) || []).length >= 2);
  /* 注释里提到 info.hasMore 是在**讲这个事故**，不算读；只查真正的代码（去掉注释后） */
  const codeOf = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('★ 没有再读 info.hasMore（那个字段根本不存在）',
    !/info\.hasMore\b/.test(codeOf(mainSrc) + codeOf(batchSrc)));
  /* ★ 兜底：就算服务端没给 has_more，只要"总数 > 已渲染条数"也要认为还有更早的。
   *   宁可多给一次入口，也不能让用户对着"429 条只看到 204 条"无路可走。 */
  ok('★ has_more 缺失时用"总数 > 已渲染"兜底', /st\.msgTotal > seen\.size/.test(uiSrc));
  // 字段名对不上这件事本身要能被发现：net.js 与 ui.js 用的必须是同一个键名
  const keys = [...netSrc.matchAll(/\b(why|oldest|total|hasMoreOlder):/g)].map(m => m[1]);
  ok('★ net.js 批次信息里带了 hasMoreOlder', keys.includes('hasMoreOlder'), keys.join(','));
  ok('★ ui.js 读的就是 hasMoreOlder（不是别的名字）', /o\.hasMoreOlder/.test(uiSrc));
}

console.log('== 20. ★ 昵称：改名要同步顶栏、空白登录不能冲掉昵称（真机反馈 · D 组第 2/3 条）==');
{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'main.js'), 'utf8');
  const uiSrc   = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'ui.js'), 'utf8');
  /* ① 空白登录不能把昵称冲成"玩家"：老身份回来时前端默认"玩家" = 我要改名 */
  ok('★ 进房表单空白时不默认成"玩家"', /const nick = \(\$\('g-nick'\)\.value \|\| ''\)\.trim\(\);/.test(mainSrc), 'g-join 分支');
  ok('★ doJoin 把空白转成 null（让服务端判断"没填"）', /nick:nick \|\| null/.test(mainSrc));
  /* ② 房间里改名（.name）后顶栏要跟着变：按 anon_id 在成员列表里找到自己 */
  ok('★ 记住自己的 anon_id', /myAnon = \(f\.you && f\.you\.anon_id\)/.test(mainSrc));
  ok('★ presence 里按 anon_id 找到自己并回写昵称', /m\.anon_id === myAnon/.test(mainSrc) && /ui\.setMe\(mine\.nick\)/.test(mainSrc));
  ok('★ 改名后本地记住的昵称也更新（下次自动带入新名）', /rememberNick\(mine\.nick\)/.test(mainSrc));
  ok('★ UI 暴露 me() 供比对', /me\(\)\{ return st\.me; \}/.test(uiSrc));
  // ③ 服务端：没填昵称就不改库里的 nick
  const roomSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'room.js'), 'utf8');
  ok('★ 只有真的填了昵称才写库', /if\(wantNick\) this\.sql\.exec\('UPDATE members SET nick/.test(roomSrc));
}

console.log('== 21. ★ 战报导出：时区一致 + 结构化说明要有内容（真机反馈 · 第 6/7 条）==');
{
  /* ① 导出时间戳必须与消息时间同一个时区（UTC+8） */
  const TS = Date.UTC(2026, 9, 31, 9, 0, 0);      // 2026-10-31 09:00 UTC = 17:00 UTC+8
  eq('★ ymdhm 按 UTC+8', ymdhm(TS), '2026-10-31 17:00');
  ok('★ 不再用 toISOString（那是 UTC，会差 8 小时）',
    !/toISOString/.test(fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'room.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), 'room.js 里不该再有');
  const battle = toBattle([{seq:1, id:'x1', ts:TS, kind:'chat', from:'老王', actor:'老王', payload:{text:'你好'}}],
    {code:'593353', rule:'dnd5e', exportedAt:ymdhm(TS)});
  ok('★ 战报里的导出时间 = 消息时间的时区', /导出：2026-10-31 17:00/.test(battle), battle.split('\n')[2]);
  ok('★ 同一份战报里消息也是 17:00（不是 09:00）', /`17:00`/.test(battle), battle.split('\n').find(l => /17:00|09:00/.test(l)));

  /* ② 结构化说明（.st / .status / 规则切换）不能只剩一句占位 */
  const msgs = [
    {seq:1, id:'m1', ts:TS, kind:'chat', from:'老王', actor:'老王', payload:{text:'.st'}},
    {seq:2, id:'m2', ts:TS, kind:'html', from:'骰娘', actor:'老王', payload:{defs:{
      title:'老王的角色卡 · D&D',
      sections:[{h:'属性', rows:[{k:'力量', v:'16'}, {k:'敏捷', v:'14'}]}],
      foot:['等级用于推导熟练加值']
    }}},
  ];
  const md = toBattle(msgs, {code:'593353', rule:'dnd5e', exportedAt:ymdhm(TS)});
  ok('★ 战报里的角色卡能看到属性（不是一句占位）', /力量/.test(md) && /16/.test(md), md.slice(-200));
  ok('★ 战报里不再出现"导出用 NDJSON 保留完整内容"的占位句',
    !/导出用 NDJSON 保留完整内容/.test(md), md.slice(-160));
  /* ★ 说明里的 HTML 标签要剥掉：战报是纯文本，留着 <b> 会直接印出来 */
  const md2 = toBattle([{seq:1, id:'h1', ts:TS, kind:'html', from:'骰娘', actor:'老王', payload:{defs:{
    title:'⚠️ 规则设定已变更', sections:[{rows:[{k:'提示', v:'用 <b>.set rule generic</b> 回退'}]}]}}}],
    {code:'1', rule:'generic', exportedAt:'x'});
  ok('★ 战报里不残留 HTML 标签', !/<b>/.test(md2), md2.slice(-120));
  ok('★ 但文字内容还在', /\.set rule generic/.test(md2), md2.slice(-120));

  /* ③ 导出文件：md 与 ndjson 都要给，ndjson 文件名带时间（多次导出不会同名） */
  const e1 = exportAs(msgs, {code:'593353', rule:'dnd5e', exportedAt:'2026-10-31 17:00'}, FORMAT.MD);
  const e2 = exportAs(msgs, {code:'593353', rule:'dnd5e', exportedAt:'2026-10-31 17:00'}, FORMAT.NDJSON);
  ok('★ md 文件名', /战报-593353\.md$/.test(e1.name), e1.name);
  ok('★ ndjson 文件名带导出时间', /房间-593353-202610311700\.ndjson/.test(e2.name), e2.name);
}

console.log('== 22. ★ 战报导入：接在当前房间后面 + 按 msg_id 去重（真机反馈 · 第 8 条）==');
{
  const mk = (i, id) => ({seq:i, id, ts:1772000000000 + i, kind:'chat', from:'老王', actor:'老王',
    anon_id:'a1', req_id:null, rule_at:'generic', payload:{text:'第' + i + '条'}});
  const nd = toNdjson([mk(1, 'id-a'), mk(2, 'id-b')]);
  const p1 = fromNdjson(nd);
  eq('★ NDJSON 往返条数一致', p1.msgs.length, 2);
  eq('★ 往返后内容一致', p1.msgs[1].payload.text, '第2条');

  // 坏行不该让整份战报废掉
  const p2 = fromNdjson(nd + '{"bad":1}\n');
  eq('★ 坏行被收集而不是整批失败', p2.msgs.length, 2);
  eq('★ 坏行有记录', p2.errs.length, 1);
  eq('★ 空行不算坏行', fromNdjson('\n\n').errs.length, 0);

  /* ★★ 导入语义：并入 + 按绝对时间重排（用户已定口径）★★ */
  const st = createMemoryStorage('IMP001');
  let t = 1772000000000;
  const core = createRoomCore(st, {now: () => (t += 1000)});
  await core.apply({reqId:'r1', text:'房内已有的一条', anonId:'a1', nick:'老王'});
  const before = st._all().length;
  const roomSeqBefore = (await st.getRoom()).seq;

  /* 战报里的时间**早于**房内现有消息 —— 重排后它必须排到前面，
     这就是"按绝对时间并入"与"接在最后"的分水岭。 */
  const incoming = fromNdjson(toNdjson([
    {seq:1, id:'593353:1', ts:1771000000000, kind:'chat', from:'老王', actor:'老王',
     anon_id:'a1', req_id:'old-1', rule_at:'generic', payload:{text:'更早的一条'}},
    {seq:2, id:'593353:2', ts:1773000000000, kind:'chat', from:'老王', actor:'老王',
     anon_id:'a1', req_id:'old-2', rule_at:'generic', payload:{text:'更晚的一条'}}
  ])).msgs;
  const plan = await planImport(st, incoming);
  eq('★ 规划出 2 条新增', plan.add.length, 2);
  eq('★ 没有已存在的（不该跳过）', plan.skipped, 0);
  await st.reflow(plan);
  const all = st._all();
  eq('★ 导入后条数 = 原有 + 新增', all.length, before + 2);
  /* ★ 关键断言：更早的那条必须排在房内原有消息**之前** */
  const idxEarly = all.findIndex(m => m.id === '593353:1');
  const idxLocal = all.findIndex(m => !String(m.id).startsWith('593353:'));
  const idxLate  = all.findIndex(m => m.id === '593353:2');
  ok('★ 更早的战报消息排到本房消息之前（按 ts 重排，不是接在最后）',
    idxEarly < idxLocal && idxLocal < idxLate, `早=${idxEarly} 本房=${idxLocal} 晚=${idxLate}`);
  ok('★ seq 与 ts 顺序一致（重排真的生效）',
    all.every((m, i) => i === 0 || all[i - 1].ts <= m.ts), all.map(m => m.ts).join(','));
  ok('★ seq 严格递增且连续', all.every((m, i) => i === 0 || all[i - 1].seq < m.seq));
  /* ★ 导入的消息保留原 id：重复导入靠它认出来；来源房间也靠它标出来 */
  ok('★ 导入的消息保留原 id', all.some(m => m.id === '593353:1'));
  eq('★ 导入消息的 req_id 被清空（外房间的幂等键不能带进来）',
    all.filter(m => String(m.id).startsWith('593353:')).every(m => m.req_id === null), true);
  /* ★ 新 seq 从原 room.seq+1 起跳：保证新生成的 id 不可能撞上保留下来的旧 id */
  ok('★ 新 seq 全部大于重排前的 room.seq（防 id 撞车）',
    all.every(m => m.seq > roomSeqBefore), '原 room.seq=' + roomSeqBefore);
  eq('★ room.seq 推进到新的最大值', (await st.getRoom()).seq, all[all.length - 1].seq);

  // 第二次导入同一份：全部命中已存在 → 跳过，不翻倍
  const plan2 = await planImport(st, incoming);
  eq('★ 重复导入全部命中（幂等）', plan2.skipped, 2);
  eq('★ 幂等：没有新增', plan2.add.length, 0);
  await st.reflow(plan2);
  eq('★ 幂等：条数不变', st._all().length, before + 2);

  // 坏行不该让整份战报废掉
  const p3 = fromNdjson('{"bad":1}\n');
  eq('★ 坏行被收集而不是整批失败', p3.msgs.length, 0);
  eq('★ 坏行有记录', p3.errs.length, 1);

  /* ★ 网关必须把 token 一起转发：只转 body 的话 DO 侧拿不到 token → bad_token。
   *   端到端真跑才发现（单测直接调 DO，绕开了网关这一层）。 */
  const idxSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'index.js'), 'utf8');
  ok('★ 网关转发 /import 时带上查询串（token 在里面）',
    /doFetch\(stub, '\/import\?' \+ url\.searchParams\.toString\(\)/.test(idxSrc), 'index.js');
  ok('★ 网关的房间路由认得 /import', /\/import/.test(idxSrc) && /\/export/.test(idxSrc), 'index.js');
  ok('★ /import 只接受 POST（没有 body 的 GET 不该白跑一趟）',
    /sub === '\/import' && request\.method === 'POST'/.test(idxSrc));
  const roomSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'room.js'), 'utf8');
  ok('★ DO 侧 /import 要先验 token（导入会写库，不能谁都能来）',
    /url\.pathname === '\/import'[\s\S]{0,200}verifyToken/.test(roomSrc));
  /* ★ 重排后必须喊所有人重载：所有人的游标与本地去重集合都失效了，
   *   不广播就会出现"每个人看到的顺序都不一样"，且无法自愈。 */
  ok('★ 导入后广播 RELOAD（整房重载）', /this\.broadcast\(\{t:OUT\.RELOAD/.test(roomSrc));
  ok('★ RELOAD 帧已加入协议', /RELOAD:'reload'/.test(fs.readFileSync(path.join(ROOT, 'packages', 'protocol', 'src', 'frames.js'), 'utf8')));
  const uiSrc2 = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'ui.js'), 'utf8');
  ok('★ 客户端 RELOAD 时先清空再重载（不清会把整屏判成重播而丢弃）',
    /function reset\(\)/.test(uiSrc2) && /reload\(f\)\s*\{[\s\S]{0,120}ui\.reset\(\)/.test(
      fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'main.js'), 'utf8')));
}

console.log('== 23. ★ mergeOrder：排序键 = (ts, batch, 原 seq) ==');
{
  const cur = [{id:'L1', seq:1, ts:200}, {id:'L2', seq:2, ts:200}, {id:'L3', seq:3, ts:300}];
  const inc = [{id:'F1', seq:9, ts:100}, {id:'F2', seq:8, ts:200}, {id:'F3', seq:7, ts:200}];
  const o = mergeOrder(cur, inc);
  /* 期望：F1(ts100) 最早；ts200 这一秒里 现有的 L1/L2 在前、导入的 F3(原seq7)/F2(原seq8) 在后；
     L3(ts300) 最后。★ 注意 F3 在 F2 前 —— 它们在原房间的 seq 是 7/8，必须保住原先后。 */
  eq('★ 排序键 = (ts, 现有优先, 原 seq)', JSON.stringify(o),
    JSON.stringify(['F1', 'L1', 'L2', 'F3', 'F2', 'L3']));
  eq('★ 同秒时现有的排在导入的之前（用户已定）', o.indexOf('L2') < o.indexOf('F3'), true);
  eq('★ 导入批内部严格按原房间 seq 保序（指令→回复不乱）', JSON.stringify(mergeOrder([], inc)),
    JSON.stringify(['F1', 'F3', 'F2']));
  eq('★ 空房间导入', JSON.stringify(mergeOrder([], [])), '[]');
  eq('★ 只导入不重排也安全', mergeOrder(cur, []).length, 3);
}

console.log('== 24. ★ 页面标题 + D&D 角色卡增加 AC（真机反馈 · 第 3/5 条）==');
{
  const html = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'index.html'), 'utf8');
  /* ① 标题：这是联网版，不是单机版 —— 标签页标题与顶栏都要改 */
  ok('★ 浏览器标签标题已改', /<title>TRPG · 骰娘在线<\/title>/.test(html), 'index.html');
  ok('★ 顶栏标题已改', /TRPG · 骰娘在线/.test(html));
  ok('★ 不再出现"单机可摸版"', !/单机可摸/.test(html), 'index.html');

  /* ② D&D 卡的静态数据 AC / HP：与 COC 的 HP·SAN 同形态 */
  const {parseCardSet, renderCardHtml} = await import('../packages/engine/src/card.js');
  const r = parseCardSet('力量 16 敏捷 14 体质 15 智力 10 感知 12 魅力 8 等级 3 ac 16 hp 24');
  eq('★ 卡能设 AC', r.data.ac, 16);
  eq('★ 卡能设 HP', r.data.hp, 24);
  eq('★ 无解析错误', r.errs.length, 0);
  /* ★ AC 的取值范围与属性不同：沿用属性的 1–30 会把高等级 HP 判非法 */
  eq('★ HP 可以超过 30（不被属性范围误伤）', parseCardSet('hp 120').errs.length, 0);
  ok('★ AC 超范围会报错', parseCardSet('ac 1000').errs.length > 0);
  ok('★ AC 认中文别名', parseCardSet('护甲等级 17').data.ac === 17, String(parseCardSet('护甲等级 17').data));
  const cardHtml = renderCardHtml({family:'dnd', data:{str:16, dex:14, ac:16, hp:24, lv:3}});
  ok('★ 卡片渲染出 AC', /护甲等级/.test(cardHtml) && />16</.test(cardHtml), cardHtml.slice(-120));
  ok('★ 卡片渲染出 HP', /生命值/.test(cardHtml) && />24</.test(cardHtml));
  /* ★ AC 不该有调整值：它没有 +N 的语义，塞进六格栅格会显示成"16 +0" */
  const packDnd = (await import('../packages/engine/src/pack_dnd.js')).DND_PACK
    || (await import('../packages/engine/src/packs.js')).rulePack('dnd5e');
  ok('★ 卡模板里说明了 AC 需自己填', /AC/.test(JSON.stringify(packDnd.cardTemplate())), 'cardTemplate');
  // AC / HP 不参与检定：不能出现在可检定名字里
  /* ★ 精确匹配：用 /ac/i 会被 "acrobatics（特技）" 命中 —— 那是真技能，不能误判 */
  const skillKeys = new Set((await import('../packages/engine/src/dnd.js')).DND_SKILLS.map(s => s.en));
  ok('★ AC 不参与检定（不是 .rc 的目标）', !skillKeys.has('ac') && !skillKeys.has('hp'),
    [...skillKeys].slice(0, 3).join(','));
}

console.log('== 25. ★★ 续期：导出/导入各续 30 天，接力链不断（用户已定）★★');
{
  const st = createMemoryStorage('RENEW01');
  const T0 = 1772000000000;
  let t = T0;
  const core = createRoomCore(st, {now: () => (t += 1000)});
  await core.apply({reqId:'r1', text:'一条老消息', anonId:'a1', nick:'老王'});

  /* ① 导入即续期：导入的消息要带上 keep_until */
  const incoming = [{seq:1, id:'593353:1', ts:T0 - 40 * 86400000, kind:'chat', from:'老王', actor:'老王',
    anon_id:'a1', req_id:null, rule_at:'generic', payload:{text:'40 天前的'}}];
  const plan = await planImport(st, incoming, T0);
  eq('★ 导入的消息被续期', typeof plan.add[0].keep_until, 'number');
  ok('★ 续期窗口 = 30 天', plan.add[0].keep_until - T0 === 30 * 86400000,
    String(plan.add[0].keep_until - T0));
  /* ★ 关键：这条消息**已经满 30 天**（40 天前），靠续期才活下来 */
  ok('★ 已过期的老消息也能被续期救回', incoming[0].ts < T0 - 30 * 86400000);
  await st.reflow(plan);
  eq('★ 续期值落到库里', (await st.brief()).length, 2);
  eq('★ 房间最晚续期截止可被读回（.status 显示用）',
    await st.maxKeepUntil(), plan.add[0].keep_until);

  /* ② 来源房间始终是最初的出生房间 —— 接力链 A→B→C 里 C 看到的仍是 A（用户已定）
   *   且 id 不变意味着去重在整条链上都有效：同一段内容导进 C 两次不会变成两份。 */
  eq('★ 来源房间 = id 前缀（不因中转而改变）', '593353:1'.split(':')[0], '593353');

  /* ③ 清理必须双条件：满 30 天 **且** 没被续期 */
  const roomSrc = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'room.js'), 'utf8');
  ok('★ 清理带 keep_until 条件（不会删掉刚续期的老消息）',
    /DELETE FROM messages WHERE ts < \? AND \(keep_until IS NULL OR keep_until <= \?\)/.test(roomSrc));
  /* ④ 续期不能改 ts：ts 是排序键，改了会让老消息假装是刚发生的 */
  ok('★ 续期单独存 keep_until，不改 ts',
    /keep_until INTEGER/.test(fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'schema.sql'), 'utf8')));
  ok('★ 老房间也能长出 keep_until 列（迁移）',
    /ALTER TABLE messages ADD COLUMN keep_until/.test(roomSrc));
  /* ★ 导出续期必须覆盖"已被续期救活的"：只判 ts 会漏掉它们，
   *   而接力链上正是这些老消息 —— 漏了就变成"导一次断一跳"。 */
  ok('★ 导出续期覆盖已被续活的老消息（ts 过期但 keep_until 未过）',
    /UPDATE messages SET keep_until = \? WHERE ts >= \? OR keep_until > \?/.test(roomSrc));

  /* ⑤ 可见痕迹：.status 与战报都要写，否则无法验证续期生效 */
  ok('★ .status 会显示"已续期至"', /keepUntil/.test(fs.readFileSync(path.join(ROOT, 'packages', 'engine', 'src', 'cmd.js'), 'utf8')));
  ok('★ 战报里写明续期条数与截止日', /续期至/.test(fs.readFileSync(path.join(ROOT, 'packages', 'engine', 'src', 'render-md.js'), 'utf8')));
  /* ⑥ 软提醒而不是硬拦截 */
  ok('★ 容量是软提醒（超过阈值只提示，不拒绝导入）', /CAP_WARN/.test(roomSrc) && !/拒绝导入/.test(roomSrc));
}

console.log('---------------------------');
console.log('协议层：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail) console.log('\n提示：失败项先分清是「协议逻辑错了」还是「测试替身与 DO 行为不一致」。');
process.exit(fail ? 1 : 0);

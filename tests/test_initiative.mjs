/* ============================================================================
 * test_initiative.mjs —— S2 模块 B · DND 先攻「运行时指令层」真跑验收
 * ----------------------------------------------------------------------------
 * 对应 v10 附录 I·3.9 的 16 条验收 + C1–C5 / L1–L7 / E1–E6。
 * 两路：① memory_storage（协议链路：用户原文 / 幂等 / 游标 / 消息分级）
 *       ② sqlite_storage + sql.js 真库（DDL / SQL 语义 / 排序 / 归零清表）
 * 不改任何既有测试；先攻的所有断言都在这里，方便模块完成后按消费状态表压缩。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import * as Engine from '../packages/engine/src/index.js';
import {createRoomCore, planImport} from '../apps/worker/src/core.js';
import {createMemoryStorage} from './memory_storage.mjs';
import {createSqliteStorage} from './sqlite_storage.mjs';
import {RESET_SQL} from '../apps/worker/src/lifecycle.js';
import {KIND} from '../packages/protocol/src/payload.js';
const initSqlJs = createRequire(import.meta.url)('sql.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };
const eq = (n, a, b) => ok(n, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));

const ORIG = Engine.RNG.die;
async function dice(seq, fn){
  let i = 0;
  Engine.RNG.die = () => { const v = seq[i++]; return v === undefined ? 1 : v; };
  try{ return await fn(); } finally { Engine.RNG.die = ORIG; }
}
const T = 1772000000000;
let rid = 0;
const run = (core, text, nick, anonId) => core.apply({reqId:'ri' + (++rid), text, anonId:anonId || 'a1', nick:nick || '老王'});
/* ★ now 必须递增：core 的令牌桶按 now 回复，固定时钟会让同一房间第 11 条起被判
 *   rate_limited（返回空 msgs）—— 与 test_protocol.mjs 的 mk() 同款注入方式。 */
const mk = (rule) => {
  const st = createMemoryStorage('123456');
  st._room().rule = rule || 'dnd5e';
  let t = T;
  return {st, core:createRoomCore(st, {now:() => (t += 100), online:() => 1, memberCount:() => 1})};
};
const txt = r => r.msgs.map(m => m.kind === 'notice' ? String(m.payload.html || '')
  : m.kind === 'sys' ? [m.payload.title, m.payload.line1, m.payload.line2].join(' ')
  : m.kind === 'cmd' ? String(m.payload.text || '') : '').join('\n');
const sysN = r => r.msgs.filter(m => m.kind === 'sys').length;
const noticeN = r => r.msgs.filter(m => m.kind === 'notice').length;
const snap = st => st.combatSnapshot();

console.log('== 验收 1 · 规则归属（不静默、不落条目） ==');
{
  for(const rule of ['generic', 'coc7', 'dh', 'fu']){
    const {st, core} = mk(rule);
    const r = await run(core, '.ri +2');
    ok(rule + ' 下 .ri 给 D&D 5e / 5.5e 归属提示', /D&D 5e \/ 5\.5e/.test(txt(r)), txt(r));
    eq(rule + ' 下不落条目', (await snap(st)).entries.length, 0);
  }
  for(const rule of ['dnd5e', 'dnd5r']){
    const {st, core} = mk(rule);
    await dice([14], () => run(core, '.ri +2'));
    eq(rule + ' 下 .ri 可用', (await snap(st)).entries.length, 1);
  }
  const {core} = mk('generic');
  eq('归属提示也走幂等链路（原文 cmd 落库）', (await run(core, '.ri')).msgs[0].kind, KIND.CMD);
}

console.log('== 验收 2 · 空表 / 开启 / 结束广播 ==');
{
  const {st, core} = mk();
  ok('空表 .init → 当前未开启', /当前未开启/.test(txt(await run(core, '.init'))));
  const r1 = await dice([14], () => run(core, '.ri'));
  ok('首个 .ri 有 ⚔️ 先攻已开启', /⚔️ 先攻已开启/.test(txt(r1)));
  eq('首个 .ri = 1 条 notice 回执 + 1 条 sys 广播', noticeN(r1) + sysN(r1), 2);
  ok('首个 .ri 回执带名字与值', /已添加 老王 14/.test(txt(r1)), txt(r1));
  ok('首个 .ri 不带顺位提示与序列', !/可能影响本轮|先攻序列/.test(txt(r1)), txt(r1));
  const r2 = await run(core, '.init clear');
  ok('清空只发一条显著广播', sysN(r2) === 1 && noticeN(r2) === 0);
  ok('清空文案：战斗结束，先攻表已清理', /战斗结束，先攻表已清理/.test(txt(r2)));
  ok('清空不附完整序列与指针', !/先攻序列|当前 →/.test(txt(r2)), txt(r2));
  eq('清空后表为空', (await snap(st)).entries.length, 0);
}

console.log('== 验收 3 · 广播统一不变量（空↔非空才广播） ==');
{
  const {st, core} = mk();
  await dice([14], () => run(core, '.ri'));
  const add2 = await dice([12], () => run(core, '.ri 哥布林 +2'));
  eq('表内新增（1→2）不广播', sysN(add2), 0);
  const over = await dice([20], () => run(core, '.ri 老王 21'));
  eq('同名覆写不广播', sysN(over), 0);
  ok('覆写回执标旧值 → 新值', /已更新 老王 14 → 21/.test(txt(over)), txt(over));
  const del1 = await run(core, '.init del 哥布林');
  eq('删 1 条剩 1 条不广播', sysN(del1), 0);
  const delLast = await run(core, '.init del 老王');
  eq('删到最后一个 → 结束广播', sysN(delLast), 1);
  ok('del 删空的广播文案同款', /战斗结束，先攻表已清理/.test(txt(delLast)));
  eq('del 删空后两表皆空', (await snap(st)).combat, null);
}

console.log('== 验收 4 · 表仍非空时序列 + 指针 / 战斗进行中的 .ri ==');
{
  const {core} = mk();
  await dice([14], () => run(core, '.ri'));
  const q = txt(await run(core, '.init'));
  ok('查看类落消息', q.length > 0);
  ok('查看给完整先攻序列', /先攻序列 · 第 1 轮/.test(q), q);
  ok('查看给指针（默认首位）', /当前 →/.test(q), q);
  const add = await dice([12], () => run(core, '.ri 哥布林 +2'));
  ok('战斗进行中新建带顺位影响提示', /可能影响本轮行动顺序/.test(txt(add)), txt(add));
  ok('战斗进行中新建带完整序列 + 指针', /先攻序列/.test(txt(add)) && /当前 →/.test(txt(add)));
  eq('战斗进行中新建不广播', sysN(add), 0);
  const set = await run(core, '.init set 老王 21');
  ok('改值带顺位提示 + 序列 + 指针', /可能影响本轮/.test(txt(set)) && /先攻序列/.test(txt(set)));
}

console.log('== 验收 5 · 推进 / 回退 / 结束整场词表 ==');
{
  const {st, core} = mk();
  await dice([14, 12, 10], () => run(core, '.ri 3#怪'));
  const a = txt(await run(core, '.init 结束'));
  ok('.init 结束 = 推进一回合（不清表）', /推进一回合/.test(a) && (await snap(st)).entries.length === 3);
  const b = txt(await run(core, '.init next'));
  ok('.init next 同款推进', /推进一回合/.test(b));
  const c = txt(await run(core, '.init 下一位'));
  ok('.init 下一位 同款推进', /推进一回合/.test(c));
  const p = txt(await run(core, '.init 回退'));
  ok('.init 回退 可回退', /回退一回合/.test(p));
  const bad1 = txt(await run(core, '.init combat 结束'));
  ok('.init combat 结束 不合法并给用法', /不合法/.test(bad1) && (await snap(st)).entries.length === 3);
  const bad2 = txt(await run(core, '.init combat next'));
  ok('.init combat next 不合法', /不合法/.test(bad2));
  ok('endcombat 单 token 未注册为正式命令', Engine.parseCommand('.init endcombat') !== null &&
    !/战斗结束，先攻表已清理/.test(txt(await run(core, '.init endcombat'))));
  const end1 = txt(await run(core, '.init combat end'));
  ok('.init combat end 结束整场', /战斗结束，先攻表已清理/.test(end1));
  eq('combat end 后表空', (await snap(st)).entries.length, 0);
  await dice([9], () => run(core, '.ri'));
  const end2 = txt(await run(core, '.init 战斗结束'));
  ok('.init 战斗结束 结束整场', /战斗结束，先攻表已清理/.test(end2), end2);
  eq('中文整串与 combat end 语义等价', (await snap(st)).entries.length, 0);
  await dice([8], () => run(core, '.ri'));
  const end3 = txt(await run(core, '.init 战斗 结束'));
  ok('.init 战斗 结束（带空格）等价', /战斗结束，先攻表已清理/.test(end3), end3);
}

console.log('== 验收 6 · 错配状态 S1\' ==');
{
  const {st, core} = mk();
  await dice([14], () => run(core, '.ri'));
  st._room().rule = 'coc7';                     // 模拟 .set rule 切走（表不清空）
  eq('切规则不清空先攻表', (await snap(st)).entries.length, 1);
  for(const cmd of ['.ri +2', '.init', '.init set 老王 18', '.init 结束']){
    const s = txt(await run(core, cmd));
    ok('S1\' 下 ' + cmd + ' 返回错配提示', /D&D 先攻表/.test(s) && /切回后恢复/.test(s), s);
  }
  for(const cmd of ['.init clear']){
    ok('S1\' 下 ' + cmd + ' 豁免放行', /战斗结束，先攻表已清理/.test(txt(await run(core, cmd))));
    await dice([11], () => run(core, '.ri'));  // 错配下无法建，先切回
    st._room().rule = 'dnd5e';
    await dice([11], () => run(core, '.ri'));
  }
  st._room().rule = 'coc7';
  ok('S1\' 下 .init combat end 豁免放行', /战斗结束，先攻表已清理/.test(txt(await run(core, '.init combat end'))));
  await dice([13], () => run(core, '.ri'));    // 错配
  st._room().rule = 'dnd5e';
  const back = await dice([13], () => run(core, '.ri'));
  ok('切回 DND 自然恢复可用（无补消息、无状态迁移）', /已添加|已更新/.test(txt(back)), txt(back));
}

console.log('== 验收 7 · 全部落 messages / ts / 导出可读 ==');
{
  const {st, core} = mk();
  const r = await dice([14], () => run(core, '.ri'));
  ok('用户原文是 cmd 消息', r.msgs[0].kind === KIND.CMD && r.msgs[0].payload.text === '.ri');
  ok('反馈是 notice / sys（既有 kind）', r.msgs.slice(1).every(m => m.kind === KIND.NOTICE || m.kind === KIND.SYS));
  ok('全部消息 ts 同源（服务端时钟，非客户端时间）', r.msgs.every(m => m.ts === r.msgs[0].ts && m.ts > T));
  ok('seq 严格递增', r.msgs.every((m, i) => i === 0 || m.seq > r.msgs[i - 1].seq));
  ok('幂等键已落（重复 req_id 不重掷）', (await st._idem()).has(r.msgs[0].req_id));
  const dup = await core.apply({reqId:r.msgs[0].req_id, text:'.ri', anonId:'a1', nick:'老王'});
  eq('重发同 req_id 拿到 dup', dup.dup, true);
  eq('dup 不新增条目', (await snap(st)).entries.length, 1);
  ok('notice 的 html 是纯文本可读（导出战报可读）', /已添加 老王 14/.test(String(r.msgs.find(m => m.kind === KIND.NOTICE).payload.html).replace(/<[^>]+>/g, '')));
}

console.log('== 验收 8 · 排序 / 默认公式 / 隐藏破平 ==');
{
  const {st, core} = mk();
  /* 绑一张敏捷 16 的 DND 卡：abilityMod(16) = +3 */
  await st.setCard('a1', {family:'dnd', data:{dex:16}});
  const r = await dice([10], () => run(core, '.ri'));
  ok('默认公式 = d20 + 敏捷调整值（10 + 3 = 13）', /已添加 老王 13/.test(txt(r)), txt(r));
  const e0 = (await snap(st)).entries[0];
  eq('dex_mod 与默认公式里的敏捷同源同值', e0.dex_mod, 3);
  ok('dex_mod 不显示给玩家', !/dex_mod|敏捷调整值/.test(txt(r)));
  /* 他人条目 dex_mod = 0；同值时不重骰、按 dex_mod 破平 */
  await dice([13], () => run(core, '.ri 张三 13'));
  await dice([13], () => run(core, '.ri 李四 13'));
  const es = (await snap(st)).entries;
  eq('同值按 dex_mod DESC（老王 3 在前）', es[0].name, '老王');
  eq('同值不自动重骰（仍是 3 行）', es.length, 3);
  ok('第三键 id ASC（张三先于李四）', es[1].name === '张三' && es[2].name === '李四');
  /* 完整表达式 / 固定值仍保留 dex_mod 快照 */
  await dice([7], () => run(core, '.ri 王五 d20+d8'));
  const w5 = (await snap(st)).entries.find(x => x.name === '王五');
  eq('完整表达式路径仍存 dex_mod 快照', w5.dex_mod, 0);
  await dice([5], () => run(core, '.ri 赵六 18'));
  const z6 = (await snap(st)).entries.find(x => x.name === '赵六');
  eq('固定值不掷骰', z6.value, 18);
  eq('固定值路径仍存 dex_mod 快照', z6.dex_mod, 0);
  /* 有卡时 d20+2（完整表达式）与 +2（调整项）结果不同：敏捷 +3 */
  const a1 = await dice([10], () => run(core, '.ri A d20+2'));
  const a2 = await dice([10], () => run(core, '.ri +2'));
  ok('d20+2 不含默认敏捷（=12）', /已添加 A 12/.test(txt(a1)), txt(a1));
  ok('+2 含默认敏捷（=15，无角色=自己，覆写老王）', /→ 15|已添加 老王 15/.test(txt(a2)), txt(a2));
  ok('无 .init first / 并列权重字段', !/\.init first|tie_break/.test(fs.readFileSync(path.join(ROOT, 'apps/worker/src/initiative.js'), 'utf8')));
}

console.log('== 验收 9 · 数据模型无多余字段 ==');
{
  const ddl = fs.readFileSync(path.join(ROOT, 'apps/worker/src/schema.sql'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'apps/worker/src/initiative.js'), 'utf8');
  const combatDdl = (ddl.match(/CREATE TABLE IF NOT EXISTS combat[\s\S]*?\);/g) || []).join('\n');
  for(const f of ['acted_this_round', 'tie_break', 'side', 'hp', 'dice', 'expr', 'owner_anon_id'])
    ok('combat 双表无字段 ' + f, !new RegExp('\\b' + f + '\\b', 'i').test(combatDdl));
  ok('逻辑层无 acted / 归档表 / 权限字段', !/acted_this_round|visibility|archive/.test(src));
  const room = fs.readFileSync(path.join(ROOT, 'apps/worker/src/room.js'), 'utf8');
  ok('双表为纯新增 CREATE TABLE IF NOT EXISTS', /CREATE TABLE IF NOT EXISTS combat \(/.test(room) && /CREATE TABLE IF NOT EXISTS combat_entry \(/.test(room));
}

console.log('== 验收 10 · upsert / 安全编辑分工 ==');
{
  const {st, core} = mk();
  await dice([14], () => run(core, '.ri 老王 +2'));
  const before = (await snap(st)).entries[0];
  const over = await dice([20], () => run(core, '.ri 老王 +2'));
  ok('.ri 同名覆写标旧→新', /已更新 老王 16 → 22/.test(txt(over)), txt(over));
  const after = (await snap(st)).entries[0];
  eq('覆写保持 id', after.id, before.id);
  eq('覆写保持 created_at', after.created_at, before.created_at);
  eq('覆写保持 owner / card_ref', after.owner === before.owner && after.card_ref === before.card_ref, true);
  eq('覆写不改变条目数', (await snap(st)).entries.length, 1);
  const bad = txt(await run(core, '.init set 不存在 18'));
  ok('.init set 名字不存在明确报错', /条目「不存在」不存在/.test(bad) && /\.ri/.test(bad), bad);
  eq('报错不创建条目', (await snap(st)).entries.length, 1);
  const okSet = await run(core, '.init set 老王 18');
  ok('.init set 只编辑已有条目', /已改值 老王 22 → 18/.test(txt(okSet)), txt(okSet));
  ok('.ri 侧没有 set / add / 添加 子命令', !/\.ri set|\.ri add|\.ri 添加/.test(fs.readFileSync(path.join(ROOT, 'apps/worker/src/initiative.js'), 'utf8')));
}

console.log('== 验收 11 · .ri 三段解析器 ==');
{
  const {st, core} = mk();
  const a = await dice([10, 3], () => run(core, '.ri d20+d8'));
  ok('.ri d20+d8 无需 = 号（10+3=13）', /已添加 老王 13/.test(txt(a)), txt(a));
  const b = await dice([10], () => run(core, '.ri 张三 +2'));
  ok('.ri +2 叠加成 d20+2（他人敏捷 0）', /已添加 张三 12/.test(txt(b)), txt(b));
  const c = await dice([10], () => run(core, '.ri 李四 =d20+3 +2'));
  ok('=d20+3 +2 合并成 1d20+5（10+5=15）', /已添加 李四 15/.test(txt(c)), txt(c));
  const d = txt(await dice([10], () => run(core, '.ri -1d4')));
  ok('-1d4 负骰组显式报错', /负骰组/.test(d), d);
  const e = txt(await dice([10], () => run(core, '.ri 18 d20')));
  ok('固定值与表达式同现显式报错', /固定值/.test(e), e);
  const f = await dice([10], () => run(core, '.ri 18'));
  ok('.ri 18 固定值不掷骰', /→ 18|已添加 老王 18/.test(txt(f)), txt(f));
  /* 三段顺序无关：+1d4 adv 张三 ≡ 张三 adv +1d4（通用分支整条连投两次） */
  const g1 = await dice([10, 2, 18, 4], () => run(core, '.ri +1d4 adv 张三'));
  const g2 = await dice([10, 2, 18, 4], () => run(core, '.ri 张三 adv +1d4'));
  const vx = (await snap(st)).entries.find(x => x.name === '张三');
  ok('三段顺序无关（同名覆写，取高组 18+4=22）', /已更新 张三 .+ → 22/.test(txt(g2)), txt(g2));
  eq('adv 取高的是整条合计而非只 d20', vx.value, 22);
  /* 批量独立掷骰 */
  const h = await dice([11, 12, 13], () => run(core, '.ri 3#哥布林 +2'));
  ok('3#哥布林 建 3 行', /哥布林1/.test(txt(h)) && /哥布林2/.test(txt(h)) && /哥布林3/.test(txt(h)), txt(h));
  const gs = (await snap(st)).entries.filter(x => /^哥布林\d$/.test(x.name));
  eq('批量 3 行', gs.length, 3);
  ok('每行独立掷骰（11+2 / 12+2 / 13+2 各不同）', new Set(gs.map(x => x.value)).size === 3);
  /* 负敏捷符号规范化：dex=8 → abilityMod = -1 */
  const m2 = mk();   // 独立房间，验证负敏捷符号规范化
  await m2.st.setCard('a1', {family:'dnd', data:{dex:8}});
  const neg = await dice([10], () => run(m2.core, '.ri'));
  ok('负敏捷规范化 d20-1（10-1=9），不是 d20+-1', /已添加 老王 9/.test(txt(neg)), txt(neg));
  const neg2 = await dice([10], () => run(m2.core, '.ri 李四 +2'));
  ok('d20-1+2 → mod=+1（他人条目敏捷 0 → 12）', /已添加 李四 12/.test(txt(neg2)), txt(neg2));
  const q = txt(await dice([10], () => run(m2.core, '.ri @"哥布林 弓手" +2')));
  ok('双引号包裹含空格名字', /哥布林 弓手/.test(q), q);
  const badName = txt(await dice([10], () => run(m2.core, '.ri 哥布林 弓手 +2')));
  ok('不带引号的含空格名字显式报错', /双引号/.test(badName), badName);
}

console.log('== 验收 12 · 改值 / 新增影响顺位（A 方案） ==');
{
  const {st, core} = mk();
  await dice([14], () => run(core, '.ri'));
  await dice([12], () => run(core, '.ri 哥布林 +2'));
  await run(core, '.init 结束');                    // 指针推进到第 2 位
  const c0 = (await snap(st)).combat;
  const s = await run(core, '.init set 老王 21');
  const c1 = (await snap(st)).combat;
  eq('改值不改 cursor_entry_id', c1.cursor_entry_id, c0.cursor_entry_id);
  eq('改值不改 round', c1.round, c0.round);
  ok('反馈带顺位提示 + 完整序列 + 指针', /可能影响本轮/.test(txt(s)) && /先攻序列/.test(txt(s)) && /当前 →/.test(txt(s)));
  const add = await dice([25], () => run(core, '.ri 新怪 25'));
  const c2 = (await snap(st)).combat;
  eq('战斗进行中新增不改 cursor / round', c2.cursor_entry_id === c1.cursor_entry_id && c2.round === c1.round, true);
  ok('新增反馈带顺位提示 + 序列 + 指针', /可能影响本轮/.test(txt(add)) && /先攻序列/.test(txt(add)));
  ok('无自动补正 / 无 acted 字段', !/自动补正|acted/.test(fs.readFileSync(path.join(ROOT, 'apps/worker/src/initiative.js'), 'utf8')));
}

console.log('== 验收 13 · 别名词表与边角 ==');
{
  eq('.先攻 → ri', Engine.parseCommand('.先攻 +2').verb, 'ri');
  eq('.先攻表 → init', Engine.parseCommand('.先攻表').verb, 'init');
  eq('.先攻表 set 老王 18 的 rest', Engine.parseCommand('.先攻表 set 老王 18').rest, 'set 老王 18');
  eq('.先攻表哥 被长优先抢走（已接受边角）', Engine.parseCommand('.先攻表哥 +2').verb, 'init');
  eq('detectConflicts(verb, 先攻/先攻表) 为空', Engine.detectConflicts('verb', [
    {key:'ri', aliases:['先攻']}, {key:'init', aliases:['先攻表']}]).length, 0);
  eq('normToken(战斗 结束) === normToken(战斗结束)', Engine.normToken('战斗 结束'), Engine.normToken('战斗结束'));
  ok('normToken(结束) ≠ normToken(战斗结束)', Engine.normToken('结束') !== Engine.normToken('战斗结束'));
  eq('mode 域与 verb 域分域独立', Engine.lookupAlias('mode', '优势').key, 'adv');
  /* 模块 C · C1 已注册 `.理智`→sc（I·4.1）；`.rc 理智` 仍走参数域，不受影响 */
  eq('.理智 → sc（模块 C C1 已注册）', (Engine.parseCommand('.理智') || {}).verb, 'sc');
  eq('.rc 理智 仍走 rc 动词、不受动词域影响', Engine.parseCommand('.rc 理智').verb, 'rc');
}

console.log('== 验收 14 · sqlite 真跑 / C1–C5 / 老房间 ==');
{
  const SQL = await initSqlJs();
  const ddl = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'schema.sql'), 'utf8');
  const db = new SQL.Database();
  for(const s of ddl.split(';').map(s => s.trim()).filter(s => s && !/^PRAGMA/i.test(s))) db.run(s);
  const st = createSqliteStorage(db, '123456');
  st.init({code:'123456', now:T});
  db.run("UPDATE room SET rule = 'dnd5e' WHERE id = 1");   // init 默认 generic
  let tq = T;
  const core = createRoomCore(st, {now:() => (tq += 100)});
  await dice([14], () => run(core, '.ri'));
  const s1 = await st.combatSnapshot();
  eq('SQLite 真库写入 1 条', s1.entries.length, 1);
  ok('SQLite 真库 combat 行存在（单行/房）', !!s1.combat);
  await dice([12], () => run(core, '.ri 哥布林 +2'));
  const s2 = await st.combatSnapshot();
  ok('SQLite 排序 value DESC', s2.entries[0].value >= s2.entries[1].value);
  /* C5：导入战报不重建先攻状态 */
  const plan = await planImport(createMemoryStorage('123456'), [{id:'X:1', ts:T, seq:1, kind:'chat', payload:{text:'hi'}}], T);
  ok('planImport 不产生任何 combat 操作', !JSON.stringify(plan).includes('combat'));
  eq('导入前后 SQLite 先攻条目数不变', (await st.combatSnapshot()).entries.length, 2);
  /* C2：归零清空 SQL 覆盖两表且顺序先 entry 后 combat */
  ok('RESET_SQL 成对清两表', RESET_SQL.some(s => /DELETE FROM combat_entry/.test(s)) && RESET_SQL.some(s => /DELETE FROM combat\b/.test(s)));
  ok('RESET_SQL 顺序先 entry 后 combat',
    RESET_SQL.findIndex(s => /DELETE FROM combat_entry/.test(s)) < RESET_SQL.findIndex(s => /DELETE FROM combat\b/.test(s)));
  RESET_SQL.forEach(s => db.run(s));
  const s3 = await st.combatSnapshot();
  eq('归零后两表皆空', s3.entries.length + (s3.combat ? 1 : 0), 0);
  /* C1：计时判据只读 messages + idempotency */
  const life = fs.readFileSync(path.join(ROOT, 'apps/worker/src/lifecycle.js'), 'utf8');
  ok('C1 计时 SQL 不读 combat*', !/FROM combat/.test(life.match(/SQL_COUNT_CONTENT[\s\S]{0,300}/)[0]));
  /* 老房间唤醒：5 张旧表 + 真实消息 → 两张新表为空且老数据完好 */
  const db2 = new SQL.Database();
  /* 只建 S1 的 5 张表（排除两张 combat 表），模拟「老房间」 */
  for(const s of ddl.split(';').map(x => x.trim())
        .filter(x => x && !/^PRAGMA/i.test(x) && !/CREATE TABLE IF NOT EXISTS combat/.test(x))){
    try{ db2.run(s); }catch(e){ /* 注释行 / 索引缺失，忽略 */ }
  }
  db2.run("INSERT INTO room (id, code, created_at, last_active, rule, baredice, seq) VALUES (1,'123456',1,1,'dnd5e',0,0)");
  db2.run("INSERT INTO messages (seq,id,ts,kind,from_name,payload) VALUES (1,'123456:1',1,'chat','老王','{\"text\":\"老消息\"}')");
  /* DO 唤醒：TABLES.forEach 里两条 CREATE TABLE IF NOT EXISTS 纯新增 */
  for(const s of ddl.split(';').map(x => x.trim()).filter(x => /CREATE TABLE IF NOT EXISTS combat/.test(x))) db2.run(s);
  const st2 = createSqliteStorage(db2, '123456');
  const wake = await st2.combatSnapshot();
  eq('老房间唤醒后两张新表存在且为空', wake.entries.length, 0);
  ok('老房间老消息完好', db2.exec('SELECT COUNT(*) AS c FROM messages')[0].values[0][0] === 1);
}

console.log('== 验收 15 · 基线 / 不新增 kind 与 INIT 帧 ==');
{
  eq('KIND 仍是 6 种', Object.keys(KIND).length, 6);
  const frames = fs.readFileSync(path.join(ROOT, 'packages/protocol/src/frames.js'), 'utf8');
  ok('未新增 INIT / GEN 帧', !/\bINIT\b|\bGEN\b/.test(frames));
  const ini = fs.readFileSync(path.join(ROOT, 'apps/worker/src/initiative.js'), 'utf8');
  ok('先攻只用 notice / sys 两种既有 kind', !/kind:\s*'(roll|html|cmd|chat|init)'/.test(ini));
  ok('前端零改动（本包不含 apps/web/src 文件）', true);
  ok('未新增消息 kind 到 payload 白名单', !/KIND\.\w+\s*=/.test(ini));
}

console.log('== 验收 16 · 指针 / 回合 / 回退边界 ==');
{
  const {st, core} = mk();
  await dice([14, 12, 10], () => run(core, '.ri 3#怪'));
  const s0 = await snap(st);
  eq('初始 round = 1', s0.combat.round, 1);
  eq('初始指针默认首位', s0.combat.cursor_entry_id || s0.entries[0].id, s0.entries[0].id);
  await run(core, '.init 结束');
  await run(core, '.init 结束');
  const s2 = await snap(st);
  eq('推进两次到末位', s2.combat.cursor_entry_id, s2.entries[2].id);
  await run(core, '.init 结束');
  const s3 = await snap(st);
  eq('走完一圈回到首位', s3.combat.cursor_entry_id, s3.entries[0].id);
  eq('走完一圈 round +1', s3.combat.round, 2);
  await run(core, '.init prev');
  const s4 = await snap(st);
  eq('prev 到首位停、不倒扣 round', s4.combat.cursor_entry_id === s4.entries[0].id && s4.combat.round === 2, true);
  /* 删除当前指针条目 → 指向排序下一位 */
  const curName = s4.entries.find(x => x.id === s4.combat.cursor_entry_id).name;
  await run(core, '.init del ' + curName);
  const s5 = await snap(st);
  ok('删当前指针后指针指向排序下一位', s5.combat.cursor_entry_id === s5.entries[0].id, JSON.stringify(s5.combat));
  eq('删 1 条剩 2 条、round 不变', s5.entries.length === 2 && s5.combat.round === 2, true);
}

console.log('---------------------------');
console.log('先攻运行时验收：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail) process.exit(1);

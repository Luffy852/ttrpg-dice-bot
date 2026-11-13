/* ============================================================================
 * test_sc.mjs —— S2-BC-C1 · 模块 C 第一个独立包验收（I·4.1 / Q1–Q4 确认口径）
 * ----------------------------------------------------------------------------
 * 范围：`.sc` / `.理智` 全套（别名注册 + 接线 + 归属提示 + .help coc 段 +
 *       .rc list 两条路径提示 + 参数透传 + 零扩张），不含 `.ds`（留 C2）。
 *
 * 不抄生产逻辑：所有输出都从真实 Engine.handleCommand / Engine.renderDefs 取；
 * 随机源一律 Engine.RNG.die（固定序列），try/finally 恢复。
 * ★ 全程防御式取值：接线未落时「成片变红、每条可读」，不在第 1 段就 TypeError 崩掉
 *   —— 这是「先红后绿 / 回退验证真的会红」的前提（沿用 A2 的教训）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as Engine from '../packages/engine/src/index.js';
import { checkPayload, KIND, KINDS } from '../packages/protocol/src/payload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* ★ 与 tools/check-engine-split.js 同款：源码级断言先剥注释再扫代码（A1 首轮假红的教训） */
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };
const eq = (n, a, b) => ok(n, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));

const ORIG = Engine.RNG.die;
/** 注入固定骰序列；序列耗尽后恒定返回 1（百分骰固定 100，便于逐字段比对） */
function dice(seq, fn){
  let i = 0;
  Engine.RNG.die = () => { const v = seq[i++]; return v === undefined ? 1 : v; };
  try{ return fn(); } finally{ Engine.RNG.die = ORIG; }
}
const diceAll = (v, fn) => dice(new Array(600).fill(v), fn);

/** 与 test_engine.js / test_gen_runtime.mjs 的 mkCtx 同形（服务端权威昵称 + 纯引擎 room） */
const mkCtx = (rule, card, me) => {
  const c = {me:me || '老王', room:Engine.makeRoom(), card:card || null, history:[]};
  if(rule) c.room.rule = rule;
  return c;
};
const run = (text, ctx) => Engine.handleCommand(text, ctx);
const first = r => (r && r.msgs && r.msgs[0]) || null;
const htmlOf = r => { const m = first(r); return (m && m.html) || ''; };
const defsOf = r => { const m = first(r); return (m && m.defs) || {title:'', sections:[], foot:[]}; };
const viewOf = r => { const m = first(r); return (m && m.view) || null; };
const kindOf = r => { const m = first(r); return (m && m.kind) || '（无消息）'; };
/** 逐字段等价只取 roll 事实部分（不含消息 id / ts 这类每次不同的东西） */
const pick = v => v ? {
  ruleKey:v.ruleKey, mode:v.mode, groups:v.groups, comps:v.comps,
  diceSum:v.diceSum, add:v.add, total:v.total, dc:v.dc, dcLabel:v.dcLabel,
  verdict:v.verdict, natBadge:v.natBadge, natNote:v.natNote, notes:v.notes, title:v.title
} : null;

const CARD = {family:'coc7', data:{侦查:60, 图书馆:50, hp:12, san:70}};
const HINT = '.sc / .理智 相当于 .rc 理智（自动取卡上 SAN）';

console.log('== C-1 · 动词注册与前缀（Q1 / A.0.1 中文句号订正） ==');
{
  const p1 = Engine.parseCommand('.sc');
  eq('.sc → verb=sc', p1 && p1.verb, 'sc');
  eq('.sc rest 为空', p1 && p1.rest, '');
  eq('.理智 → sc', (Engine.parseCommand('.理智') || {}).verb, 'sc');
  eq('。理智 → sc（中文句号同样有效，A.0.1）', (Engine.parseCommand('。理智') || {}).verb, 'sc');
  eq('．理智 → sc（全角句点同样有效）', (Engine.parseCommand('．理智') || {}).verb, 'sc');
  eq('isCommandText(。理智) = true', Engine.isCommandText('。理智', Engine.makeRoom()), true);
  eq('我们。理智还没恢复 → 不命中（首字符非前缀）', Engine.parseCommand('我们。理智还没恢复'), null);
  eq('.理智检定 → sc + rest=检定（不注册更长别名，长前缀切分属既有设计）',
    (() => { const p = Engine.parseCommand('.理智检定'); return p && p.verb + '/' + p.rest; })(), 'sc/检定');
  eq('.rc 理智 仍走 rc（参数域独立）', (Engine.parseCommand('.rc 理智') || {}).verb, 'rc');
  eq('lookupAlias(verb, 理智) → sc', (Engine.lookupAlias('verb', '理智') || {}).key, 'sc');
  eq('detectConflicts(verb, sc 别名) 为空',
    Engine.detectConflicts('verb', [{key:'sc', aliases:['sc','理智']}]).length, 0);
  eq('ALIAS.conflicts 为空（无别名被静默抢走）', Engine.ALIAS.conflicts.length, 0);
  eq('verbOwner(sc) = coc7（归属单一源）', Engine.verbOwner('sc'), 'coc7');
  eq('VERBS.size = 20（C1 加 sc；C2 加 ds 后 21）', Engine.VERBS.size, 20);
  ok('VERBS 含 sc', Engine.VERBS.has('sc'));
}

console.log('== C-2 · 规则归属（Q2：不静默、不降级为聊天） ==');
{
  for(const rule of ['generic','dnd5e','dnd5r','dh','fu']){
    const r = diceAll(1, () => run('.sc', mkCtx(rule, CARD)));
    const h = htmlOf(r);
    ok('★ ' + rule + ' 下 .sc 有明确 notice（不静默）', kindOf(r) === 'notice', kindOf(r));
    ok('★ ' + rule + ' 下提示含 COC 7th / 专属指令', /COC 7th/.test(h) && /专属指令/.test(h), h.slice(0, 90));
    /* ★ 精确锁住「.set rule coc」而不是内部 key「coc7」：用负向先行断言，
     *   否则回退成 .set rule coc7 时子串仍匹配，会变成摆设断言（#31 同型）。 */
    ok('★ ' + rule + ' 下提示给 .set rule coc 切换（不是 coc7）', /\.set rule coc(?!\d)/.test(h), h.slice(0, 90));
    ok('★ ' + rule + ' 下提示给 .help coc 看用法（不是 coc7）', /\.help coc(?!\d)/.test(h), h.slice(0, 90));
    ok('★ ' + rule + ' 下不掷骰（无 roll 消息）', !(r.msgs || []).some(x => x.kind === 'roll'));
    ok('★ ' + rule + ' 下 handled=true（不降级为聊天）', !!(r && r.handled));
  }
  const inCoc = diceAll(1, () => run('.sc', mkCtx('coc7', CARD)));
  ok('★ coc7 下不出现归属提示', !/专属指令/.test(htmlOf(inCoc)));
  ok('★ coc7 下正常产出 roll', kindOf(inCoc) === 'roll', kindOf(inCoc));
}

console.log('== C-3 · 完全等价 .rc 理智（Q3 透传 / 只掷不改卡 / 零新 kind） ==');
{
  const a = diceAll(1, () => run('.sc', mkCtx('coc7', CARD)));
  const b = diceAll(1, () => run('.rc 理智', mkCtx('coc7', CARD)));
  const va = viewOf(a), vb = viewOf(b);
  ok('★ .sc 产出 roll 消息', kindOf(a) === 'roll', kindOf(a));
  ok('★ view 逐字段等价 .rc 理智（title / dc / verdict / notes / groups）',
    !!va && !!vb && JSON.stringify(pick(va)) === JSON.stringify(pick(vb)),
    JSON.stringify(pick(va)).slice(0, 120));
  ok('★ title 含 san检定（70）、dc=70', !!va && /san检定（70）/.test(va.title) && va.dc === 70);
  ok('★ verdict 走五级成功等级（有 text / why）', !!va && !!(va.verdict && va.verdict.text));
  ok('★ notes 含「SAN 是备忘字段」原样提示', !!va && (va.notes || []).join('').includes('备忘字段'));
  const v = va || {};
  eq('★ .sc 的 roll payload 通过 checkPayload 白名单（零新字段 / 零新 kind）',
    checkPayload(KIND.ROLL, {title:v.title, mode:v.mode, groups:v.groups, comps:v.comps, dc:v.dc, notes:v.notes}), null);
  eq('★ KINDS 仍是 6 种（不新增消息 kind）', KINDS.length, 6);

  const before = JSON.stringify(CARD.data);
  const ctx = mkCtx('coc7', CARD);
  const r = diceAll(1, () => run('.sc', ctx));
  eq('★ 卡 data 一字未改（只掷不改卡）', JSON.stringify(ctx.card.data), before);
  eq('★ room.rule 未变', ctx.room.rule, 'coc7');
  ok('★ 成功路径无 sys / notice 消息（不落留痕、不追踪）',
    !(r.msgs || []).some(x => x.kind === 'sys' || x.kind === 'notice'));

  const noSan = {family:'coc7', data:{侦查:60}};
  const r2 = run('.sc', mkCtx('coc7', noSan));
  ok('★ 卡上无 san → 继承 .rc 理智 原样提示（不自动从 POW 推导）',
    /卡上还没有/.test(htmlOf(r2)) && /\.st set san 60/.test(htmlOf(r2)), htmlOf(r2).slice(0, 100));
  ok('★ 卡上无 san 不产出 roll', !viewOf(r2));
  const r3 = run('.sc', mkCtx('coc7', null));
  ok('★ 未绑卡 → noCardNote（不自动写卡）', /尚未绑定角色卡/.test(htmlOf(r3)), htmlOf(r3).slice(0, 100));
  ok('★ 未绑卡不产出 roll', !viewOf(r3));

  for(const [text, ref] of [['.sc +1','.rc 理智 +1'], ['.sc -2','.rc 理智 -2'], ['.sc +1 -1','.rc 理智 +1 -1']]){
    const x = diceAll(1, () => run(text, mkCtx('coc7', CARD)));
    const y = diceAll(1, () => run(ref, mkCtx('coc7', CARD)));
    ok('★ ' + text + ' ≡ ' + ref + '（参数透传）',
      !!viewOf(x) && !!viewOf(y) && JSON.stringify(pick(viewOf(x))) === JSON.stringify(pick(viewOf(y))));
  }
  const off = viewOf(diceAll(1, () => run('.sc +1 -1', mkCtx('coc7', CARD))));
  ok('★ .sc +1 -1 奖罚相抵（复用 runCheck 同一条链）', !!off && (off.notes || []).join('').includes('相抵'));

  for(const text of ['.sc 侦查','.sc 理智','.sc san','.sc 理智检定','.sc 侦查 +1']){
    const rr = run(text, mkCtx('coc7', CARD));
    ok('★ 「' + text + '」多给技能名 → 显式报错、不静默', kindOf(rr) === 'notice', kindOf(rr));
    ok('★ 「' + text + '」不产出 roll（不换检定目标）', !viewOf(rr));
  }
  ok('★ .sc 侦查 指路 .rc 侦查', /\.rc 侦查/.test(htmlOf(run('.sc 侦查', mkCtx('coc7', CARD)))));
  ok('★ .sc 侦查 明确说明「只按卡上的 SAN 检定」（Q3 定制报错）',
    /只按卡上的 SAN 检定/.test(htmlOf(run('.sc 侦查', mkCtx('coc7', CARD)))));
  ok('★ .sc 理智检定 由 runCheck 单一源报「参数太多」',
    /参数太多/.test(htmlOf(run('.sc 理智检定', mkCtx('coc7', CARD)))));
}

console.log('== C-4 · .help coc 段落（I·4.1 落点 / #58 呈现） ==');
{
  const r = run('.help coc', mkCtx('coc7', null));
  const h = htmlOf(r);                       // = renderDefs(defs) 之后的 HTML
  ok('★ .help coc 追加「理智检定」段', /理智检定/.test(h));
  for(const s of ['.sc / .理智','完全等价于','只掷不改卡','不扣 SAN','五级成功等级','.st set san 60','.set rule coc','.rc 名字']){
    ok('★ 帮助页 renderDefs 之后含「' + s + '」', h.includes(s));
  }
  ok('★ 只追加：既有「五级成功等级」「属性生成」段仍在',
    /五级成功等级/.test(h) && /属性生成/.test(h));
  ok('★ 无 ASCII 尖括号吞字（文案不含 <N> / < 10 这类字面）',
    !/<N>/.test(h) && !/< 10/.test(h));
  ok('★ 呈现后 HTML 仍含完整 .sc 段（未被未知标签吞掉）',
    h.includes('.sc / .理智') && h.includes('只掷不改卡'));
  ok('★ 仍是结构化 html / defs 说明（不空气泡）', kindOf(r) === 'html' && !!defsOf(r).sections.length);
}

console.log('== C-5 · .rc list 两条返回路径都带提示（I·4.1 落点） ==');
{
  const withCard = run('.rc list', mkCtx('coc7', CARD));
  const without  = run('.rc list', mkCtx('coc7', null));
  const footOf = r => (defsOf(r).foot || []);
  ok('★ 有卡路径 foot 含提示', footOf(withCard).some(f => String(f).includes(HINT)));
  ok('★ 无卡路径 foot 含提示', footOf(without).some(f => String(f).includes(HINT)));
  ok('★ 有卡路径 renderDefs 之后 HTML 含提示', htmlOf(withCard).includes(HINT));
  ok('★ 无卡路径 renderDefs 之后 HTML 含提示', htmlOf(without).includes(HINT));
  ok('★ 两条路径仍是结构化 html / defs 说明',
    kindOf(withCard) === 'html' && kindOf(without) === 'html');
  ok('★ 提示只出现一次（不重复堆叠）',
    footOf(withCard).filter(f => String(f).includes(HINT)).length === 1 &&
    footOf(without).filter(f => String(f).includes(HINT)).length === 1);
}

console.log('== C-6 · 零协议 / 零 Worker / 零 schema / 零前端（I·1 / E2 / §0.5 第 11 条） ==');
{
  const core = strip(read('apps/worker/src/core.js'));
  const init = strip(read('apps/worker/src/initiative.js'));
  const schema = strip(read('apps/worker/src/schema.sql'));
  const frame = strip(read('apps/web/src/frame-route.js'));
  ok('★ core.apply 仍只按 INIT_VERBS 分流', /INIT_VERBS\.has\(pc\.verb\)/.test(core));
  ok('★ INIT_VERBS 仍恰为 ri / init（sc 不进 Worker 状态层）',
    /INIT_VERBS\s*=\s*new Set\(\[\s*'ri',\s*'init'\s*\]\)/.test(init));
  ok('★ schema 不含 total_joins 列（B3）', !/total_joins/.test(schema));
  ok('★ frame-route 未登记 INIT / GEN / KIND 帧（E1）', !/OUT\.(INIT|GEN|KIND)/.test(frame));
  ok('★ COC_PACK.verbs.sc 是函数（计算型专属动词，非状态声明）',
    typeof ((Engine.COC_PACK || {}).verbs || {}).sc === 'function');
  ok('★ DND_PACK.verbs 仍只有状态型 ri / init（C1 不碰先攻）', (() => {
    const v = (Engine.DND_PACK || {}).verbs || {};
    return Object.keys(v).sort().join(',') === 'init,ri' && v.ri.kind === 'state' && v.init.kind === 'state';
  })());
  ok('★ 五个包必选契约字段未增补（verbs / ownerNote 均为可选，不改 pack-contract.js）',
    /export \{ PACK_FIELDS, CONDITIONAL_FIELDS \}/.test(read('packages/engine/src/pack-contract.js')));
}

console.log('== C-7 · 既有模块未被 C1 回退（向后比对） ==');
{
  eq('★ .先攻 → ri 仍成立', (Engine.parseCommand('.先攻 +2') || {}).verb, 'ri');
  eq('★ .先攻表 → init 仍成立', (Engine.parseCommand('.先攻表') || {}).verb, 'init');
  eq('★ .coc 仍可解析（模块 A 未回退）', (Engine.parseCommand('.coc 2') || {}).verb, 'coc');
  eq('★ .dnd 仍可解析（模块 A 未回退）', (Engine.parseCommand('.dnd 2') || {}).verb, 'dnd');
  eq('★ 规则包注册点仍为 6', Object.keys(Engine.RULE_PACKS).length, 6);
  ok('★ GEN_SPEC 仍恰为 coc / dnd',
    Object.keys(Engine.GEN_SPEC || {}).sort().join(',') === 'coc,dnd');
  eq('★ .r 4d6k3 仍被拒绝（生成器内部弃最低不泄漏）', Engine.parseExpr('4d6k3').ok, false);
}

console.log('---------------------------');
console.log('模块 C · C1 验收：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

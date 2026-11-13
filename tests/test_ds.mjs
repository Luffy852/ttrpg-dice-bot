/* ============================================================================
 * test_ds.mjs —— S2-BC-C2 · 模块 C 第二个独立包验收（I·4.2 / Q1–Q4 确认口径）
 * ----------------------------------------------------------------------------
 * 范围：`.ds` / `.死亡豁免` / `.死豁` 全套（别名注册 + DND 计算型接线 + 归属提示 +
 *       .help dnd 段 + 固定规则文字的渲染后 HTML + 参数边界 + 零扩张 + C1 不回退）。
 * 不含 `.sc`（C1 已交付，本脚本只做向后比对抽样）。
 *
 * 不抄生产逻辑：所有输出都从真实 Engine.handleCommand / Engine.renderMsg /
 * Engine.renderDefs 取；随机源一律 Engine.RNG.die（固定序列），try/finally 恢复。
 * ★ 全程防御式取值：接线未落时「成片变红、每条可读」，不在第 1 段就 TypeError 崩掉
 *   —— 这是「先红后绿 / 回退验证真的会红」的前提（沿用 A2 / C1 的教训）。
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
/** 注入固定骰序列；序列耗尽后恒定返回 1（1d20 固定 1，便于与 .r 1d20 逐字段比对） */
function dice(seq, fn){
  let i = 0;
  Engine.RNG.die = () => { const v = seq[i++]; return v === undefined ? 1 : v; };
  try{ return fn(); } finally{ Engine.RNG.die = ORIG; }
}
const diceAll = (v, fn) => dice(new Array(600).fill(v), fn);

/** 与 test_engine.js / test_sc.mjs 的 mkCtx 同形（服务端权威昵称 + 纯引擎 room） */
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
/** roll 事实部分逐字段比对（不含消息 id / ts 这类每次不同的东西） */
const pick = v => v ? {
  ruleKey:v.ruleKey, mode:v.mode, groups:v.groups, comps:v.comps,
  diceSum:v.diceSum, add:v.add, total:v.total, dc:v.dc, dcLabel:v.dcLabel,
  verdict:v.verdict, natBadge:v.natBadge, natNote:v.natNote, notes:v.notes, title:v.title
} : null;
/** ★ 呈现类断言一律查 renderMsg（= renderRoll）之后的 HTML，不查 view.notes 字面（#58 / #59） */
const rollHtml = r => {
  const m = first(r);
  return (m && typeof Engine.renderMsg === 'function') ? String(Engine.renderMsg(m) || '') : '';
};

const CARD = {family:'dnd', data:{str:16, dex:14, con:15, int:10, wis:12, cha:8, lv:5, ac:16, hp:24}};
const COC_CARD = {family:'coc7', data:{侦查:60, 图书馆:50, hp:12, san:70}};
const DS_HINT = '死亡豁免（.ds，中文 .死亡豁免 / .死豁）';
const C1_HINT = '.sc / .理智 相当于 .rc 理智（自动取卡上 SAN）';

console.log('== C-1 · 动词注册与前缀（I·4.2 / A.0.1 中文句号订正） ==');
{
  const p1 = Engine.parseCommand('.ds');
  eq('.ds → verb=ds', p1 && p1.verb, 'ds');
  eq('.ds rest 为空', p1 && p1.rest, '');
  eq('.死亡豁免 → ds', (Engine.parseCommand('.死亡豁免') || {}).verb, 'ds');
  eq('.死豁 → ds', (Engine.parseCommand('.死豁') || {}).verb, 'ds');
  eq('。死豁 → ds（中文句号同样有效，A.0.1）', (Engine.parseCommand('。死豁') || {}).verb, 'ds');
  eq('．死亡豁免 → ds（全角句点同样有效）', (Engine.parseCommand('．死亡豁免') || {}).verb, 'ds');
  eq('isCommandText(。死豁) = true', Engine.isCommandText('。死豁', Engine.makeRoom()), true);
  eq('我们。死豁还没过 → 不命中（首字符非前缀）', Engine.parseCommand('我们。死豁还没过'), null);
  eq('.死豁大成功 → ds + rest=大成功（长前缀切分属既有设计，由 ds 显式报错）',
    (() => { const p = Engine.parseCommand('.死豁大成功'); return p && p.verb + '/' + p.rest; })(), 'ds/大成功');
  eq('.rc 死豁 仍走 rc（参数域独立）', (Engine.parseCommand('.rc 死豁') || {}).verb, 'rc');
  eq('lookupAlias(verb, 死豁) → ds', (Engine.lookupAlias('verb', '死豁') || {}).key, 'ds');
  eq('lookupAlias(verb, 死亡豁免) → ds', (Engine.lookupAlias('verb', '死亡豁免') || {}).key, 'ds');
  eq('detectConflicts(verb, ds 别名) 为空',
    Engine.detectConflicts('verb', [{key:'ds', aliases:['ds','死亡豁免','死豁']}]).length, 0);
  eq('ALIAS.conflicts 为空（无别名被静默抢走）', Engine.ALIAS.conflicts.length, 0);
  eq('verbOwner(ds) = dnd5e（归属单一源）', Engine.verbOwner('ds'), 'dnd5e');
  eq('★ VERBS.size = 21（C1 加 sc → 20；C2 加 ds → 21）', Engine.VERBS.size, 21);
  ok('VERBS 含 ds / sc', Engine.VERBS.has('ds') && Engine.VERBS.has('sc'));
  const cjk = Engine.CJK_VERBS || [];
  ok('★ CJK_VERBS 长优先：死亡豁免 排在 死豁 之前',
    cjk.indexOf('死亡豁免') >= 0 && cjk.indexOf('死豁') >= 0 && cjk.indexOf('死亡豁免') < cjk.indexOf('死豁'));
}

console.log('== C-2 · 规则归属（Q2 对称：不静默、不降级为聊天、不张冠李戴） ==');
{
  for(const rule of ['generic','coc7','dh','fu']){
    const r = diceAll(1, () => run('.ds', mkCtx(rule, CARD)));
    const h = htmlOf(r);
    ok('★ ' + rule + ' 下 .ds 有明确 notice（不静默）', kindOf(r) === 'notice', kindOf(r));
    /* esc() 会把 & 转成 &amp;，呈现后 HTML 里是 D&amp;D 5e（不是 D&D 5e） */
    ok('★ ' + rule + ' 下提示含 D&D 5e / 专属指令', /D&(?:amp;)?D 5e/.test(h) && /专属指令/.test(h), h.slice(0, 100));
    /* ★ 精确锁住「.set rule dnd」而不是内部 key「dnd5e」：负向先行断言防摆设（#31 同型） */
    ok('★ ' + rule + ' 下提示给 .set rule dnd 切换（不是 dnd5e）', /\.set rule dnd(?![\w.])/.test(h), h.slice(0, 100));
    ok('★ ' + rule + ' 下提示给 .help dnd 看用法', /\.help dnd(?![\w.])/.test(h), h.slice(0, 100));
    /* ★ C2 评估发现：DND_PACK.initiative.ownerNote 是给 ri/init 的，不能被 .ds 蹭用 */
    ok('★ ' + rule + ' 下提示不写 .ri / .init（先攻文案不张冠李戴）', !/\.ri \/ \.init/.test(h), h.slice(0, 100));
    ok('★ ' + rule + ' 下提示不写「先攻表」', !/先攻表/.test(h), h.slice(0, 100));
    ok('★ ' + rule + ' 下不掷骰（无 roll 消息）', !(r.msgs || []).some(x => x.kind === 'roll'));
    ok('★ ' + rule + ' 下 handled=true（不降级为聊天）', !!(r && r.handled));
  }
  for(const rule of ['dnd5e','dnd5r']){
    const r = diceAll(1, () => run('.ds', mkCtx(rule, CARD)));
    ok('★ ' + rule + ' 下正常产出 roll', kindOf(r) === 'roll', kindOf(r));
    ok('★ ' + rule + ' 下不出现归属提示', !/专属指令/.test(htmlOf(r)));
  }
  /* ★ 不回归：状态型动词 ri / init 打错规则时仍走先攻专属文案 */
  for(const verb of ['.ri','.init']){
    const h = htmlOf(diceAll(1, () => run(verb, mkCtx('coc7', CARD))));
    ok('★ 不回归：' + verb + ' 在 coc7 下仍给先攻专属文案（.ri / .init）', /\.ri \/ \.init/.test(h), h.slice(0, 100));
  }
  /* ★ 不回归：C1 的 .sc 在别的规则下仍走 COC 通用提示，且不被先攻文案蹭用 */
  const scHtml = htmlOf(diceAll(1, () => run('.sc', mkCtx('dnd5e', COC_CARD))));
  ok('★ 不回归：.sc 在 dnd5e 下仍给 .set rule coc', /\.set rule coc(?!\d)/.test(scHtml), scHtml.slice(0, 100));
  ok('★ 不回归：.sc 在 dnd5e 下不写 .ri / .init', !/\.ri \/ \.init/.test(scHtml));
}

console.log('== C-3 · 完全等价 .r 1d20 ＋ 固定提示（Q4：避开 ASCII 尖括号） ==');
{
  for(const rule of ['dnd5e','dnd5r']){
    const a = diceAll(1, () => run('.ds', mkCtx(rule, CARD)));
    const b = diceAll(1, () => run('.r 1d20', mkCtx(rule, CARD)));
    const va = viewOf(a), vb = viewOf(b);
    ok('★ ' + rule + ' 下 .ds 产出 roll 消息', kindOf(a) === 'roll', kindOf(a));
    ok('★ ' + rule + ' 下 .r 1d20 仍是 roll（等价参照）', kindOf(b) === 'roll', kindOf(b));
    /* 等价只取骰点事实：title / notes 是 C2 特有的元信息，单独断言 */
    const fa = va ? {ruleKey:va.ruleKey, mode:va.mode, groups:va.groups, comps:va.comps,
      diceSum:va.diceSum, add:va.add, total:va.total, dc:va.dc, dcLabel:va.dcLabel,
      verdict:va.verdict, natBadge:va.natBadge, natNote:va.natNote} : null;
    const fb = vb ? {ruleKey:vb.ruleKey, mode:vb.mode, groups:vb.groups, comps:vb.comps,
      diceSum:vb.diceSum, add:vb.add, total:vb.total, dc:vb.dc, dcLabel:vb.dcLabel,
      verdict:vb.verdict, natBadge:vb.natBadge, natNote:vb.natNote} : null;
    ok('★ ' + rule + ' 下骰点事实与 .r 1d20 逐字段等价（dc / verdict / nat / groups / total）',
      !!fa && !!fb && JSON.stringify(fa) === JSON.stringify(fb), JSON.stringify(fa).slice(0, 130));
    eq('★ ' + rule + ' 下 title = 死亡豁免', va && va.title, '死亡豁免');
    eq('★ ' + rule + ' 下 .r 1d20 title = 掷骰 1d20（对照）', vb && vb.title, '掷骰 1d20');
    eq('★ ' + rule + ' 下 dc = null（不设难度）', va && va.dc, null);
    eq('★ ' + rule + ' 下 verdict = null（不做判定）', va && va.verdict, null);
    eq('★ ' + rule + ' 下 comps 为空（不加调整项）', va && JSON.stringify(va.comps), '[]');
    eq('★ ' + rule + ' 下 mode = null', va && va.mode, null);
    ok('★ ' + rule + ' 下 groups 恰一颗 d20', !!va && va.groups.length === 1 && va.groups[0].sides === 20);
    const note = va && Array.isArray(va.notes) ? String(va.notes[0] || '') : '';
    eq('★ ' + rule + ' 下 notes 恰 1 条固定提示', va && (va.notes || []).length, 1);
    ok('★ ' + rule + ' 下提示含 ≥ 10 记一次成功', note.includes('≥ 10 记一次成功'), note);
    ok('★ ' + rule + ' 下提示含「低于 10 记一次失败」（语义等价改写）', note.includes('低于 10 记一次失败'), note);
    ok('★ ' + rule + ' 下提示含「自然 1 计两次失败」', note.includes('自然 1 计两次失败'), note);
    ok('★ ' + rule + ' 下提示含「自然 20 可回复 1 HP」', note.includes('自然 20 可回复 1 HP'), note);
    ok('★ ' + rule + ' 下提示不含 ASCII「<」（#58 同型：notes 不 esc 会被吞）', !note.includes('<'), note);
    ok('★ ' + rule + ' 下提示不含 &lt; 实体（Markdown 战报会露出实体字面）', !note.includes('&lt;'), note);
    const html = rollHtml(a);
    ok('★ ' + rule + ' 下 renderRoll 之后 HTML 含完整「低于 10 记一次失败」', html.includes('低于 10 记一次失败'), html.slice(-160));
    ok('★ ' + rule + ' 下 renderRoll 之后 HTML 含「自然 20 可回复 1 HP」', html.includes('自然 20 可回复 1 HP'));
    ok('★ ' + rule + ' 下 renderRoll 之后 HTML 不含「< 10」', !html.includes('< 10'), html.slice(-160));
    ok('★ ' + rule + ' 下 roll payload 过协议白名单（零新字段 / 零新 kind）',
      checkPayload(KIND.ROLL, {title:va && va.title, mode:va && va.mode, groups:va && va.groups,
        comps:va && va.comps, dc:va && va.dc, notes:va && va.notes}) === null);
  }
  eq('★ KINDS 仍是 6 种（不新增消息 kind）', KINDS.length, 6);
  const before = JSON.stringify(CARD.data);
  const ctx = mkCtx('dnd5e', CARD);
  const r = diceAll(1, () => run('.ds', ctx));
  eq('★ 卡 data 一字未改（不改 HP、不记数）', JSON.stringify(ctx.card.data), before);
  eq('★ room.rule 未变', ctx.room.rule, 'dnd5e');
  ok('★ 成功路径无 sys / notice 消息（规则文字只是提示，不落留痕）',
    !(r.msgs || []).some(x => x.kind === 'sys' || x.kind === 'notice'));
  /* ★ 战报通道：render-md.js 把 notes 原样写进 Markdown（静态锁，不抄生产逻辑） */
  ok('★ render-md.js 仍把 view.notes 原样写进战报', /v\.notes/.test(strip(read('packages/engine/src/render-md.js'))));
}

console.log('== C-4 · 参数边界（I·1 第 15 条：不做 .ds stat / 不静默忽略） ==');
{
  for(const text of ['.ds stat','.ds +1','.ds adv','.死豁成功','.死亡豁免 3','.ds 1d20']){
    const r = diceAll(1, () => run(text, mkCtx('dnd5e', CARD)));
    ok('★ 「' + text + '」显式报错（notice）', kindOf(r) === 'notice', kindOf(r));
    ok('★ 「' + text + '」不产出 roll（不静默掷骰）', !viewOf(r));
  }
  const h = htmlOf(diceAll(1, () => run('.ds stat', mkCtx('dnd5e', CARD))));
  ok('★ 报错写明「不接受参数」', /不接受参数/.test(h), h.slice(0, 120));
  ok('★ 报错写明「不记数、不改 HP」', /不记数/.test(h) && /不改 HP/.test(h), h.slice(0, 120));
}

console.log('== C-5 · .help dnd 段（Q4 对称补齐 / #58 呈现） ==');
{
  for(const key of ['dnd','dnd5r']){
    const r = run('.help ' + key, mkCtx('dnd5e', null));
    const h = htmlOf(r);       // = renderDefs(defs) 之后的 HTML
    ok('★ .help ' + key + ' 追加「死亡豁免」段', h.includes(DS_HINT));
    for(const s of ['.ds / .死亡豁免 / .死豁','固定提示','只给提示、不改状态','不接参数',
                    '可用性','.set rule dnd','1d20','≥ 10 记一次成功','低于 10 记一次失败']){
      ok('★ .help ' + key + ' 呈现后 HTML 含「' + s + '」', h.includes(s));
    }
    ok('★ .help ' + key + ' 不含 ASCII「< 10」/「<N>」吞字字面', !/< 10/.test(h) && !/<N>/.test(h));
    ok('★ .help ' + key + ' 仍是结构化 html / defs 说明（不空气泡）', kindOf(r) === 'html' && !!defsOf(r).sections.length);
    ok('★ .help ' + key + ' 既有段仍在（属性生成 / 先攻 · 录入 / 三条必须知道）',
      /属性生成/.test(h) && /先攻 · 录入/.test(h) && /三条必须知道/.test(h));
  }
  /* ★ 帮助页文字与气泡固定提示必须逐字一致（两处字面，用精确比对防漂移） */
  const helpRows = (Engine.HELP_BODY && Engine.HELP_BODY.dnd5e ? Engine.HELP_BODY.dnd5e().sections : []) || [];
  const seg = helpRows.find(s => s && s.h && s.h.includes('死亡豁免'));
  const helpNote = (seg && (seg.rows || []).find(x => x && x.k === '固定提示') || {}).v || '';
  const viewNote = (() => { const v = viewOf(diceAll(1, () => run('.ds', mkCtx('dnd5e', CARD)))); return (v && v.notes && v.notes[0]) || ''; })();
  ok('★ 帮助页固定提示与气泡 notes[0] 逐字一致（不漂移）', !!helpNote && helpNote === viewNote,
    'help=' + helpNote + ' | view=' + viewNote);
  const dnd5e = JSON.stringify((Engine.HELP_BODY && Engine.HELP_BODY.dnd5e) ? Engine.HELP_BODY.dnd5e() : null);
  const dnd5r = JSON.stringify((Engine.HELP_BODY && Engine.HELP_BODY.dnd5r) ? Engine.HELP_BODY.dnd5r() : null);
  ok('★ dnd5e 与 dnd5r 共用 helpDnd（两页逐字节相同）', !!dnd5e && dnd5e === dnd5r);
  const coc = htmlOf(run('.help coc', mkCtx('coc7', null)));
  ok('★ 不回归：.help coc 的 C1「理智检定」段仍在', /理智检定/.test(coc));
}

console.log('== C-6 · 零协议 / 零 Worker / 零 schema / 零前端（I·1 / E2 / §0.5 第 11 条） ==');
{
  const core = strip(read('apps/worker/src/core.js'));
  const init = strip(read('apps/worker/src/initiative.js'));
  const schema = strip(read('apps/worker/src/schema.sql'));
  const frame = strip(read('apps/web/src/frame-route.js'));
  const cmd = strip(read('packages/engine/src/cmd.js'));
  const dnd = strip(read('packages/engine/src/pack_dnd.js'));
  ok('★ core.apply 仍只按 INIT_VERBS 分流', /INIT_VERBS\.has\(pc\.verb\)/.test(core));
  ok('★ INIT_VERBS 仍恰为 ri / init（ds 不进 Worker 状态层）',
    /INIT_VERBS\s*=\s*new Set\(\[\s*'ri',\s*'init'\s*\]\)/.test(init));
  ok('★ initiative.js 未出现 ds（零 Worker 改动）', !/\bds\b/.test(init));
  ok('★ schema 不含 total_joins 列（B3）', !/total_joins/.test(schema));
  ok('★ frame-route 未登记 INIT / GEN / KIND 帧（E1）', !/OUT\.(INIT|GEN|KIND)/.test(frame));
  ok('★ COC_PACK.verbs.sc 仍是函数（C1 计算型动词不回退）',
    typeof ((Engine.COC_PACK || {}).verbs || {}).sc === 'function');
  ok('★ DND_PACK.verbs 恰为 ds / init / ri：ri / init 状态型、ds 计算型', (() => {
    const v = (Engine.DND_PACK || {}).verbs || {};
    return Object.keys(v).sort().join(',') === 'ds,init,ri' &&
      v.ri.kind === 'state' && v.init.kind === 'state' && typeof v.ds === 'function';
  })());
  ok('★ 五个包必选契约字段未增补（verbs 为可选，不改 pack-contract.js）',
    /export \{ PACK_FIELDS, CONDITIONAL_FIELDS \}/.test(read('packages/engine/src/pack-contract.js')));
  /* ★ C2 评估发现：ownerNote 只给状态型声明，否则 .ds 会被写成先攻文案 */
  ok('★ cmd.js 的 !fn 分支有「decl.kind === state」守卫（先攻文案不蹭计算型动词）',
    /decl\.kind\s*===\s*'state'/.test(cmd), 'cmd.js !fn');
  ok('★ pack_dnd.js 零新增 import（复用现成掷骰链，静态资源自检 241 不变）',
    (dnd.match(/^import /gm) || []).length === 10);
  ok('★ cmd.js 未新增 ds 专属分支（沿用 verbOwner → pack.verbs[verb] 单一路径）',
    !/verb\s*===\s*'ds'/.test(cmd));
  ok('★ VERBS 只多出 ds 一个动词（21 = C1 的 20 + 1）', Engine.VERBS.size === 21 && Engine.VERBS.has('ds'));
  ok('★ view 无成功 / 失败计数字段（不记数、不改 HP）', (() => {
    const v = viewOf(diceAll(1, () => run('.ds', mkCtx('dnd5e', CARD)))) || {};
    return !('success' in v) && !('fail' in v) && !('hp' in v);
  })());
}

console.log('== C-7 · 既有模块未被 C2 回退（向后比对） ==');
{
  eq('★ .先攻 → ri 仍成立', (Engine.parseCommand('.先攻 +2') || {}).verb, 'ri');
  eq('★ .先攻表 → init 仍成立', (Engine.parseCommand('.先攻表') || {}).verb, 'init');
  eq('★ .理智 → sc 仍成立（C1 不回退）', (Engine.parseCommand('.理智') || {}).verb, 'sc');
  eq('★ 。理智 → sc 仍成立（中文句号口径）', (Engine.parseCommand('。理智') || {}).verb, 'sc');
  ok('★ .sc 与 .rc 理智 仍逐字段等价（C1 等价链）', (() => {
    const a = diceAll(1, () => run('.sc', mkCtx('coc7', COC_CARD)));
    const b = diceAll(1, () => run('.rc 理智', mkCtx('coc7', COC_CARD)));
    return !!viewOf(a) && !!viewOf(b) && JSON.stringify(pick(viewOf(a))) === JSON.stringify(pick(viewOf(b)));
  })());
  for(const [name, card] of [['有卡', COC_CARD], ['无卡', null]]){
    const foot = defsOf(run('.rc list', mkCtx('coc7', card))).foot || [];
    ok('★ .rc list ' + name + '路径仍有 C1 提示', foot.some(f => String(f).includes(C1_HINT)));
  }
  eq('★ .coc 仍可解析（模块 A 未回退）', (Engine.parseCommand('.coc 2') || {}).verb, 'coc');
  eq('★ .dnd 仍可解析（模块 A 未回退）', (Engine.parseCommand('.dnd 2') || {}).verb, 'dnd');
  eq('★ 规则包注册点仍为 6', Object.keys(Engine.RULE_PACKS || {}).length, 6);
  ok('★ GEN_SPEC 仍恰为 coc / dnd', Object.keys(Engine.GEN_SPEC || {}).sort().join(',') === 'coc,dnd');
  eq('★ .r 4d6k3 仍被拒绝（生成器内部弃最低不泄漏）', Engine.parseExpr('4d6k3').ok, false);
}

console.log('---------------------------');
console.log('模块 C · C2 验收：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

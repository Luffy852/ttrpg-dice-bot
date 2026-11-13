/* ============================================================================
 * test_gen_runtime.mjs —— S2 模块 A · A2「运行时接线」端到端验收（真 ESM 路）
 * ----------------------------------------------------------------------------
 * 对应 v11 附录 I·2.7 九条验收。与 A1 的 test_gen_attrs.mjs 分工：
 *   A1 = 生成器数据层（直接调 genAttrs / genCocGroup / rollDndGroup）；
 *   A2 = 指令链路（Engine.handleCommand('.coc' / '.dnd', ctx) 跑到底），
 *        验动词注册、六规则无关性、消息通道、帮助页、写卡链路、零协议改动。
 * 不抄生产逻辑：所有输出都从真实 handleCommand 取。
 * 随机源一律 Engine.RNG.die（可注入固定序列），try/finally 恢复。
 * ★ 全程防御式取值：接线未落时「成片变红、每条可读」，不在第 3 段就 TypeError 崩掉。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as Engine from '../packages/engine/src/index.js';
import { checkPayload, KIND, KINDS, LIMITS } from '../packages/protocol/src/payload.js';
import { renderBattleMd } from '../packages/engine/src/render-md.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* ★ 与 tools/check-engine-split.js 同款：源码级断言先剥注释再扫代码（A1 首轮假红的教训） */
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
const cmdCode  = () => strip(read('packages/engine/src/cmd.js'));
const cardCode = () => strip(read('packages/engine/src/card.js'));

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };
const eq = (n, a, b) => ok(n, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));

const ORIG = Engine.RNG.die;
/** 注入固定 d6 序列；耗尽后恒定 1（20 组这类长跑） */
function dice(seq, fn){
  let i = 0;
  Engine.RNG.die = () => { const v = seq[i++]; return v === undefined ? 1 : v; };
  try{ return fn(); } finally{ Engine.RNG.die = ORIG; }
}
const diceAll = (v, fn) => dice(new Array(600).fill(v), fn);

/** 与 test_engine.js 的 mkCtx 同形（服务端权威昵称 + 纯引擎 room） */
const mkCtx = (rule, card, me) => {
  const c = {me:me || '老王', room:Engine.makeRoom(), card:card || null, history:[]};
  if(rule) c.room.rule = rule;
  return c;
};
/** 跑一条指令，返回 {msgs, handled} */
const run = (text, ctx) => Engine.handleCommand(text, ctx);
/** 取首条骰娘回复；接线未落时返回空壳，让每条断言各自变红而不是中途崩 */
const first = r => (r && r.msgs && r.msgs[0]) || null;
const defsOf = r => { const m = first(r); return (m && m.defs) || {title:'', rows:[], foot:[]}; };
const rowsOf = r => { const d = defsOf(r); return Array.isArray(d.rows) ? d.rows : []; };
const rowV  = (r, i) => { const x = rowsOf(r)[i]; return x && x.v != null ? x.v : ''; };
const rowK  = (r, i) => { const x = rowsOf(r)[i]; return x && x.k != null ? x.k : ''; };
const htmlOf = r => { const m = first(r); return (m && m.html) || ''; };
const kindOf = r => { const m = first(r); return m && m.kind ? m.kind : '（无消息）'; };

console.log('== A2·1 动词注册 / 冲突 / 与规则域并存 ==');
{
  const p = Engine.parseCommand('.coc 3');
  eq('★ parseCommand(.coc 3) → verb=coc', p && p.verb, 'coc');
  eq('★ parseCommand(.coc 3) → rest=3', p && p.rest, '3');
  eq('★ .DND 大小写不敏感', (() => { const q = Engine.parseCommand('.DND'); return q && q.verb; })(), 'dnd');
  eq('★ 裸 .coc 命中', (() => { const q = Engine.parseCommand('.coc'); return q && q.verb; })(), 'coc');
  eq('★ 无中文别名（.生成 不命中、降级聊天）', Engine.parseCommand('.生成 属性'), null);
  eq('★ 未命中动词仍降级为聊天', Engine.parseCommand('.xyz'), null);
  eq('★ VERBS 集合 17→19', Engine.VERBS.size, 19);
  ok('★ VERBS 含 coc / dnd', Engine.VERBS.has('coc') && Engine.VERBS.has('dnd'));
  eq('★ 别名域零冲突', Engine.ALIAS.conflicts.length, 0);
  eq('★ verb 域 coc / dnd 已注册',
    (Engine.lookupAlias('verb','coc') || {}).key + '/' + (Engine.lookupAlias('verb','dnd') || {}).key, 'coc/dnd');
  eq('★ detectConflicts 对这两条返回空',
    Engine.detectConflicts('verb', [{key:'coc', aliases:['coc']}, {key:'dnd', aliases:['dnd']}]).length, 0);
  eq('★ verbOwner(coc/dnd) 为 null（不被规则专属分支拦截）',
    Engine.verbOwner('coc') + '/' + Engine.verbOwner('dnd'), 'null/null');
  eq('★ .set rule coc 与 .coc 并存：coc 仍是 rule 域别名', Engine.normalizeRule('coc'), 'coc7');
  eq('★ .set rule dnd 与 .dnd 并存：dnd 仍是 rule 域别名', Engine.normalizeRule('dnd'), 'dnd5e');
  eq('★ .r 4d6k3 仍被拒绝（弃最低不向通用语法泄漏）', Engine.parseExpr('4d6k3').ok, false);
  eq('★ .r 4d6kh3 仍被拒绝', Engine.parseExpr('4d6kh3').ok, false);
  eq('★ 六规则注册点仍是 6', Object.keys(Engine.RULE_PACKS).length, 6);
}

console.log('== A2·2 六规则下可执行且输出不随 room.rule 变化（I·2.7 第 1 条） ==');
{
  const RULES = ['generic','dnd5e','dnd5r','coc7','dh','fu'];
  for(const verb of ['coc','dnd']){
    const shots = RULES.map(rule => {
      const r = diceAll(3, () => run('.' + verb + ' 2', mkCtx(rule)));
      const m = first(r);
      return {handled:r && r.handled, kind:kindOf(r),
              hasDefs:!!(m && m.defs), hasHtml:!!(m && m.html),
              defs:m && m.defs ? JSON.stringify(m.defs) : null};
    });
    ok('★ .' + verb + ' 2 六规则都 handled=true', shots.every(s => s.handled === true),
      JSON.stringify(shots.map(s => s.handled)));
    ok('★ .' + verb + ' 2 六规则都回 html 消息', shots.every(s => s.kind === KIND.HTML));
    ok('★ .' + verb + ' 2 六规则都带 defs 与 html 两个字段（不空气泡）',
      shots.every(s => s.hasDefs && s.hasHtml));
    ok('★ .' + verb + ' 2 六规则 defs 逐字节相同（不随 room.rule 变化）',
      shots.every(s => s.defs && s.defs === shots[0].defs));
  }
  /* 切规则前后同一条指令产出相同；切规则本身仍正常 */
  const ctx = mkCtx('generic');
  const before = diceAll(3, () => run('.coc', ctx));
  run('.set rule coc', ctx);
  eq('★ .set rule coc 后房间规则确为 coc7', ctx.room.rule, 'coc7');
  const after = diceAll(3, () => run('.coc', ctx));
  eq('★ 切规则前后 .coc 的 defs 完全相同',
    JSON.stringify(defsOf(before)), JSON.stringify(defsOf(after)));
}

console.log('== A2·3 运行时输出规格（I·2.7 第 3 / 5 / 8 条） ==');
{
  const coc1 = diceAll(3, () => run('.coc', mkCtx('generic')));
  eq('★ .coc 回 1 条 html 消息', kindOf(coc1), KIND.HTML);
  eq('★ .coc 1 组 = 2 行 rows', rowsOf(coc1).length, 2);
  eq('★ 标题', defsOf(coc1).title, '🎲 COC 7th 随机属性');
  const coc20 = diceAll(3, () => run('.coc 20', mkCtx('generic')));
  eq('★ .coc 20 = 40 行 rows（单条消息，不拆条）', rowsOf(coc20).length, 40);
  const shown = rowV(coc1, 0), copy = rowV(coc1, 1);
  ok('★ COC 展示行含九个属性名与两个总和',
    /力量:\d+ 体质:\d+ 体型:\d+ 敏捷:\d+ 外貌:\d+ 智力:\d+ 意志:\d+ 教育:\d+ \| 幸运:\d+ ➔ 总和 \d+ \/ 不含幸运 \d+/.test(shown), shown);
  ok('★ COC 可复制行是纯「名字 空格 数值」', /^复制写卡：\.st set (力量|体质) \d+( [^:|]+ \d+){8}$/.test(copy), copy);
  ok('★ 展示行 / 可复制行分离（展示行带冒号与 |，可复制行没有）',
    /:/.test(shown) && /\|/.test(shown) && !/[:|]/.test(copy.replace('复制写卡：','')));

  const dnd1 = diceAll(3, () => run('.dnd', mkCtx('generic')));
  eq('★ .dnd 标题', defsOf(dnd1).title, '🎲 DND 随机属性');
  eq('★ .dnd 裸命令 = 标准数组首行 + 1 组', rowsOf(dnd1).length, 2);
  eq('★ 首行恒为标准数组', rowV(dnd1, 0), '[总分: 72] ➔ 15, 14, 13, 12, 10, 08');
  eq('★ 首行 k', rowK(dnd1, 0), '📋 标准数组');
  const dnd20 = diceAll(3, () => run('.dnd 20', mkCtx('generic')));
  eq('★ .dnd 20 = 21 行（首行 + 20 组）', rowsOf(dnd20).length, 21);
  eq('★ .dnd 20 首行仍是标准数组', rowV(dnd20, 0), '[总分: 72] ➔ 15, 14, 13, 12, 10, 08');
  const dtxt = JSON.stringify(defsOf(dnd20));
  ok('★ DND 每组 6 值降序 / 两位补零 / 合计自洽',
    rowsOf(dnd20).slice(1).every(r => {
      const m = String(r.v || '').match(/^\[总分: (\d+)\] ➔ (.+)$/);
      if(!m) return false;
      const p = m[2].split(', ');
      if(p.length !== 6 || p.some(x => !/^\d{2}$/.test(x))) return false;
      const n = p.map(Number);
      return n.every((v, j) => j === 0 || v <= n[j-1]) && Number(m[1]) === n.reduce((a,b)=>a+b,0);
    }));
  ok('★ DND 不出现属性名 / .st set / 计算原则字样',
    !/力量|敏捷|体质|智力|感知|魅力|\.st set|4d6|弃最低|27\s*点|购点/.test(dtxt));
  const allTxt = JSON.stringify(defsOf(coc20)) + dtxt;
  ok('★ 不含逐骰明细', !/逐骰|骰面|tries|kept|明细/.test(allTxt));
  ok('★ 不含 COC 派生值 / 体格表',
    !/HP|MP|SAN|DB|体格|派生值|伤害加值|年龄|年代修正|6 版|经典变体/.test(allTxt));
  /* ★ A3 真机反馈：第 10 条标记不能是彩色 emoji（Chrome 字体回退 → 蓝底白字方块）。
   *   这里走的是完整 handleCommand 链路，确认接线后 20 组输出同样不退化。 */
  const cocMarks = rowsOf(coc20).filter(r => r.k).map(r => r.k);
  const dndMarks = rowsOf(dnd20).slice(1).map(r => r.k);
  eq('★ 运行时 .coc 20 第 10 条标记 = ⑩', cocMarks[9], '⑩');
  eq('★ 运行时 .dnd 20 第 10 条标记 = ⑩', dndMarks[9], '⑩');
  ok('★ 运行时 40 个标记都不含 emoji 码点',
    cocMarks.concat(dndMarks).every(m => Array.from(m).every(ch => ch.codePointAt(0) < 0x1F000)));
  eq('★ 运行时 COC / DND 组标记逐项相同', cocMarks.join(','), dndMarks.join(','));
}

console.log('== A2·4 组数 N 边界与显式提示（I·2.7 第 6 条） ==');
{
  for(const bad of ['0','21','25','abc','1.5','3 4','-1','1e2']){
    const r = diceAll(3, () => run('.coc ' + bad, mkCtx('generic')));
    eq('★ .coc ' + bad + ' → notice 通道', kindOf(r), KIND.NOTICE);
    ok('★ .coc ' + bad + ' 显式提示「组数 1–20」', /组数 1–20/.test(htmlOf(r)), htmlOf(r));
    ok('★ .coc ' + bad + ' 不产出 defs', !(first(r) && first(r).defs));
  }
  /* ★ NFKC 容错口径（向后比对新增登记）：parseCommand 对整条指令做 normalize('NFKC')，
   *   全角数字「２０」与中文句号「。」是同一套输入法容错 —— 它会被归一成 20 后合法生成，
   *   不是非法值。A1 的 parseGenCount('２０') 拒绝的是「已归一化之后仍带全角」的入参，
   *   两者不矛盾：A1 测生成器入参，A2 测完整指令链路。 */
  eq('★ .coc ２０ 经 NFKC 归一化按 20 组处理（既有前缀容错口径）',
    rowsOf(diceAll(3, () => run('.coc ２０', mkCtx('generic')))).length, 40);
  for(const [txt, rows] of [['.coc', 2], ['.coc 1', 2], ['.coc 20', 40], ['.dnd', 2], ['.DND 20', 21]]){
    const r = diceAll(3, () => run(txt, mkCtx('generic')));
    eq('★ ' + txt + ' → html 通道', kindOf(r), KIND.HTML);
    eq('★ ' + txt + ' rows 数', rowsOf(r).length, rows);
  }
  eq('★ .coc 裸命令 = .coc 1（逐字节）',
    JSON.stringify(defsOf(diceAll(3, () => run('.coc', mkCtx('generic'))))),
    JSON.stringify(defsOf(diceAll(3, () => run('.coc 1', mkCtx('generic'))))));
  eq('★ .dnd 25 也是同一条显式提示',
    htmlOf(diceAll(3, () => run('.dnd 25', mkCtx('generic')))), '组数 1–20');
}

console.log('== A2·5 帮助页（I·2.2 / I·2.6 / I·2.7 第 2 条） ==');
{
  const cocHelp = JSON.stringify(Engine.HELP_BODY.coc7());
  const dnd5e = JSON.stringify(Engine.HELP_BODY.dnd5e());
  const dnd5r = JSON.stringify(Engine.HELP_BODY.dnd5r());
  ok('★ .help coc 含 .coc / 组数 1–20', /\.coc/.test(cocHelp) && /组数 1–20/.test(cocHelp));
  ok('★ .help dnd 含 .dnd / 组数 1–20', /\.dnd/.test(dnd5e) && /组数 1–20/.test(dnd5e));
  eq('★ dnd5e 与 dnd5r 共用 helpDnd（两页逐字节相同）', dnd5e, dnd5r);
  for(const [k, body] of [['generic',JSON.stringify(Engine.HELP_BODY.generic())],
                          ['dnd5e',dnd5e],['dnd5r',dnd5r],['coc7',cocHelp],
                          ['dh',JSON.stringify(Engine.HELP_BODY.dh())],['fu',JSON.stringify(Engine.HELP_BODY.fu())]]){
    ok('★ 规则专属页不含通用别名一览：' + k,
      !/中文别名一览/.test(body) && !/按你想的意思打就行/.test(body));
  }
  ok('★ helpCoc 原有段一字未动（八大属性 / 派生值 / 灵感 / 智力检定 / DB \/ 体格）',
    /八大属性/.test(cocHelp) && /派生值/.test(cocHelp) && /灵感/.test(cocHelp) &&
    /智力检定/.test(cocHelp) && /DB \/ 体格/.test(cocHelp));
  ok('★ helpCoc 仍不含 MOV / 移动速度 / 没拿到', !/MOV|移动速度|没拿到|宁缺毋错|规则书那句/.test(cocHelp));
  ok('★ 六规则帮助页仍是结构化 sections（新段带 rows）',
    ['generic','dnd5e','dnd5r','coc7','dh','fu'].every(k => {
      const d = Engine.HELP_BODY[k]();
      return !!d.title && Array.isArray(d.sections) && d.sections.every(s => Array.isArray(s.rows));
    }));
  ok('★ 新增段不含「4d6 弃最低」等计算原则', !/4d6|弃最低/.test(cocHelp + dnd5e));
  ok('★ 真跑 .help coc 的 html 含 .coc / 组数 1–20',
    /\.coc/.test(htmlOf(run('.help coc', mkCtx('generic')))) &&
    /组数 1–20/.test(htmlOf(run('.help coc', mkCtx('generic')))));
  ok('★ 真跑 .help dnd 的 html 含 .dnd / 组数 1–20',
    /\.dnd/.test(htmlOf(run('.help dnd', mkCtx('generic')))) &&
    /组数 1–20/.test(htmlOf(run('.help dnd', mkCtx('generic')))));

  /* ★ A3 真机反馈（两条）：
   *   ① 板块标题只留「属性生成」，不要「· .coc / .dnd（全局小工具）」后缀；
   *   ② k 写 '<N>' 会被 defsHtml 直接拼进 HTML 当未知标签吞掉 → 只剩 '.coc '，
   *      与第一行重复。故 k 用 '.coc N' / '.dnd N'，且断言必须走 renderDefs 之后的
   *      HTML 字符串（只查结构化数据抓不到「浏览器吞标签」这类问题）。 */
  const secOf = key => (Engine.HELP_BODY[key]().sections || []).find(s => /^属性生成/.test(s.h || '')) || {h:'', rows:[]};
  for(const [key, verb] of [['coc7','coc'], ['dnd5e','dnd'], ['dnd5r','dnd']]){
    const sec = secOf(key);
    eq('★ ' + key + ' 属性生成板块标题恰好是「属性生成」', sec.h, '属性生成');
    const ks = (sec.rows || []).map(r => String(r.k));
    ok('★ ' + key + ' 帮助页 k 不含尖括号（避免 <N> 被 HTML 吞）',
      ks.every(k => !/[<>]/.test(k)), JSON.stringify(ks));
    ok('★ ' + key + ' 帮助页含 .' + verb + ' N 字面', ks.includes('.' + verb + ' N'), JSON.stringify(ks));
  }
  for(const [cmd, verb] of [['.help coc','coc'], ['.help dnd','dnd']]){
    const html = htmlOf(run(cmd, mkCtx('generic')));
    ok('★ 真跑 ' + cmd + ' 的 HTML 板块标题是「属性生成」',
      /<div class="hh">属性生成<\/div>/.test(html), html.slice(0, 120));
    ok('★ 真跑 ' + cmd + ' 的 .' + verb + ' N 真的渲染在 k 列',
      new RegExp('<span class="hk">\\.' + verb + ' N</span>').test(html));
    ok('★ 真跑 ' + cmd + ' 的 HTML 不含 <N> 尖括号写法（防浏览器吞标签、防回退）',
      !html.includes('.' + verb + ' <N>'));
  }
}

console.log('== A2·6 消息流 / 导出 / 体积（I·2.7 第 9 条） ==');
{
  for(const [verb, label] of [['coc','COC'], ['dnd','DND']]){
    const r = diceAll(3, () => run('.' + verb + ' 20', mkCtx('generic')));
    const payload = {defs:defsOf(r)};
    const size = JSON.stringify(payload).length;
    ok('★ 20 组 ' + label + ' 单条 payload < 8KB（' + size + ' B）', size < LIMITS.PAYLOAD, String(size));
    eq('★ 20 组 ' + label + ' 通过 checkPayload(KIND.HTML)', checkPayload(KIND.HTML, payload), null);
    const md = renderBattleMd([
      {id:'123456:1', ts:1772000000000, kind:KIND.HTML, from:'骰娘', actor:'老王', payload}
    ], {code:'123456', rule:'coc7', exportedAt:'2026-11-13'});
    ok('★ 20 组 ' + label + ' 导出 Markdown 可读（标题 + 关键文本）',
      md.includes('🎲') && (md.includes('力量:') || md.includes('总分:')) &&
      !/结构化说明 · 导出用 NDJSON/.test(md));
  }
  const nm = diceAll(3, () => run('.coc 0', mkCtx('generic')));
  eq('★ notice 提示也能通过 checkPayload(KIND.NOTICE)',
    checkPayload(KIND.NOTICE, {html:htmlOf(nm)}), null);
}

console.log('== A2·7 可复制行走完整 .st set 链路（I·2.7 第 4 条） ==');
{
  const r0 = diceAll(3, () => run('.coc', mkCtx('coc7')));
  const copy = String(rowV(r0, 1)).replace(/^复制写卡：/, '');
  const ctx = mkCtx('coc7');
  run('.st set 侦查 60 图书馆 50 力量 10', ctx);   // 先绑一张带技能、含同名属性的卡
  const r = run(copy, ctx);
  eq('★ 贴入 .st set 被 handleCommand 接住', r && r.handled, true);
  const data = (ctx.card && ctx.card.data) || {};
  eq('★ 同名属性被覆盖（力量 = 生成值 45，不是旧值 10）', data['力量'], 45);
  eq('★ 技能不丢：侦查', data['侦查'], 60);
  eq('★ 技能不丢：图书馆', data['图书馆'], 50);
  eq('★ 九个属性全部写进卡', Engine.COC_ATTRS.filter(k => typeof data[k] === 'number').length, 9);
  ok('★ 没有凭空出现派生值字段', ['hp','mp','san','db','体格'].every(k => !(k in data)));
}

console.log('== A2·8 零协议 / 零 Worker 改动 + 源码级（I·2.5 / I·2.7 第 7 条） ==');
{
  const cmd = cmdCode(), card = cardCode();
  ok('★ cmd.js 用一次 GEN_SPEC[verb] 查表', /GEN_SPEC\[verb\]/.test(cmd));
  ok('★ cmd.js 不写 if(verb===\'coc\')… 分规则分支',
    !/verb\s*===\s*'coc'|verb\s*===\s*'dnd'/.test(cmd));
  ok('★ cmd.js 显式 import 两个符号且是干净单行',
    /^import \{ GEN_SPEC, genAttrs \} from '\.\/gen_attrs\.js';$/m.test(cmd));
  ok('★ cmd.js 不 import parseExpr 给生成器用（弃最低不外泄）',
    !/gen_attrs[^\n]*parseExpr/.test(cmd));
  ok('★ card.js verb 域注册 coc / dnd 两条',
    /\{key:'coc'/.test(card) && /\{key:'dnd'/.test(card));
  ok('★ 两条别名无中文',
    !/\{key:'coc',[^\n]*[\u4e00-\u9fff]/.test(card) &&
    !/\{key:'dnd',[^\n]*[\u4e00-\u9fff]/.test(card));
  const core = strip(read('apps/worker/src/core.js'));
  ok('★ core.apply 仍只按 INIT_VERBS 分流（coc/dnd 走 handleCommand）',
    /INIT_VERBS\.has\(pc\.verb\)/.test(core) &&
    !/INIT_VERBS\s*=\s*new Set\(\[[^\]]*'coc'/.test(strip(read('apps/worker/src/initiative.js'))));
  eq('★ 未新增消息 kind（KINDS 仍是 cmd/chat/roll/html/notice/sys 六个）',
    KINDS.slice().sort().join(','), 'chat,cmd,html,notice,roll,sys');
}

console.log('\n模块 A · A2 运行时接线：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

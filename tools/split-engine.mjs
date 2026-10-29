/* ============================================================================
 * split-engine.mjs —— M2 单文件 → M3 packages/engine 的**一次性迁移脚本**
 * ----------------------------------------------------------------------------
 * 【状态】已执行过一次（产物即 packages/engine/src/*）。保留它以备复核：
 *        "拆包是搬文件不是重写"这句话必须能被重跑验证，不能只靠嘴说。
 * 【怎么用】 node tools/split-engine.mjs [M2的html路径]
 * 【它做什么】
 *   1. 从 html 的 ENGINE-START / ENGINE-END 抠出引擎源码
 *   2. 按**作者已有的注释块边界**切成若干段（不是脚本拍脑袋切 —— 作者当初就按模块边界写好了）
 *   3. 静态分析跨段引用 → 自动生成 import / export
 *   4. 应用 3 处解环（见下）
 *   5. 生成 index.js（export 顺序 = 别名注册顺序）
 *
 * 【★ 3 处解环（不加会 TDZ 崩溃，这是真踩过的）】
 *   ① esc / fmtMod → 提成零依赖的 util.js
 *      十几个模块都为两个纯字符串小工具反向依赖 render.js，环的根子在这里。
 *   ② renderCardHtml → 从 render.js 迁入 card.js
 *      render 用 cardMod、card 用 renderCardHtml，互相 import；卡渲染属「卡域」，搬走即单向。
 *   ③ packs.js（注册表）保持单向 import 五个包，任何包不许 import 它
 *      注册表顶层引用 GENERIC_PACK，若被反查就是循环。包内需查别的包 → 调用方注入或上移 cmd.js。
 *
 * 【边界】本脚本只在迁移时用。之后引擎由人维护，改完跑 tools/check-engine-split.js。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const HTML = process.argv[2] || path.join(import.meta.dirname, '..', 'legacy', 'M2_骰娘单机可摸版.html');
const OUT = path.join(import.meta.dirname, '..', 'packages', 'engine', 'src');

const html = fs.readFileSync(HTML, 'utf8');
if (html.indexOf('ENGINE-START') < 0 || html.indexOf('ENGINE-END') < 0) {
  console.error('❌ html 里没有 ENGINE-START / ENGINE-END 标记'); process.exit(1);
}
let code = html.split('ENGINE-START')[1].split('ENGINE-END')[0];
code = code.slice(code.indexOf('*/') + 2);
code = code.slice(0, code.lastIndexOf('/*'));
let src = code.split('\n');
// 尾部若有不完整的注释残片，去掉
for (let i = src.length - 1; i >= src.length - 5 && i >= 0; i--) {
  if (src[i].lstrip === undefined && src[i].trimStart().startsWith('/*')) { src = src.slice(0, i); break; }
}

/* ---------- 解环 ①②：摘出 esc/fmtMod 与 renderCardHtml ---------- */
const at = re => src.findIndex(l => re.test(l));
const iEsc = at(/^function esc\(/), iFmt = at(/^function fmtMod\(/);
if (iEsc < 0 || iFmt !== iEsc + 1) { console.error('❌ esc / fmtMod 不相邻，脚本需同步更新'); process.exit(1); }
const utilLines = [src[iEsc], src[iFmt]];
const iCard = at(/^function renderCardHtml\(/);
if (iCard < 0) { console.error('❌ 找不到 renderCardHtml'); process.exit(1); }
let iCardEnd = iCard; while (!/^}$/.test(src[iCardEnd].trim())) iCardEnd++;
const cardLines = src.slice(iCard, iCardEnd + 1);
// 从原数组中摘掉（先大后小，避免偏移）
src = src.slice(0, iCard).concat(src.slice(iCardEnd + 1));
const iEsc2 = at.call(null, /^function esc\(/);
src = src.slice(0, iEsc).concat(src.slice(iFmt + 1));

/* ---------- 顶层声明 → 行号 ---------- */
const tops = {};
src.forEach((l, i) => { const m = l.match(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/); if (m) tops[m[1]] = i + 1; });

/* ---------- 切分：按作者已有的注释块边界（手工校准过一次，见 RANGES） ---------- */
const anchor = re => src.findIndex(l => re.test(l)) + 1;
const A = {
  rng: anchor(/^const RNG/), alias: anchor(/^function normToken/), rules: anchor(/^const RULE_META/),
  parse: anchor(/^const LIMITS/), roll: anchor(/^function rollOnce/), dnd: anchor(/^const ABIL_KEYS/),
  coc: anchor(/^const COC_SKILLS/), dh: anchor(/^const DH_TRAITS/), fu: anchor(/^const FU_ATTRS/),
  pack_generic: anchor(/^const GENERIC_PACK/), pack_dnd: anchor(/^const DND_PACK/), pack_coc: anchor(/^const COC_PACK/),
  pack_dh: anchor(/^const DH_PACK/), pack_fu: anchor(/^const FU_PACK/), packs: anchor(/^const RULE_PACKS/),
  view: anchor(/^function sumKept/), render: anchor(/^function hasNatSemantics/), help: anchor(/^function helpTop/),
  card: anchor(/^const CARD_KEYS/), cmd: anchor(/^const VERBS/),
};
const ORDER = ['util','rng','alias','rules','parse','roll','dnd','coc','dh','fu','pack_generic','pack_dnd','pack_coc','pack_dh','pack_fu','packs','view','render','help','card','cmd'];
const DESC = {
  util:'纯字符串工具（★解环①：零依赖，切断各模块 → render 的反向依赖）',
  rng:'1 均匀随机源（拒绝采样，消除取模偏差）',
  alias:'1.5 统一别名层（分域 + 冲突登记 + 未识别建议）',
  rules:'2 规则别名（保留点号、精确匹配）/ IMPLEMENTED / 规模上限',
  parse:'3 掷骰表达式解析', roll:'4 掷骰执行（优劣势按规则收敛）',
  dnd:'5 D&D 属性 / 技能表 / 熟练加值 / ★别名域名分桶',
  coc:'5.2 COC 7th 技能表 / 百分骰 rollPercent / 五级判定',
  dh:'5.3 匕首心 六特性 / 四象限判定', fu:'5.4 最终物语 骰阶 / 判定 / 查表',
  pack_generic:'规则包 · 通用', pack_dnd:'规则包 · D&D 5e / 5.5e', pack_coc:'规则包 · COC 7th',
  pack_dh:'规则包 · 匕首心', pack_fu:'规则包 · 最终物语',
  packs:'★ 注册表：单向 import 五个包，任何包不许反查（★解环③）',
  view:'6 唯一求和入口 buildTotal + 判定（派生值全部现场推导）',
  render:'7 渲染：聊天流 / 详情 / 战报三处共用同一函数',
  help:'8 结构化帮助（非纯文本，窄屏分栏）',
  card:'9 角色卡：解析 / 卡名 / 不匹配提示 / 栅格渲染（★解环② renderCardHtml 迁入）',
  cmd:'10 指令分发（★ 主流程不许认识任何具体规则）',
};
const ranges = [];
for (let i = 1; i < ORDER.length; i++) {
  const name = ORDER[i], s = A[name];
  const nextName = ORDER[i + 1];
  const e = nextName ? A[nextName] - 1 : src.length;
  ranges.push([s, e, name]);
}
const owner = {};
for (const [s, e, n] of ranges) for (let v = s; v <= e; v++) owner[v] = n;
const d2m = {}; for (const k in tops) d2m[k] = owner[tops[k]];
const utilExports = [];
for (const l of utilLines) { const m = l.match(/^function\s+([A-Za-z_$][\w$]*)/); if (m) { d2m[m[1]] = 'util'; tops[m[1]] = -1; utilExports.push(m[1]); } }
for (const l of cardLines) { const m = l.match(/^function\s+([A-Za-z_$][\w$]*)/); if (m) d2m[m[1]] = 'card'; }

const stripComments = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
const IDENT = /[A-Za-z_$][\w$]*/g;

function emit(name, text) {
  const used = new Set(stripComments(text).match(IDENT) || []);
  const ext = [...used].filter(x => x in tops && d2m[x] && d2m[x] !== name);
  const mods = [...new Set(ext.map(x => d2m[x]))].sort();
  const imp = mods.map(m => `import { ${ext.filter(x => d2m[x] === m).sort().join(', ')} } from './${m}.js';`).join('\n');
  const local = Object.keys(tops).filter(k => d2m[k] === name && tops[k] !== -1).concat(name === 'util' ? utilExports : []);
  const head = `/* ${name}.js — ${DESC[name]}\n * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。\n */\n`;
  fs.writeFileSync(path.join(OUT, `${name}.js`), head + (imp ? imp + '\n\n' : '') + text.replace(/\s+$/, '') + `\n\nexport { ${local.join(', ')} };\n`);
  return mods;
}

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.js')) fs.unlinkSync(path.join(OUT, f));
const graph = {};
for (const [s, e, n] of ranges) graph[n] = emit(n, src.slice(s - 1, e).join('\n'));
graph.util = emit('util', utilLines.join('\n'));

// card.js：renderCardHtml 迁入 + 改用 util
let c = fs.readFileSync(path.join(OUT, 'card.js'), 'utf8');
c = c.replace(/import \{[^}]*\} from '\.\/render\.js';\n/g, '');
c = c.replace("import { esc } from './util.js';", "import { esc, fmtMod } from './util.js';");
c = c.replace('\nexport {', '\n/* ★ renderCardHtml 从 render.js 迁入（解环②）：render 用 cardMod、card 用 renderCardHtml，\n   曾互相 import。卡渲染属「卡域」，搬来后依赖变为单向 render → card。 */\n'
  + cardLines.join('\n') + '\n\nexport { renderCardHtml, ');
fs.writeFileSync(path.join(OUT, 'card.js'), c);
graph.card = [...new Set([...c.matchAll(/from '\.\/(\w+)\.js'/g)].map(m => m[1]))];

// pack_dnd 需要 renderCardHtml
let pd = fs.readFileSync(path.join(OUT, 'pack_dnd.js'), 'utf8');
pd = pd.replace(/import \{ ([^}]*) \} from '\.\/card\.js';/, (m, g) => `import { ${g}, renderCardHtml } from './card.js';`);
fs.writeFileSync(path.join(OUT, 'pack_dnd.js'), pd);

fs.writeFileSync(path.join(OUT, 'index.js'),
  `/* index.js — 引擎唯一入口（浏览器与 Worker 共用这一份）。\n`
  + ` * ★ export 顺序 = 别名注册顺序，不可随意调整：ESM 下模块求值顺序 = import 顺序，\n`
  + ` *   而 registerAliases() 是「先到先得」——顺序变了会让某个别名被别的包静默抢走。\n`
  + ` *   tools/check-engine-split.js 第 5 项守着这条。\n */\n`
  + ORDER.map(n => `export * from './${n}.js';`).join('\n') + '\n');

// 环检测
const color = {}; const cycles = [];
const dfs = (n, stack) => {
  color[n] = 1; stack.push(n);
  for (const m of graph[n] || []) {
    if (color[m] === 1) cycles.push([...stack.slice(stack.indexOf(m)), m].join(' → '));
    else if (!color[m]) dfs(m, stack);
  }
  stack.pop(); color[n] = 2;
};
for (const n of Object.keys(graph)) if (!color[n]) dfs(n, []);
console.log('模块数：', ORDER.length, '｜循环依赖：', cycles.length ? '❌ ' + cycles.join(' / ') : '无 ✅');
console.log('已生成到', OUT);

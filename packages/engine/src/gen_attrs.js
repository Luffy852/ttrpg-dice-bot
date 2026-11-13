/* gen_attrs.js — S2 模块 A · 属性生成（A1：纯生成器层，不接运行时）
 * ----------------------------------------------------------------------------
 * 【定位】独立小工具：只生成数值串供玩家自行复制到 .st；不读卡、不写卡、不改房间状态。
 *   本包**只提供生成器与 html.defs 结构化说明**；verb 域注册 / cmd.js 分发 / 帮助页
 *   留到 A2。运行时入口 genAttrs(verb, rest) 的返回形状已经按 A2 接线定死。
 *
 * 【为什么不绑 room.rule】I·2.1：绑规则会迫使车卡前先 .set rule，而切规则要 @全体
 *   显著广播。所以输出完全不依赖房间规则，与规则包的耦合只有静态数据引用
 *   （COC_ATTRS / DND_STANDARD_ARRAY），不调用任何规则包行为接口。
 *
 * 【数据归属】COC 属性顺序直接取自 coc.js 的 COC_ATTRS（与 .st 模板逐项一致）；
 *   DND 标准数组是全新常量，只放 dnd.js 一处；主流程一次 GEN_SPEC[verb] 查表，
 *   不写 if(verb==='coc')…else if(verb==='dnd')… 分规则分支。
 *
 * 【随机源】一律 RNG.die(6)（crypto.getRandomValues 经 rng.js 拒绝采样），
 *   不碰 Math.random；可被测试注入固定序列。引擎零 DOM / 零 Node API。
 * ========================================================================== */
import { COC_ATTRS } from './coc.js';
import { DND_STANDARD_ARRAY } from './dnd.js';
import { RNG } from './rng.js';

const GEN_LIMIT = 20;
const GEN_BAD_COUNT = '组数 1–20';

const COC_BASE = COC_ATTRS.slice(0, 8);   // 八项基础属性（展示行）
const COC_LUCK = COC_ATTRS[8];            // 幸运单列（展示行）/ 第九项（可复制行）

/* 7 版基础公式：三骰×5 与 (二骰+6)×5。键取自 COC_ATTRS，不另写一份属性名数据。
 * COC 派生值（HP / MP / SAN 初始 / DB / 体格）一个都不产出。 */
const COC_FORMULA = {
  '力量':'3d6', '体质':'3d6', '体型':'2d6+6', '敏捷':'3d6', '外貌':'3d6',
  '智力':'2d6+6', '意志':'3d6', '教育':'2d6+6', '幸运':'3d6'
};

/** 裸命令 = 1 组；非法一律 null（调用方给显式提示，绝不静默截断 / 兜底成 1） */
function parseGenCount(rest){
  const s = String(rest == null ? '' : rest).trim();
  if(!s) return 1;
  if(!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return (n >= 1 && n <= GEN_LIMIT) ? n : null;
}

function rollCoc(formula){
  if(formula === '3d6') return (RNG.die(6) + RNG.die(6) + RNG.die(6)) * 5;
  return (RNG.die(6) + RNG.die(6) + 6) * 5;
}

function genCocGroup(){
  const out = {};
  for(const k of COC_ATTRS) out[k] = rollCoc(COC_FORMULA[k]);
  return out;
}

/* 组标记：1–9 用示例的 keycap，10–20 用带圈数字 ⑩–⑳（U+2469..U+2473 连续同族）。
 * ★ A3 真机反馈：第 10 条原用 🔟（U+1F51F 彩色 emoji），Chrome 会走 emoji 字体回退、
 *   无视 .hk 的 monospace / color CSS，渲染成蓝底白字方块，与其余 19 条明显不一致。
 *   改用 ⑩ 后与 ⑪–⑳ 同字体族，1–9 / 11–20 的既有视觉保持不动。
 * 由代码生成，不手写 20 项数据表。 */
function groupMark(i){
  if(i <= 9) return String(i) + '\u20E3';
  if(i === 10) return '\u2469';
  return String.fromCodePoint(0x246A + i - 11);
}

/* 展示行 + 可复制行分离：.st set 只认「名字 空格 数值」，故单独给一行纯文本。
 * 该行仅为提示，骰娘不代发、不二次解析。 */
function buildCocRows(n){
  const rows = [];
  for(let i = 1; i <= n; i++){
    const g = genCocGroup();
    const base = COC_BASE.map(k => g[k]);
    const luck = g[COC_LUCK];
    const sumBase = base.reduce((a, b) => a + b, 0);
    const sumAll = sumBase + luck;
    rows.push({k:groupMark(i), v:COC_BASE.map((k, j) => k + ':' + base[j]).join(' ') +
      ' | 幸运:' + luck + ' ➔ 总和 ' + sumAll + ' / 不含幸运 ' + sumBase});
    rows.push({k:'', v:'复制写卡：.st set ' + COC_ATTRS.map(k => k + ' ' + g[k]).join(' ')});
  }
  return rows;
}

function pad2(v){ return String(v).padStart(2, '0'); }

/* 4d6 drop-lowest ×6：投四取高三颗之和，产出 6 个降序两位数（补零）。
 * 只在生成器内部实现，不进 parseExpr / .r；玩家可见输出不披露计算原则。 */
function rollDndGroup(){
  const vals = [];
  for(let i = 0; i < 6; i++){
    const d = [RNG.die(6), RNG.die(6), RNG.die(6), RNG.die(6)].sort((a, b) => a - b);
    vals.push(d[1] + d[2] + d[3]);
  }
  return vals.sort((a, b) => b - a);
}

/* 每次回复首行恒为标准数组（I·2.4 把它做成消息回复格式的一部分） */
function buildDndRows(n){
  const std = DND_STANDARD_ARRAY;
  const rows = [{k:'📋 标准数组', v:'[总分: ' + std.reduce((a, b) => a + b, 0) + '] ➔ ' + std.map(pad2).join(', ')}];
  for(let i = 1; i <= n; i++){
    const vals = rollDndGroup();
    rows.push({k:groupMark(i), v:'[总分: ' + vals.reduce((a, b) => a + b, 0) + '] ➔ ' + vals.map(pad2).join(', ')});
  }
  return rows;
}

/* 唯一查表：title 只在此处维护，foot 只在 genAttrs 组装一次（横切决策不落两处） */
const GEN_SPEC = {
  coc:{title:'🎲 COC 7th 随机属性', build:buildCocRows},
  dnd:{title:'🎲 DND 随机属性',       build:buildDndRows}
};

/** A2 接线形态：const g = genAttrs(verb, rest); if(g.notice) notice(g.notice); else defs(g.defs); */
function genAttrs(verb, rest){
  const n = parseGenCount(rest);
  if(n === null) return {notice:GEN_BAD_COUNT};
  const spec = GEN_SPEC[verb];
  if(!spec) return {notice:GEN_BAD_COUNT};   // 仅防御：A2 只会传 coc / dnd
  return {defs:{title:spec.title, rows:spec.build(n), foot:[]}};
}

export { GEN_SPEC, GEN_BAD_COUNT, parseGenCount, genAttrs, genCocGroup, rollDndGroup };

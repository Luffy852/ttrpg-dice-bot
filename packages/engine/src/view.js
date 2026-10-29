/* view.js — 6 唯一求和入口 buildTotal + 判定（派生值全部现场推导）
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { sumArr } from './roll.js';

function sumKept(groups){
  let s = 0;
  groups.forEach(g => { s += g.sign * sumArr(g.kept); });
  return s;
}
// total 的唯一出处：骰点 + 有序组件表，杜绝"有时进 mod 有时进 check"的双口径
function buildTotal(diceSum, comps){
  const add = comps.reduce((a, c) => a + c.v, 0);
  return {diceSum, add, total: diceSum + add};
}
// nat：只认"单个 d20"，取最终采用的那一颗
function natOf(groups, diceSum){
  if(groups.length !== 1) return null;
  const g = groups[0];
  if(g.sides !== 20 || g.n !== 1 || g.sign !== 1) return null;
  return g.kept[0];
}
// D&D 判定：唯一一套规则差异在这里（5e 与 5.5e 的 nat 语义）
function judgeDnd(total, dc, nat, ruleKey){
  if(ruleKey === 'dnd5r'){
    if(nat === 20) return {ok:true,  text:'大成功（5.5e：掷 20 即成功）', crit:true, force:true};
    if(nat === 1)  return {ok:false, text:'大失败（5.5e：掷 1 即失败）',  crit:true, force:true};
  }
  if(dc == null) return {ok:null, text:'未指定难度'};
  const d = total - dc;
  return {ok:d >= 0, text:(d >= 0 ? '成功（超出 ' + d + '）' : '失败（差 ' + (-d) + '）')};
}
// nat 语义表：d20 的 20 / 1 在**各套规则里含义不同**，必须按规则分别写死。
// 之前只写了 5e 那一支，导致 5.5e 静默、通用规则却冒出 5e 的文案（真机反馈）。
const NAT_MARK = {
  dnd5r: {
    20:{icon:'✨', cls:'crit',     short:'掷 20 · 5.5e 即成功', long:'✨ 掷出 20 —— 5.5e（2024）：掷 20 即成功，对所有 d20 检定生效'},
    1 :{icon:'💀', cls:'critfail', short:'掷 1 · 5.5e 即失败',  long:'💀 掷出 1 —— 5.5e（2024）：掷 1 即失败，对所有 d20 检定生效'}
  },
  dnd5e: {
    20:{icon:'⚡', cls:'mid', short:'掷 20 · 5e 不自动成功', long:'⚡ 掷出 20 —— 5e：技能/属性检定不自动成功，结果照常计算（仅攻击检定与死亡豁免必中）'},
    1 :{icon:'⚡', cls:'mid', short:'掷 1 · 5e 不自动失败',  long:'⚡ 掷出 1 —— 5e：技能/属性检定不自动失败，结果照常计算（仅攻击检定与死亡豁免必败）'}
  }
};
// 返回 {badge:{icon,cls,short}, note} —— badge 进折叠行，note 进展开区。
// ★ 非 D&D 规则（通用 / COC / DH / FU）直接返回 null：既不高亮也不加注。
//   之前"标黄 + 再加一句没有特殊语义"是双重噪音 —— 没有意义的东西就不要提。
function natMarkOf(nat, ruleKey){
  if(nat !== 20 && nat !== 1) return null;
  const t = NAT_MARK[ruleKey];
  if(!t) return null;
  const m = t[nat];
  if(!m) return null;
  return {badge:{icon:m.icon, cls:m.cls, text:m.short}, note:m.long};
}
// 兼容旧调用（.rc 路径）
function natNoteOf(nat, ruleKey, hasDc){
  const m = natMarkOf(nat, ruleKey);
  return m ? m.note : null;
}

/* ---------- 7. render.js：同一份渲染函数（聊天流 / 详情 / 战报共用） ---------- */

// nat 语义只在 D&D 规则里存在。通用/COC/DH/FU 掷 d20 出 1 或 20 没有特殊含义 ——
// 标黄 + 加一句"没有特殊语义"是双重噪音（真机反馈），所以这些规则一律不高亮、不加注。

export { sumKept, buildTotal, natOf, judgeDnd, NAT_MARK, natMarkOf, natNoteOf };

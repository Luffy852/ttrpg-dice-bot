/* dh.js — 5.3 匕首心 六特性 / 四象限判定
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { registerAliases } from './alias.js';
import { CHECK_DOMAIN } from './domains.js';

const DH_TRAITS = [
  {key:'agi', zh:'敏捷', en:'agility',   abbr:'agi', aliases:['agi','agility','敏捷']},
  {key:'str', zh:'力量', en:'strength',  abbr:'str', aliases:['str','strength','力量']},
  {key:'fin', zh:'灵巧', en:'finesse',   abbr:'fin', aliases:['fin','finesse','灵巧','技巧']},
  {key:'ins', zh:'本能', en:'instinct',  abbr:'ins', aliases:['ins','instinct','本能']},
  // ★ presence 社区惯用「风度」，主显示用风度；「仪态」保留为合规别名（老玩家/老团的习惯叫法）
  {key:'pre', zh:'风度', en:'presence',  abbr:'pre', aliases:['pre','presence','风度','仪态','仪容','风采']},
  {key:'kno', zh:'知识', en:'knowledge', abbr:'kno', aliases:['kno','knowledge','知识','学识']}
];
registerAliases(CHECK_DOMAIN.dh, DH_TRAITS.map(t => ({key:t.key, kind:'trait', zh:t.zh, en:t.en, abbr:t.abbr, display:t.zh, aliases:t.aliases})));
function judgeDh(hope, fear, total, dc){
  if(hope === fear){
    return {ok:true, crit:true, tone:'crit', text:'关键成功！—— 双骰同点，必定成功',
            why:'✨ 双骰同点（' + hope + '）—— 关键成功：即使低于难度也必定成功，获得 1 希望点，可清除 1 压力点'};
  }
  const hopeSide = hope > fear;
  // ★ 四象限的**中文说法**统一为「希望/恐惧 + 成功/失败」（社区惯用）。
  //   早期写成「成功带希望」是英文 "success with hope" 的直译，读着别扭且不利于口头报点。
  const side = hopeSide ? '希望' : '恐惧';
  const cmp = '　·　希望骰 ' + hope + (hopeSide ? ' > ' : ' < ') + '恐惧骰 ' + fear;
  if(dc == null){
    return {ok:null, tone:'mid', text:'未判难度 · ' + side,
            why:'未给难度，只掷不判：合计 ' + total + cmp};
  }
  const ok = total >= dc;
  const why = '合计 ' + total + ' vs 难度 ' + dc + cmp;
  if(ok && hopeSide)     return {ok:true,  tone:'ok',  text:'希望成功 —— 你获得 1 希望点', why};
  if(ok && !hopeSide)    return {ok:true,  tone:'mid', text:'恐惧成功 —— GM 获得 1 恐惧点', why};
  if(!ok && hopeSide)    return {ok:false, tone:'mid', text:'希望失败 —— 你获得 1 希望点', why};
  return {ok:false, tone:'no', text:'恐惧失败 —— GM 获得 1 恐惧点', why};
}

/* ---------- 5.4 fu.js：最终物语（骰阶 · HR · 暴击 / 失手） ----------
 * 四属性各持一个骰阶 d6 / d8 / d10 / d12；检定掷两骰求和 vs 难度 DL。
 * HR = 两骰较高者（攻击伤害用）；双骰同点且 ≥6 = 暴击；双 1 = 失手。
 */

export { DH_TRAITS, judgeDh };

/* rules.js — 2 规则别名（保留点号、精确匹配）/ IMPLEMENTED / 规模上限
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { lookupAlias, registerAliases } from './alias.js';

const RULE_META = {
  generic:{name:'通用',       short:'通用'},
  dnd5e :{name:'D&D 5e',      short:'D&D 5e'},
  dnd5r :{name:'D&D 5.5e (2024)', short:'D&D 5.5e'},
  coc7  :{name:'COC 7th',     short:'COC'},
  dh    :{name:'匕首心',       short:'匕首心'},
  fu    :{name:'最终物语',     short:'最终物语'}
};
registerAliases('rule', [
  {key:'generic', display:'通用',     aliases:['generic','通用','ge','gen','general','none','无','无规则','通用规则']},
  {key:'dnd5e',   display:'D&D 5e',   aliases:['dnd','dnd5e','5e','dnd5','龙与地下城','龙与地下城5e','龙与地下城五版','5版']},
  {key:'dnd5r',   display:'D&D 5.5e', aliases:['dnd5.5e','5.5e','dnd5r','5r','dnd2024','dnd5e2024','2024','龙与地下城2024','龙与地下城5.5','5.5版','2024版']},
  {key:'coc7',    display:'COC 7th',  aliases:['coc','coc7','coc7th','克苏鲁','克苏鲁的呼唤','克苏鲁呼唤','呼唤','7版','七版']},
  {key:'dh',      display:'匕首心',    aliases:['dh','daggerheart','匕首心','匕心','匕首']},
  {key:'fu',      display:'最终物语',  aliases:['fu','最终物语','fabula','fabulaultima','fabula ultima']}
]);

function normalizeRule(raw){
  const e = lookupAlias('rule', raw);
  return e ? e.key : null;
}
// 规则族：决定角色卡是否可用（5e 与 5.5e 卡结构相同，属同一族）
function ruleFamily(k){ return (k === 'dnd5e' || k === 'dnd5r') ? 'dnd' : (k === 'generic' ? null : k); }
// M2：四族六规则全部实现（generic / dnd5e / dnd5r / coc7 / dh / fu）
const IMPLEMENTED = new Set(['generic','dnd5e','dnd5r','coc7','dh','fu']);

/* ---------- 3. parse.js：掷骰表达式 ---------- */

export { RULE_META, normalizeRule, ruleFamily, IMPLEMENTED };

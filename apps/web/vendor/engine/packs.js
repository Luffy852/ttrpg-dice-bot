/* packs.js — ★ 注册表：单向 import 五个包，任何包不许反查（★解环③）
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { COC_PACK } from './pack_coc.js';
import { DH_PACK } from './pack_dh.js';
import { DND_PACK } from './pack_dnd.js';
import { FU_PACK } from './pack_fu.js';
import { GENERIC_PACK } from './pack_generic.js';
import { ruleFamily } from './rules.js';

const RULE_PACKS = {generic:GENERIC_PACK, dnd5e:DND_PACK, dnd5r:DND_PACK, coc7:COC_PACK, dh:DH_PACK, fu:FU_PACK};
// 族 → 包：角色卡属于"卡自己的族"，渲染一张卡时要按它的族取包，而不是当前房间规则
const FAMILY_PACKS = {dnd:DND_PACK, coc7:COC_PACK, dh:DH_PACK, fu:FU_PACK};
function packOfFamily(fam){ return (fam && FAMILY_PACKS[fam]) || GENERIC_PACK; }
function rulePack(ruleKey){ return packOfFamily(ruleFamily(ruleKey)); }
// 动词归属：某动词是哪个包的专属指令（用于"当前规则下打了别的规则的指令"时给出可执行的下一步）
function verbOwner(verb){
  for(const k in RULE_PACKS){
    const p = RULE_PACKS[k];
    if(p.verbs && p.verbs[verb]) return k;
  }
  return null;
}

/* ---------- 6. view.js：唯一求和入口 + 判定（派生值全部现场推导） ---------- */

export { RULE_PACKS, FAMILY_PACKS, packOfFamily, rulePack, verbOwner };

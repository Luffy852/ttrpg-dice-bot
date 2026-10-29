/* ============================================================================
 * domains.js —— 别名域的**唯一登记处**（★ 从 dnd.js 迁出，M3 重构）
 * ----------------------------------------------------------------------------
 * 【为什么迁出来】
 *   这两个表原本定义在 dnd.js 里，于是"加一个新规则"要去改 dnd.js —— 不合直觉，
 *   而且等于暗示"D&D 是主、别的规则是从"。它们是**跨规则的公共设施**，不属于任何一套规则。
 *   现在迁到独立模块：加新规则只需在本文件加两行，不再动任何规则包的文件。
 *
 * 【★ 域名按规则族分桶（M2 的新增，理由保留）】
 *   M1 时 check 只有一个域，装的是 D&D 的属性 + 18 技能。M2 加三套规则后，
 *   「潜行」在 D&D 是 stealth、在 COC 是另一套东西；「力量」在 D&D/匕首心/最终物语
 *   各是各的。混进一个域会互相抢键 —— 这与"技能有中文别名、属性没有"是同一类病：
 *   根子永远是"有没有统一入口"。分域 = 让入口不重叠，同时仍只有一个入口。
 *
 * 【本模块零依赖规则包】只依赖 rules.js 的 ruleFamily —— 任何规则包都可以 import 它，
 *   不会形成"新规则依赖 D&D"的怪圈。
 * ========================================================================== */
import { ruleFamily } from './rules.js';

/* 检定的目标词（技能 / 属性 / 特质）按族分区 */
const CHECK_DOMAIN = {dnd:'check:dnd', coc7:'check:coc7', dh:'check:dh', fu:'check:fu'};
/* 角色卡的字段名按族分区（同一批中文词在卡上指向不同英文键） */
const CARD_DOMAIN  = {dnd:'cardkey:dnd', coc7:'cardkey:coc7', dh:'cardkey:dh', fu:'cardkey:fu'};

function checkDomainOf(ruleKey){ return CHECK_DOMAIN[ruleFamily(ruleKey)] || null; }
function cardDomainOf(ruleKey){ return CARD_DOMAIN[ruleFamily(ruleKey)] || null; }

export { CHECK_DOMAIN, CARD_DOMAIN, checkDomainOf, cardDomainOf };

/* fu.js — 5.4 最终物语 骰阶 / 判定 / 查表
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { lookupAlias, registerAliases } from './alias.js';
import { CARD_DOMAIN, CHECK_DOMAIN, checkDomainOf } from './domains.js';

const FU_ATTRS = [
  {key:'dex', zh:'敏捷', en:'dex', aliases:['dex','敏捷','dexterity']},
  {key:'ins', zh:'洞察', en:'ins', aliases:['ins','洞察','insight']},
  {key:'mig', zh:'力量', en:'mig', aliases:['mig','力量','might']},
  {key:'wlp', zh:'意志', en:'wlp', aliases:['wlp','意志','willpower','will']}
];
const FU_TIERS = [6, 8, 10, 12];
const FU_DL_HINT = {7:'易', 10:'普通', 13:'困难', 16:'极难'};
// ★ 静态备忘字段（与 COC 的 hp / san 同一机制）：只显示、只手改，骰娘不自动增减。
//   物资点 IP / 物语点 FP 在 FU 里是**资源**，纳入追踪会破坏"掷骰是纯函数"（指令集 §10.1），
//   所以做成备忘：玩家自己 .st set 物语点 3 改，骰娘照显示。
const FU_MEMO = [
  {key:'fp', zh:'物语点', en:'fp', aliases:['fp','物语点','fabulapoint','fabula','fp点']},
  {key:'ip', zh:'物资点', en:'ip', aliases:['ip','物资点','inventorypoint','inventory','ip点']}
];
const FU_MEMO_KEYS = new Set(FU_MEMO.map(m => m.key));
registerAliases(CHECK_DOMAIN.fu, FU_ATTRS.map(a => ({key:a.key, kind:'fuattr', zh:a.zh, en:a.en, display:a.zh, aliases:a.aliases})));
registerAliases(CARD_DOMAIN.fu, FU_MEMO.map(m => ({key:m.key, kind:'fumemo', zh:m.zh, en:m.en, display:m.zh, aliases:m.aliases})));
function fuMemoLabel(key){ const m = FU_MEMO.find(x => x.key === key); return m ? m.zh : key; }
function judgeFu(v1, v2, dl, mod){
  mod = mod || 0;
  const sum = v1 + v2 + mod, hr = Math.max(v1, v2);
  if(v1 === 1 && v2 === 1) return {ok:false, crit:true, tone:'critfail', text:'失手！—— 双 1，失败且事态恶化',
    why:'💀 双骰都是 1 —— 失手：必定失败且事态恶化，获得 1 物语点'};
  if(v1 === v2 && v1 >= 6) return {ok:true, crit:true, tone:'crit', text:'暴击！—— 双骰同点且 ≥6',
    why:'✨ 双骰同点 ' + v1 + ' 且 ≥6 —— 暴击：无视难度必定成功，获得 1 次机会'};
  // ★ 调整值是**指令里显式给的**（.fu dex ins 10 +2），不是卡上的状态 —— 不改纯函数性质。
  //   暴击 / 失手只看骰面本身，调整值只影响"合计 vs DL"这一处比较，所以加它不影响判定分支。
  const adjNote = (mod) ? ('（骰点 ' + (sum - mod) + ' ' + (mod > 0 ? '+' : '−') + ' ' + Math.abs(mod) + '）') : '';
  if(dl == null) return {ok:null, tone:'mid', text:'合计 ' + sum + ' · HR ' + hr, why:'未给难度，只掷不判' + adjNote};
  return {ok:sum >= dl, text:(sum >= dl ? '成功' : '失败') + '（合计 ' + sum + ' vs DL ' + dl + '）',
          why:'合计 ' + sum + ' vs 难度 ' + dl + (FU_DL_HINT[dl] ? '（' + FU_DL_HINT[dl] + '）' : '') + adjNote};
}
// 骰阶字面量：d6 / d8 / d10 / d12（必须带 d，否则 "10" 会被当成难度）
function parseTier(tok){
  const m = String(tok == null ? '' : tok).match(/^d(\d+)$/i);
  if(!m) return null;
  const s = parseInt(m[1], 10);
  return FU_TIERS.indexOf(s) >= 0 ? s : null;
}

// 检定目标（属性或技能）统一查询。**必须带 ruleKey** —— 不同规则的键在不同域里
function lookupCheckTarget(name, ruleKey){
  const dom = checkDomainOf(ruleKey);
  return dom ? lookupAlias(dom, name) : null;
}
// 兼容旧调用形态（M1 遗留）。★ M2 分域后这个函数一度断掉 —— 它不带 ruleKey，
// 而 lookupCheckTarget 少了 ruleKey 就查不到任何域，静默返回 null（M1 单测捕获）。
// 旧调用方问的一定是 D&D，所以显式钉死 dnd 域：**兼容层要么能正常工作，要么删掉，
// 不能留一个永远返回 null 的活死人**。
function lookupSkillOrAbility(name){
  const e = lookupCheckTarget(name, 'dnd5e');
  if(!e) return null;
  return e.kind === 'ability' ? {type:'ability', ab:e.ab} : {type:'skill', ab:e.ab, skill:{zh:e.zh, en:e.en, abbr:e.abbr, ab:e.ab}};
}

/* ---------- 5.5 rulepack.js：规则包能力接口 ----------
 * 为什么单独抽一层：`.rc list` 这类"规则相关查询"原先写在主流程里、硬编码 DND_SKILLS。
 * M2 加 COC / 匕首心 / 最终物语 时，要么在主流程堆 if-else，要么每加一包改一次主流程 —— 都会烂。
 * 现在：查询挂规则包，主流程只调 rulePack(key).xxx()。**加新包 = 加一个对象，主流程一行不动**。
 *
 * ★ M2 扩展后的包接口（每套规则各自实现，缺则兜底）：
 *   family          —— 角色卡族（决定卡能不能用）
 *   supportsCheck   —— 支持 .rc 检定类指令吗
 *   needsCard       —— 检定必须先绑卡吗（COC/D&D 是；DH/FU 可用字面骰阶/默认 0 直接掷）
 *   checkHint()     —— .rc 无参数时的一行用法
 *   listChecks(ruleKey, card) —— .rc list 的内容（defs 结构）
 *   checkOffNote(ruleKey)     —— 不支持检定时的提示（null = 支持）
 *   cardTemplate()  —— 无卡时 .st 给的模板（null = 本规则没有卡）★M2 新增
 *   parseCard(rest) —— .st set 的解析：{data, errs, count} ★M2 新增
 *   renderCard(card)—— 卡渲染（栅格 HTML）★M2 新增
 *   runCheck({args, mode, card, ruleKey, me}) —— ★M2 新增：检定逻辑**写在包里**
 *                     返回 {view} 或 {notice:html}。主流程不认识任何规则的判定。
 *   verbs           —— ★M2 新增：规则专属动词（.dh / .fu）的处理函数表
 */

export { FU_ATTRS, FU_TIERS, FU_DL_HINT, FU_MEMO, FU_MEMO_KEYS, fuMemoLabel, judgeFu, parseTier, lookupCheckTarget, lookupSkillOrAbility };

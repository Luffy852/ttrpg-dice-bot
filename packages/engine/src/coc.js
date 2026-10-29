/* coc.js — 5.2 COC 7th 技能表 / 百分骰 rollPercent / 五级判定
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { lookupAlias, normToken, registerAliases } from './alias.js';
import { CARD_DOMAIN, CHECK_DOMAIN } from './domains.js';
import { RNG } from './rng.js';

const COC_SKILLS = [
  {key:'侦查',   aliases:['侦查','侦察','发现','spot','spothidden','spot hidden']},
  {key:'图书馆', aliases:['图书馆','图书馆使用','查资料','library','libraryuse','library use']},
  {key:'心理学', aliases:['心理学','psychology','读心','察言观色']},
  {key:'说服',   aliases:['说服','劝说','交涉','persuade','persuasion']},
  {key:'威吓',   aliases:['威吓','恐吓','威胁','intimidate','intimidation']},
  {key:'潜行',   aliases:['潜行','躲藏','隐藏','隐匿','stealth','sneak']},
  {key:'急救',   aliases:['急救','急救术','firstaid','first aid','医疗']},
  {key:'医学',   aliases:['医学','医术','医生','medicine','med']},
  {key:'手枪',   aliases:['手枪','射击','枪械','handgun','firearm']},
  {key:'格斗',   aliases:['格斗','近战','brawl','fighting','fight']},
  {key:'开锁',   aliases:['开锁','撬锁','locksmith','lock']},
  {key:'机械',   aliases:['机械','修理','mechanics','repair']},
  {key:'攀爬',   aliases:['攀爬','攀登','climb']},
  {key:'跳跃',   aliases:['跳跃','jump']},
  {key:'游泳',   aliases:['游泳','swim']},
  {key:'驾驶',   aliases:['驾驶','驾车','drive','driveauto','drive auto']},
  {key:'领航',   aliases:['领航','导航','navigate','navigation']},
  {key:'神秘学', aliases:['神秘学','玄学','occult']},
  {key:'历史',   aliases:['历史','history','his']},
  {key:'考古',   aliases:['考古','archaeology']},
  {key:'法律',   aliases:['法律','law']},
  {key:'会计',   aliases:['会计','财会','accounting','account']},
  {key:'信用',   aliases:['信用','信用评级','信誉','creditrating','credit rating','cr']},
  {key:'幸运',   aliases:['幸运','运气','luck']},
  {key:'灵感',   aliases:['灵感','idea','点子']},
  {key:'意志',   aliases:['意志','pow','willpower','wp']},
  {key:'力量',   aliases:['力量','力气','str','strength']},
  {key:'体质',   aliases:['体质','体力','con','constitution']},
  {key:'敏捷',   aliases:['敏捷','dex','dexterity']},
  {key:'外貌',   aliases:['外貌','app','appearance']},
  {key:'教育',   aliases:['教育','学历','edu','education']},
  {key:'智力',   aliases:['智力','int','intelligence']},
  {key:'san',   aliases:['理智','理智值','san','sanity']},
  {key:'hp',    aliases:['体力值','生命','生命值','hp','hitpoints','hit points']}
];
// 同一个名字在两个域都要能查：.rc 用它检定、.st set 用它写卡 —— 一张表注册两次，不手写第二份数据
registerAliases(CHECK_DOMAIN.coc7, COC_SKILLS.map(s => ({key:s.key, kind:'cocskill', zh:s.key, display:s.key, aliases:s.aliases})));
registerAliases(CARD_DOMAIN.coc7,  COC_SKILLS.map(s => ({key:s.key, display:s.key, aliases:s.aliases})));
// hp / san 是备忘字段（只显示，骰娘不自动增减），其余为可检定技能
const COC_MEMO = new Set(['hp','san']);

/* 百分骰 rollPercent() —— COC 包里唯一需要新写的掷骰逻辑（v1.2 §6.2）
 * 机制：十位骰若干 + 共用个位骰。奖励骰取十位**最低**、惩罚骰取十位**最高**。
 * net > 0 = 奖励骰 n 个；net < 0 = 惩罚骰 n 个；0 = 不额外投（奖惩相抵后）。
 * 十位 0 配个位 0 = 100（COC 的 00+0），这是规则本身的特性，照做。
 */
function rollPercent(net){
  const extra = Math.min(Math.abs(net), 8);            // 上限 8 颗，防刷屏
  const kind = net > 0 ? 'bonus' : (net < 0 ? 'penalty' : null);
  const tens = [RNG.die(10) - 1];
  for(let i = 0; i < extra; i++) tens.push(RNG.die(10) - 1);
  const ones = RNG.die(10) - 1;
  let pick = 0;
  if(kind === 'bonus') tens.forEach((t, i) => { if(t < tens[pick]) pick = i; });
  if(kind === 'penalty') tens.forEach((t, i) => { if(t > tens[pick]) pick = i; });
  const t = tens[pick];
  const value = (t === 0 && ones === 0) ? 100 : t * 10 + ones;
  return {tens, ones, pick, kind, value};
}
// COC 五级成功等级（v1.2 §6.2 + 档案验收样例：技能 60 掷 23 → 困难成功；01 → 大成功；100 → 大失败）
function judgeCoc(value, skill){
  const hard = Math.floor(skill / 2), extreme = Math.floor(skill / 5);
  if(value === 100) return {ok:false, crit:true, tone:'critfail', text:'大失败（100）', why:'掷出 100 —— 大失败，事态恶化'};
  if(value >= 96 && skill < 50) return {ok:false, crit:true, tone:'critfail', text:'大失败（96–100）', why:'掷出 ' + value + ' —— 技能 <50 时 96–100 为大失败'};
  if(value === 1) return {ok:true, crit:true, tone:'crit', text:'大成功（01）', why:'掷出 01 —— 大成功'};
  if(value <= 5 && skill >= 50) return {ok:true, crit:true, tone:'crit', text:'大成功（01–05）', why:'掷出 ' + String(value).padStart(2,'0') + ' —— 技能 ≥50 时 01–05 为大成功'};
  if(value <= extreme) return {ok:true, text:'极难成功（≤' + extreme + '）', why:'≤ 技能值的 1/5（' + extreme + '）：极难成功'};
  if(value <= hard) return {ok:true, text:'困难成功（≤' + hard + '）', why:'≤ 技能值的 1/2（' + hard + '）：困难成功'};
  if(value <= skill) return {ok:true, text:'成功（≤' + skill + '）', why:'≤ 技能值 ' + skill + '：成功'};
  return {ok:false, text:'失败（>' + skill + '）', why:'> 技能值 ' + skill + '：失败'};
}
// COC 技能查询：先查别名表（中英文），再查卡上自定义键 —— 开放列表的核心
function lookupCocSkill(name, card){
  const e = lookupAlias(CHECK_DOMAIN.coc7, name);
  if(e) return {key:e.key, zh:e.key, known:true};
  if(card && card.data){
    const k = normToken(name);
    for(const ck in card.data){ if(normToken(ck) === k) return {key:ck, zh:ck, known:false}; }
  }
  return null;
}

/* ---------- 5.3 dh.js：匕首心（二元骰 · 四象限 · 关键成功） ----------
 * 六特性调整值范围 −1 ~ +3；动作掷骰 = 希望骰 d12 + 恐惧骰 d12 (+ 调整值)。
 * Hope/Fear 判定**只看两颗 d12**，优劣势加减的 d6 不参与比较（v1.2 §7.2）。
 */

export { COC_SKILLS, COC_MEMO, rollPercent, judgeCoc, lookupCocSkill };

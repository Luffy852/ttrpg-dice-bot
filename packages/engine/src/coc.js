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
  {key:'体型',   aliases:['体型','体形','siz','size']},
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
  {key:'hp',    aliases:['体力值','生命','生命值','hp','hitpoints','hit points']},
  {key:'mp',    aliases:['魔法值','魔法','魔力','mp','magicpoints','magic points','magic']},
  /* ★ DB（伤害加值）与体格也是**可手填的备忘字段**（真机反馈 · 第 3 条）。
   * 【原来的 bug】没注册 → 写 `.st set DB 0` 会落成一个"自定义技能"，被开放技能表的
   *   "1–99" 校验拦下（截图绿框「「DB」需在 1–99」）。DB 是 STR+SIZ 查表得出的伤害加值，
   *   可以是 −2 / 0 / +1d4，根本不是百分比技能，本来就不该走那条校验。
   * 【注意别混】体格 = Build（派生值），体型 = SIZ（属性），是两个词、两个字段。 */
  {key:'db',    aliases:['db','伤害加值','伤害加成','伤害加深','damagebonus','damage bonus']},
  {key:'体格',  aliases:['体格','build']}
];
// 同一个名字在两个域都要能查：.rc 用它检定、.st set 用它写卡 —— 一张表注册两次，不手写第二份数据
registerAliases(CHECK_DOMAIN.coc7, COC_SKILLS.map(s => ({key:s.key, kind:'cocskill', zh:s.key, display:s.key, aliases:s.aliases})));
registerAliases(CARD_DOMAIN.coc7,  COC_SKILLS.map(s => ({key:s.key, display:s.key, aliases:s.aliases})));
// hp / san / mp / db / 体格 是备忘字段（只显示，骰娘不自动增减），其余为可检定技能
const COC_MEMO = new Set(['hp','san','mp','db','体格']);
/* ★ 宽松值域的备忘字段：DB 可能是 −2 / 0 / +1d4，体格可能是 −2 ~ +2，
 *   它们不是"1–99 的百分比"也不是"0–999 的计数"，允许一个不含空格的短文本原样存。
 *   （真机反馈 · 第 3 条：截图里 `.st set DB 0` 被「需在 1–99」拦下。） */
const COC_MEMO_TEXT = new Set(['db','体格']);
/* 派生值对应的备忘键 —— 用来判断"玩家是否已经把初始派生值录进卡了" */
const COC_DERIVED_MEMO = ['hp','mp','san','db','体格'];

/* ★ COC 的**属性**（9 项）—— 与技能是两类东西，卡上要分开摆（2026-11-01 真机疏漏）
 * 【原来的洞】COC 卡只有技能，八大属性（力量 / 体质 / 体型 / 敏捷 / 外貌 / 智力 / 意志 / 教育）
 *   被当成普通技能混在技能格里，连**体型 SIZ 都没注册**（写 `.st set 体型 60` 会落成一个自定义技能）。
 *   而 COC 的派生值（HP / MP / SAN 初始 / DB / 体格）**全部由属性推导** —— 属性缺失，派生值就等于不存在。
 * 【为什么不另建一张卡】属性与技能**都按百分比存（1–99）**，值域一致、检定时也走同一条链
 *   （`.rc 力量` 与 `.rc 侦查` 都是 1d100 ≤ 数值）。差别只在**卡面分类与派生**，
 *   所以这里只加一个"哪些 key 是属性"的集合，不动存储、不动 parseCard 的值域。
 * 【幸运为什么在里面】7 版把幸运列为第二属性（3d6×5），与八大属性同形态、也常被检定，
 *   放属性区比混在技能里更符合卡面习惯。 */
const COC_ATTRS = ['力量','体质','体型','敏捷','外貌','智力','意志','教育','幸运'];
const COC_ATTR_SET = new Set(COC_ATTRS);
/** 属性英文缩写 → 规范 key（用于卡面与派生提示里显示 STR / SIZ 这类缩写） */
const COC_ATTR_ABBR = {力量:'STR', 体质:'CON', 体型:'SIZ', 敏捷:'DEX', 外貌:'APP',
  智力:'INT', 意志:'POW', 教育:'EDU', 幸运:'LUC'};

/* ★ 伤害加值 DB 与体格 Build：STR + SIZ 查表（7 版规则书 · 快速开始规则同表）
 *   调查员的 STR / SIZ 各 ≤ 90（3d6×5 / (2d6+6)×5），两者相加最大 180 —— 落在最后一档内，
 *   下面 5 档已覆盖全部正常取值；>204 的兜底只是防御性代码，正常玩不到。
 * MOV（移动速度）不做 —— 这是内部实现说明，不写进任何玩家可见文案（真机反馈 · 第 1 条）。 */
const DB_BUILD = [
  {max:64,  db:'-2',   build:-2},
  {max:84,  db:'-1',   build:-1},
  {max:124, db:'0',    build:0},
  {max:164, db:'+1d4', build:1},
  {max:204, db:'+1d6', build:2},
];
function dbBuildOf(sum){
  for(const r of DB_BUILD) if(sum <= r.max) return r;
  return DB_BUILD[DB_BUILD.length - 1];
}

/** ★ 派生值：全部由属性现场推导，**不存进卡**（原则 6 —— 存副本迟早漂移）
 * 【为什么不写进 data】用户手填的 hp / san 是"当前值"，派生的 hp / san 是"上限 / 初始值"，
 *   两者语义不同且都会变。存一份进去就会变成"哪份是真的"的无解问题。
 * 【返回哪些】只返回**当前能算出来的**（缺属性就不给那一项），避免拿半个属性算出一个假数。 */
function cocDerived(data){
  const d = data || {}, has = k => typeof d[k] === 'number';
  const out = {};
  if(has('体质') && has('体型')) out.hp = Math.floor((d['体质'] + d['体型']) / 10);
  if(has('意志')){ out.mp = Math.floor(d['意志'] / 5); out.san0 = d['意志']; }
  if(has('力量') && has('体型')){
    const r = dbBuildOf(d['力量'] + d['体型']);
    out.db = r.db; out.build = r.build;
  }
  out.complete = (out.hp != null && out.mp != null && out.db != null);
  return out;
}

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

/* ★ 导出必须单行：tools/load-engine.js 剥 import 靠正则，多行 `export {` 会漏掉后半截（拼接路直接语法错误） */
export { COC_SKILLS, COC_MEMO, COC_MEMO_TEXT, COC_DERIVED_MEMO, COC_ATTRS, COC_ATTR_SET, COC_ATTR_ABBR, cocDerived, dbBuildOf, rollPercent, judgeCoc, lookupCocSkill };

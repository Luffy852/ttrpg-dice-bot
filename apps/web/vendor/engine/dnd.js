/* dnd.js — 5 D&D 属性 / 技能表 / 熟练加值 / ★别名域名分桶
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { normToken, registerAliases } from './alias.js';
import { CHECK_DOMAIN } from './domains.js';   // ★ 域名表已从 dnd.js 迁出
import { ruleFamily } from './rules.js';

const ABIL_KEYS = ['str','dex','con','int','wis','cha'];
const ABIL_ZH   = {str:'力量', dex:'敏捷', con:'体质', int:'智力', wis:'感知', cha:'魅力'};
function abilityMod(score){ return Math.floor((score - 10) / 2); }
function profFromLv(lv){
  if(!(lv >= 1)) return null;
  if(lv <= 4) return 2; if(lv <= 8) return 3; if(lv <= 12) return 4;
  if(lv <= 16) return 5; return 6;
}
// 六属性：中文名 + 英文键 + 常见别称。属性与技能同属 check 域 —— 用户是在同一个位置输入的，
// 凭什么技能有中文别名、属性没有？两者必须一起泛化（用户真机反馈）。
const DND_ABILITIES = [
  {key:'str', kind:'ability', ab:'str', zh:'力量', aliases:['str','力量','强壮','肌力','力']},
  {key:'dex', kind:'ability', ab:'dex', zh:'敏捷', aliases:['dex','敏捷','身手','灵敏']},
  {key:'con', kind:'ability', ab:'con', zh:'体质', aliases:['con','体质','体魄','耐力','健壮']},
  {key:'int', kind:'ability', ab:'int', zh:'智力', aliases:['int','智力','才智','学识']},
  {key:'wis', kind:'ability', ab:'wis', zh:'感知', aliases:['wis','感知','睿智','悟性']},
  {key:'cha', kind:'ability', ab:'cha', zh:'魅力', aliases:['cha','魅力','风采','感召']}
];
// 18 项技能：技能 → 属性（唯一映射）。注意 inti 不能简写成 int（int 已被智力占用）
const DND_SKILLS = [
  {zh:'运动', en:'athletics',      abbr:'ath',    ab:'str', alt:['体育','田径','运动']},
  {zh:'特技', en:'acrobatics',     abbr:'acr',    ab:'dex', alt:['杂技','体操']},
  {zh:'巧手', en:'sleightofhand',  abbr:'sleight',ab:'dex', alt:['妙手','手法']},
  {zh:'隐匿', en:'stealth',        abbr:'ste',    ab:'dex', alt:['潜行','躲藏','隐蔽']},
  {zh:'奥秘', en:'arcana',         abbr:'arc',    ab:'int', alt:['奥术','秘术']},
  {zh:'历史', en:'history',        abbr:'his',    ab:'int', alt:['史学','历史学']},
  {zh:'调查', en:'investigation',  abbr:'inv',    ab:'int', alt:['搜查','侦查','探查']},
  {zh:'自然', en:'nature',         abbr:'nat',    ab:'int', alt:['博物','自然学']},
  {zh:'宗教', en:'religion',       abbr:'rel',    ab:'int', alt:['神学','信仰']},
  {zh:'洞察', en:'insight',        abbr:'ins',    ab:'wis', alt:['直觉','识人']},
  {zh:'医药', en:'medicine',       abbr:'med',    ab:'wis', alt:['医疗','医术','治疗']},
  {zh:'察觉', en:'perception',     abbr:'perc',   ab:'wis', alt:['知觉','观察','觉察']},
  {zh:'生存', en:'survival',       abbr:'sur',    ab:'wis', alt:['求生','野外']},
  {zh:'驯兽', en:'animalhandling', abbr:'animal', ab:'wis', alt:['动物驯养','驭兽','驭兽术']},
  {zh:'欺瞒', en:'deception',      abbr:'dec',    ab:'cha', alt:['欺骗','诈欺','说谎']},
  {zh:'威吓', en:'intimidation',   abbr:'inti',   ab:'cha', alt:['恐吓','威胁','胁迫']},
  {zh:'表演', en:'performance',    abbr:'perf',   ab:'cha', alt:['演艺','演奏','演出']},
  {zh:'说服', en:'persuasion',     abbr:'pers',   ab:'cha', alt:['游说','劝服','交涉']}
];

// 属性与技能注册进同一个域：一处归一化、一处冲突检测、一处建议
registerAliases(CHECK_DOMAIN.dnd,
  DND_ABILITIES.map(a => ({key:a.key, kind:'ability', ab:a.ab, zh:a.zh, display:a.zh, aliases:a.aliases}))
  .concat(DND_SKILLS.map(s => ({
    key:s.en, kind:'skill', ab:s.ab, zh:s.zh, en:s.en, abbr:s.abbr, display:s.zh,
    aliases:[s.zh, s.en, s.abbr].concat(s.alt || [])
  })))
);
const SKILL_INDEX = new Map();
DND_SKILLS.forEach(s => { [s.zh, s.en, s.abbr].concat(s.alt || []).forEach(k => { if(k) SKILL_INDEX.set(normToken(k), s); }); });

/* ---------- 5.2 coc.js：COC 7th（开放技能表 + 百分骰 + 奖惩骰） ----------
 * ★ COC 的技能是**开放列表**：卡上写什么就能检定什么（.st set 侦查 60）。
 *   所以 check 域里的这张表只做两件事：① .rc list 的常用参考 ② 未识别时的建议。
 *   卡上没写过、但用户自定义的名字照样能掷 —— 见 lookupCocSkill()。
 */

export { ABIL_KEYS, ABIL_ZH, abilityMod, profFromLv, DND_ABILITIES, DND_SKILLS, SKILL_INDEX };

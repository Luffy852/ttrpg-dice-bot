/* card.js — 9 角色卡：解析 / 卡名 / 不匹配提示 / 栅格渲染（★解环② renderCardHtml 迁入）
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { lookupAlias, registerAliases } from './alias.js';
import { ABIL_ZH, DND_ABILITIES, abilityMod } from './dnd.js';
import { CARD_DOMAIN } from './domains.js';
import { RULE_META, ruleFamily } from './rules.js';
import { esc, fmtMod } from './util.js';

const CARD_KEYS = ['str','dex','con','int','wis','cha','lv','level'];
// 卡字段同样走别名层：属性直接用 check 域的中文，等级单独一组。
// 域名带族（CARD_DOMAIN.dnd）—— M2 后四套规则各有一张卡字段表，不能共用一个域。
registerAliases(CARD_DOMAIN.dnd,
  DND_ABILITIES.map(a => ({key:a.key, display:a.zh, aliases:a.aliases}))
  .concat([{key:'lv', display:'等级', aliases:['lv','level','等级','级别','lvl','等阶']}])
);
function normalizeCardKey(k){
  const e = lookupAlias(CARD_DOMAIN.dnd, k);
  return e ? e.key : null;
}
function parseCardSet(rest){
  const t = rest.trim().split(/\s+/).filter(Boolean);
  const data = {}; const errs = [];
  for(let i = 0; i < t.length; i += 2){
    const key = normalizeCardKey(t[i]);
    const val = t[i + 1];
    if(!key){ errs.push('未知字段「' + t[i] + '」'); i -= 1; continue; }
    if(!/^-?\d+$/.test(val == null ? '' : val)){ errs.push('「' + key + '」需要整数'); i -= 1; continue; }
    const v = parseInt(val, 10);
    if(key === 'lv'){
      if(v < 1 || v > 20){ errs.push('等级需在 1–20'); continue; }
    } else if(v < 1 || v > 30){ errs.push(ABIL_ZH[key] + '需在 1–30'); continue; }
    data[key] = v;
  }
  return {data, errs, count:Object.keys(data).length};
}
function cardMod(card, ab){
  const s = card && card.data ? card.data[ab] : undefined;
  return typeof s === 'number' ? abilityMod(s) : 0;   // 缺失属性按 10 处理
}
// 角色卡改为栅格渲染 renderCardHtml（见 render 区），等宽文本版已废弃删除 ——
// 窄屏下等宽表格必然换行错位，且两处实现会漂移（原则 4）。

// ★ 角色卡属于「卡自己的规则」，不属于「当前房间规则」—— 这是两个正交维度。
//   之前 .st 用房间规则名当卡名（通用规则下把 D&D 卡叫"通用角色卡"），是张冠李戴。
function cardRuleName(card){
  if(!card) return '';
  if(card.family === 'dnd') return 'D&D';
  return RULE_META[card.family] ? RULE_META[card.family].name : card.family;
}
// 卡与当前规则不匹配时的提示（null = 匹配）。三处共用（.st / .st set / .status），避免各写各的。
function cardMismatchNote(card, ruleKey){
  if(!card) return null;
  if(ruleFamily(ruleKey) === card.family) return null;
  const back = card.family === 'dnd' ? 'dnd' : card.family;
  // ★ 两条出路都要给：① 切回卡所属的规则 ② 解绑后按当前规则重开一张。
  //   只给①的话，玩家想换规则开新卡时不知道怎么把手上这张扔掉（.st 会一直返回旧卡）。
  return '⚠️ 这是 <b>' + esc(cardRuleName(card)) + '</b> 角色卡，当前规则「' + esc(RULE_META[ruleKey].name) +
         '」下不参与检定 —— 用 <b>.set rule ' + esc(back) + '</b> 切回后恢复，' +
         '或用 <b>.st clear</b> 解绑（解绑后再发 <b>.st</b> 就是当前规则的角色卡模板）';
}

/* ---------- 10. cmd.js：指令分发 ---------- */
// 动词同样中文化：既然技能名认中文，动词没有理由只认英文。
// 注意不同域分开注册 —— "优势"既是 .ra 的动词别名，也是 .r 的模式参数，互不冲突。
// 只收 2 字以上的中文动词：单字（投 / 掷 / 卡）会把「。投石问路」这类中文句子误切成指令
registerAliases('verb', [
  {key:'r',      display:'.r',      aliases:['r','roll','骰','掷骰','投掷','骰子']},
  {key:'rc',     display:'.rc',     aliases:['rc','check','检定','判定']},
  {key:'ra',     display:'.ra',     aliases:['ra','优势检定','优势']},
  {key:'rd',     display:'.rd',     aliases:['rd','劣势检定','劣势']},
  {key:'h',      display:'.h',      aliases:['h','history','历史','记录','最近']},
  {key:'help',   display:'.help',   aliases:['help','帮助','说明','用法','菜单']},
  {key:'status', display:'.status', aliases:['status','stat','状态','现状']},
  {key:'set',    display:'.set',    aliases:['set','设置','设定']},
  {key:'rule',   display:'.rule',   aliases:['rule','规则']},
  {key:'name',   display:'.name',   aliases:['name','nn','昵称','名字','改名']},
  {key:'st',     display:'.st',     aliases:['st','角色卡','人物卡','面板']},
  // 规则专属动词（M2）：匕首心 .dh / 最终物语 .fu。它们只在自己的规则包里可用，
  // 打错规则时主流程会给出"切到哪条规则"而不是静默不回话（见 verbOwner）
  {key:'dh',     display:'.dh',     aliases:['dh','动作掷骰','动作','二元骰']},
  {key:'fu',     display:'.fu',     aliases:['fu','物语','物语检定','最终物语']}
]);
registerAliases('mode', [
  {key:'adv', display:'优势', aliases:['adv','advantage','优势','有利','优']},
  {key:'dis', display:'劣势', aliases:['dis','disadvantage','劣势','不利','劣']}
]);
registerAliases('switch', [
  {key:'on',  display:'开', aliases:['on','true','1','开','开启','是','启用','打开','yes']},
  {key:'off', display:'关', aliases:['off','false','0','关','关闭','否','停用','关掉','no']}
]);
registerAliases('prof', [
  {key:'p', display:'熟练', aliases:['p','prof','proficiency','熟练','专精','精通','熟练加值','熟练项']}
]);
// .set 的子项：rule / baredice
registerAliases('setsub', [
  {key:'rule',     display:'规则',   aliases:['rule','规则','玩法','系统']},
  {key:'baredice', display:'裸骰',   aliases:['baredice','bd','裸骰','裸骰识别']}
]);

/* ★ renderCardHtml 从 render.js 迁入（解环②）：render 用 cardMod、card 用 renderCardHtml，
   曾互相 import。卡渲染属「卡域」，搬来后依赖变为单向 render → card。 */
function renderCardHtml(card){
  const cells = ['str','dex','con','int','wis','cha'].map(k => {
    const v = card.data[k];
    return '<div class="cell"><span class="ck">' + ABIL_ZH[k] + '</span> ' +
      '<span class="cv">' + (typeof v === 'number' ? v : '—') + '</span> ' +
      '<span class="cm">' + fmtMod(cardMod(card, k)) + '</span></div>';
  }).join('');
  return '<div class="card">' + cells + '</div>';
}

export { renderCardHtml,  CARD_KEYS, normalizeCardKey, parseCardSet, cardMod, cardRuleName, cardMismatchNote };

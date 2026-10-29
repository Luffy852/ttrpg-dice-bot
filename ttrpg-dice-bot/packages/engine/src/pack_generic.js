/* pack_generic.js — 规则包 · 通用
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { RULE_META } from './rules.js';
import { esc } from './util.js';

const GENERIC_PACK = {
  family:null,
  supportsCheck:false,
  needsCard:false,
  checkHint(){ return '用法：<b>.r 2d6+3</b> 直接掷骰　·　<b>.r 1d20+5 优势</b>'; },
  checkOffNote(ruleKey){
    return '当前规则为「' + esc(RULE_META[ruleKey].name) + '」，不使用角色卡、也没有检定指令 —— 直接用 <b>.r</b> 掷骰即可。';
  },
  // 通用规则没有角色卡：模板、解析、渲染三处都返回空，由主流程统一给"本规则不用卡"的说明
  cardTemplate(){ return null; },
  parseCard(){ return {data:{}, errs:['通用规则不使用角色卡'], count:0}; },
  renderCard(){ return ''; },
  // ★ 通用规则下 .rc list 讲的是「这条命令本身」：它当前不适用、绑了规则后会变成什么、怎么用。
  //   不是通用掷骰教学（那是 .r 的事）—— 用户点的是 .rc list，就该回答 .rc list。
  listChecks(ruleKey){
    return {title:'📜 .rc list · 本命令说明', sections:[
      {h:'当前为什么没有内容', rows:[
        {k:'当前规则', v:esc(RULE_META[ruleKey].name) + ' —— 不使用角色卡，也没有检定指令'},
        {k:'所以',     v:'.rc list 要列的属性表 / 技能表来自规则包，通用规则没有可列的内容'}
      ]},
      {h:'绑定规则后，这条命令怎么用', rows:[
        {k:'1 · 切规则',   v:'<b>.set rule dnd</b>（或 <b>.设置 规则 龙与地下城</b>）'},
        {k:'2 · 再看一次', v:'再发一次 <b>.rc list</b>，就会列出该规则的全部属性名与技能名'},
        {k:'3 · 照着掷',   v:'<b>.rc 力量</b>　·　<b>.rc 巧手 熟练</b>　·　<b>.rc 察觉 15 熟练</b>'}
      ]},
      {h:'各规则给出的内容不同', rows:[
        {k:'D&D 5e / 5.5e', v:'六属性 + 18 项技能（中英文都认）'},
        {k:'COC 7th',       v:'开放技能表 —— 你卡上写了什么就列什么（.st set 侦查 60）'},
        {k:'匕首心',         v:'六特性表；本规则不用 .rc，动作掷骰请用 .dh'},
        {k:'最终物语',       v:'四属性骰阶表；本规则不用 .rc，检定请用 .fu'}
      ]}
    ], foot:[
      'ℹ️ 想直接掷骰请用 <b>.r 2d6+3</b>（通用规则不需要角色卡）',
      '⚠️ 通用规则下 <b>.rc / .ra / .rd</b> 均不可用 —— 它们是规则包提供的能力'
    ]};
  }
};

export { GENERIC_PACK };

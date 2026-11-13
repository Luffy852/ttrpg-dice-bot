/* pack_coc.js — 规则包 · COC 7th
 * 从 M2 的 ENGINE 区整体搬来，逻辑一行未改（由 676 项断言锁定）。
 */
import { lookupAlias, normToken, suggestAlias } from './alias.js';
import { COC_MEMO, COC_MEMO_TEXT, COC_DERIVED_MEMO, COC_ATTRS, COC_ATTR_SET, cocDerived, judgeCoc, lookupCocSkill, rollPercent } from './coc.js';
import { CARD_DOMAIN, checkDomainOf } from './domains.js';
import { esc } from './util.js';
import { buildTotal } from './view.js';

const COC_PACK = {
  family:'coc7',
  supportsCheck:true,
  needsCard:true,
  checkHint(){ return '用法：<b>.rc 侦查</b>（技能）　·　<b>.rc 力量</b>（属性，同规则）　·　<b>.rc 侦查 +1</b>（1 奖励骰）　·　<b>.rc list</b> 看卡上的属性与技能'; },
  checkOffNote(){ return null; },
  noCardNote(){
    return '尚未绑定角色卡 —— 先用 <b>.st set 力量 60 体质 50 体型 60 敏捷 55 智力 75 意志 70</b> 填属性，' +
           '再 <b>.st set 侦查 60 图书馆 50</b> 补技能（都是"名字 + 数值"，任意增减），' +
           '然后 <b>.rc 侦查</b>；或直接用 <b>.r 1d100</b> 裸掷。';
  },
  cardTemplate(){
    /* ★ 真机反馈 · 第 2 条（单点独立判断，只作用于这个模板，不泛化到其他文案）：
     *   ① 属性示例右边那句把中文属性名又列了一遍，与指令本身重复 → 移除（英文缩写 .help coc 里有）
     *   ② 7 版没有"灵感"这一条，只在 .help coc 里说明就够了 → 模板里移除 */
    return {title:'尚未绑定角色卡', sections:[
      {h:'① 属性（八大项 + 幸运，都填百分比）', rows:[
        {k:'.st set 力量 60 体质 50 体型 60 敏捷 55 外貌 60 智力 75 意志 70 教育 70', v:''},
        {k:'.st set 幸运 65', v:'幸运也常单独给（可写 luck）'}
      ]},
      {h:'② 技能（开放列表，想加什么写什么）', rows:[
        {k:'.st set 侦查 60 图书馆 50 心理学 40', v:'技能名 数值，空格分隔，可任意增减'},
        {k:'.st set 开锁 30 手枪 45', v:'不在常用表里的名字也照收，原样进卡'}
      ]},
      {h:'这张卡的两条规则', rows:[
        {k:'属性与技能都按百分比', v:'两者都是 1–99，都能直接 <b>.rc 名字</b> 检定（1d100 ≤ 数值）'},
        {k:'HP / MP / SAN 等是派生值', v:'设定属性后骰娘会给一条可复制的 <b>.st</b> 指令，贴一次即可录入；手填的 <b>hp / san / mp / db / 体格</b> 是"当前值"，骰娘<b>不会自动增减</b>'}
      ]}
    ], foot:['★ COC 检定 = 掷 1d100 ≤ 数值；奖惩骰见 <b>.help coc</b>']};
  },
  parseCard(rest){
    const t = rest.trim().split(/\s+/).filter(Boolean);
    const data = {}, errs = [];
    for(let i = 0; i < t.length; i += 2){
      const raw = t[i];
      const e = lookupAlias(CARD_DOMAIN.coc7, raw);
      const key = e ? e.key : raw;                 // 未注册的自定义技能：原样作键（开放列表）
      const val = t[i + 1];
      /* ★ DB / 体格是"伤害加值 / 体格标记"，值可以是 −2 / 0 / +1d4 / +1 ——
       *   它们不是百分比技能，不能套用下面的 1–99（真机反馈 · 第 3 条：`.st set DB 0` 被拦）。
       *   只收一个不含空格的短文本，原样存；渲染时 esc。 */
      if(COC_MEMO_TEXT.has(key)){
        if(val == null || val.length === 0 || val.length > 12){
          errs.push('「' + raw + '」后面需要一个短值（如 0 / -1 / +1d4）'); i -= 1; continue;
        }
        data[key] = val;
        continue;
      }
      if(!/^\d+$/.test(val == null ? '' : val)){ errs.push('「' + raw + '」后面需要一个非负整数'); i -= 1; continue; }
      const v = parseInt(val, 10);
      if(COC_MEMO.has(key)){ if(v > 999){ errs.push(key.toUpperCase() + ' 需在 0–999'); continue; } }
      else if(v < 1 || v > 99){ errs.push('「' + key + '」需在 1–99'); continue; }
      data[key] = v;
    }
    return {data, errs, count:Object.keys(data).length};
  },
  /* ★ 卡面三段：属性 / 技能 / 备忘（当前值）+ 一条**条件显示**的派生录入指令
   * 【为什么属性要单独一段】它们与技能**同值域、同检定链**（都是 1d100 ≤ 数值），
   *   但语义完全不同：技能是"练过的"，属性是"这个人本身"，且派生值只认属性。
   * 【★ 真机反馈 · 第 3 条】原来常驻一行"派生 HP 11 / MP 14 / …(含 MOV 说明)"，
   *   玩家把数值手填进备忘后，备忘行与派生行两行并列、内容几乎一样，观感很差。
   *   现在借用"卡上还没有技能"那套条件显示：派生备忘字段**一个都没录** → 给一条算好结果的
   *   `.st set` 指令，复制粘贴一次即可完成初始录入；录了任意一个 → 整块消失，卡面只剩备忘行。
   * 【为什么不把派生值写进卡】原则 6 —— 副本迟早与属性漂移，这里每次现场推导。 */
  renderCard(card){
    const data = card.data || {};
    const attrs = COC_ATTRS.filter(k => typeof data[k] === 'number');
    const skills = Object.keys(data).filter(k => !COC_ATTR_SET.has(k) && !COC_MEMO.has(k));
    const memo = Object.keys(data).filter(k => COC_MEMO.has(k));

    const attrHtml = attrs.length
      ? '<div class="stline"><span class="ck">属性</span> ' + attrs.map(k =>
          esc(k) + ' <b>' + data[k] + '</b>').join('　·　') + '</div>'
      : '';
    const cells = skills.slice(0, 24).map(k =>
      '<div class="cell"><span class="ck">' + esc(k) + '</span> <span class="cv">' + data[k] + '</span></div>').join('');
    const skillHtml = cells
      ? '<div class="card">' + cells + '</div>'
      : '<div class="stline">（卡上还没有技能）</div>';
    const memoHtml = memo.length
      ? '<div class="stline" style="margin-top:6px">' + memo.map(k =>
          esc(k.toUpperCase()) + ' ' + esc(String(data[k]))).join('　·　') +
        '　<span class="ck">（当前值 · 备忘，骰娘不自动增减）</span></div>'
      : '';
    /* ★ 只列**当前算得出来**的：属性不齐就少给几项，不拿半个属性凑一个假数。
     *   指令里的键（HP / MP / SAN / DB / 体格）都是可手填的备忘字段，DB / 体格走宽松值域。 */
    const dv = cocDerived(data);
    const pairs = [];
    if(dv.hp != null) pairs.push('HP ' + dv.hp);
    if(dv.mp != null) pairs.push('MP ' + dv.mp);
    if(dv.san0 != null) pairs.push('SAN ' + dv.san0);
    if(dv.db != null) pairs.push('DB ' + dv.db);
    if(dv.build != null) pairs.push('体格 ' + (dv.build > 0 ? '+' : '') + dv.build);
    const recorded = COC_DERIVED_MEMO.some(k => data[k] !== undefined);
    const derivedHtml = (!recorded && pairs.length)
      ? '<div class="stline" style="margin-top:6px"><span class="ck">属性派生值分别为</span> ' +
        pairs.join(' / ') + ' —— 复制下面这行一次性录入：<br>' +
        '<span class="hk">' + esc('.st set ' + pairs.join(' ')) + '</span></div>'
      : '';
    return attrHtml + skillHtml + memoHtml + derivedHtml +
      (skills.length > 24 ? '<div class="stline">… 共 ' + skills.length + ' 项</div>' : '');
  },
  listChecks(ruleKey, card){
    if(card && card.family === 'coc7' && Object.keys(card.data).length){
      const data = card.data;
      const attrs = COC_ATTRS.filter(k => typeof data[k] === 'number');
      const keys = Object.keys(data).filter(k => !COC_ATTR_SET.has(k) && !COC_MEMO.has(k));
      const secs = [];
      /* ★ 属性要单列一栏：它们不是"练出来的技能"，且 HP / MP / SAN / DB 全靠它们推导 ——
       *   混在技能列表里，用户看不出自己属性是不是缺了体型（而缺体型就算不出 HP）。 */
      if(attrs.length) secs.push({h:'属性 · ' + attrs.length + ' 项（派生值由它们推导）', rows:attrs.map(k => ({
        k:esc(k), v:'<b>.rc ' + esc(k) + '</b>　' + data[k] +
          (k === '体型' ? '　·　<b>HP 要用它</b>' : '') +
          (k === '意志' ? '　·　<b>SAN 初始 / MP 用它</b>' : '') +
          (k === '力量' ? '　·　<b>DB 与体格用它 + 体型</b>' : '')
      }))});
      secs.push({h:'技能 · ' + keys.length + ' 项 · 直接 .rc 名字即可掷', rows:keys.slice(0, 18).map(k => ({
        k:esc(k), v:'<b>.rc ' + esc(k) + '</b>　·　奖惩骰 <b>.rc ' + esc(k) + ' +1</b>'
      }))});
      return {title:'📜 你卡上的属性与技能（COC 7th）', sections:secs, foot:[
        attrs.length ? '' : '⚠️ 卡上还没有<b>属性</b> —— 补 <b>.st set 力量 60 体质 50 体型 60 敏捷 55</b> 后，骰娘会给一条可复制的 .st 指令把初始派生值录入',
        '技能表是开放的：想加就 <b>.st set 开锁 30</b>，不用管表里有没有',
        '未绑的技能不能直接掷 —— 先 <b>.st set 名字 数值</b>，或 <b>.r 1d100</b> 裸掷',
        /* ★ S2 模块 C · C1（I·4.1）：两条返回路径都要带这一句，不能只加一处 */
        '.sc / .理智 相当于 .rc 理智（自动取卡上 SAN）'
      ].filter(Boolean)};
    }
    return {title:'📜 COC 检定 · 本规则怎么用', sections:[
      {h:'还没有卡：先绑一张', rows:[
        {k:'.st set 力量 60 体质 50 体型 60 敏捷 55 外貌 60 智力 75 意志 70 教育 70', v:'八大属性（都填百分比；英文 str / con / siz / dex / app / int / pow / edu 同样认）'},
        {k:'.st set 侦查 60 图书馆 50 心理学 40', v:'技能名 + 数值，任意增减；绑完再看 .rc list 会列出你自己的属性与技能'}
      ]},
      {h:'属性 vs 技能（★ 两者都是 1–99，都能 .rc）', rows:[
        {k:'属性 8+1 项', v:'力量 体质 体型 敏捷 外貌 智力 意志 教育（+ 幸运）—— <b>HP / MP / SAN 初始 / DB 全由它们推导</b>'},
        {k:'技能（开放列表）', v:'侦查 · 图书馆 · 心理学 · 说服 · 威吓 · 潜行 · 急救 · 医学 · 手枪 · 格斗 · 开锁 · 机械 · 攀爬 · 跳跃 · 游泳 · 驾驶 · 领航 · 神秘学 · 历史 · 考古 · 法律 · 会计 · 信用'},
        {k:'怎么分', v:'属性是"这个人本身"，技能是"练过的"；两者检定方式一样，只是卡面分开摆'}
      ]}
    ], foot:[
      '★ COC 的技能表是开放列表 —— 上面只是参考，你写什么名字都能进卡',
      'ℹ️ 7 版<b>没有"灵感"这一属性</b>：灵感检定 = 智力检定（掷骰 ≤ 智力值）',
      'ℹ️ 检定是 1d100 ≤ 数值；奖惩骰写法 <b>.rc 侦查 +1</b> / <b>.rc 侦查 -2</b>',
      /* ★ S2 模块 C · C1（I·4.1）：有卡 / 无卡两条返回路径都要带这一句 */
      '.sc / .理智 相当于 .rc 理智（自动取卡上 SAN）'
    ]};
  },
  runCheck({args, mode, card, ruleKey}){
    const tokens = args.split(/\s+/).filter(Boolean);
    let name = null, bonus = 0, penalty = 0, bad = null;
    tokens.forEach(t => {
      const nt = normToken(t);
      let m = nt.match(/^\+(\d+)$/);
      if(m){ bonus += parseInt(m[1], 10); return; }
      m = nt.match(/^-(\d+)$/);
      if(m){ penalty += parseInt(m[1], 10); return; }
      m = nt.match(/^(?:奖励|奖|bonus|b)(\d*)$/);
      if(m){ bonus += (m[1] ? parseInt(m[1], 10) : 1); return; }
      m = nt.match(/^(?:惩罚|罚|penalty)(\d*)$/);
      if(m){ penalty += (m[1] ? parseInt(m[1], 10) : 1); return; }
      if(name === null) name = t; else bad = t;
    });
    if(bad) return {notice:'参数太多：「' + esc(bad) + '」。格式：.rc <技能名> [+奖励骰] [-惩罚骰]'};
    if(!name) return {notice:'请给出技能名，例如 <b>.rc 侦查</b>；奖惩骰写法 <b>.rc 侦查 +1</b>'};
    const hit = lookupCocSkill(name, card);
    if(!hit){
      const s = suggestAlias(checkDomainOf(ruleKey), name, 2);
      return {notice:'卡上没有「' + esc(name) + '」' + (s.length ? '。你是不是想找：<b>' + s.map(esc).join('</b> / <b>') + '</b>' : '') +
        '<br>用 <b>.st set ' + esc(name) + ' 60</b> 添加，或直接 <b>.r 1d100</b> 裸掷'};
    }
    const skill = card.data[hit.key];
    if(typeof skill !== 'number') return {notice:'卡上还没有「' + esc(hit.key) + '」的数值 —— 用 <b>.st set ' + esc(hit.key) + ' 60</b> 添加，或直接 <b>.r 1d100</b> 裸掷'};
    const net = bonus - penalty;
    const pc = rollPercent(net);
    // 百分骰：一个 group + percent 描述（十位骰列表 / 个位 / 采用哪一颗），渲染层据此特殊排版
    const groups = [{n:1, sides:100, sign:1, tries:[[pc.value]], kept:[pc.value], keptIdx:0,
      label:'百分骰', percent:{tens:pc.tens, ones:pc.ones, pick:pc.pick, kind:pc.kind}}];
    const t = buildTotal(pc.value, []);
    const verdict = judgeCoc(pc.value, skill);
    const notes = [];
    if(pc.tens.length > 1) notes.push((pc.kind === 'bonus' ? '奖励骰' : '惩罚骰') + ' ×' + Math.abs(net) +
      '：十位骰 ' + pc.tens.join(' / ') + '，取' + (pc.kind === 'bonus' ? '最低' : '最高') + ' ' + pc.tens[pc.pick]);
    else if(bonus && penalty) notes.push('奖 ' + bonus + ' 罚 ' + penalty + ' 相抵，不额外投十位骰');
    if(pc.value === 100) notes.push('十位 00 + 个位 0 = 100');
    if(COC_MEMO.has(hit.key)) notes.push('「' + esc(hit.key.toUpperCase()) + '」是备忘字段 —— 骰娘不会自动增减，只按卡上的数值检定');
    let tag = '';
    if(bonus && penalty) tag = ' [奖' + bonus + ' 罚' + penalty + (net === 0 ? ' · 相抵' : (net > 0 ? ' → 净奖励 ' + net : ' → 净惩罚 ' + (-net))) + ']';
    else if(bonus) tag = ' [奖励骰 ×' + bonus + ']';
    else if(penalty) tag = ' [惩罚骰 ×' + penalty + ']';
    return {view:{ruleKey, mode:null, groups, comps:[], diceSum:t.diceSum, add:t.add, total:t.total,
      title:hit.zh + '检定（' + skill + '）' + tag,
      dc:skill, dcLabel:'技能值', verdict, natBadge:null, natNote:verdict.why || null, notes}};
  },
  /* ★ S2 模块 C · C1（I·4.1）：`.sc` / `.理智` = 固定 `.rc 理智` ＋ 透传奖惩参数。
   *   只在本包登记（packs.js 的 verbOwner 单一源）；判定逻辑仍只有 runCheck 一份，
   *   零新掷骰逻辑、零协议 / Worker / schema / 前端改动。非 COC 规则下 cmd.js 的
   *   owner 兜底给归属提示，不静默、不降级为聊天（Q2）。 */
  verbs: {
    sc(rest, {card, ruleKey, me}){
      // 与 .rc 分支同款「需要卡且卡的族必须匹配」检查；缺卡 / 换族卡不自动推导、不写卡
      if(!card || card.family !== COC_PACK.family) return {notice: COC_PACK.noCardNote(card)};
      const extra = String(rest || '').trim().split(/\s+/).filter(Boolean);
      /* ★ Q3：奖惩参数原样透传，但「多给的技能名」必须显式报错、不静默换检定目标。
       *   技能名判定复用别名层（check:coc7 域）单一源，不复制 runCheck 的参数解析。 */
      const other = extra.find(t => lookupAlias(checkDomainOf(ruleKey), t));
      if(other){
        return {notice:'「<b>.sc / .理智</b>」只按卡上的 SAN 检定，不能改成别的技能 —— ' +
          '要检定「' + esc(other) + '」请用 <b>.rc ' + esc(other) + '</b>；' +
          '奖惩骰直接写在后面，如 <b>.sc +1</b> / <b>.sc -2</b>'};
      }
      return COC_PACK.runCheck({args:('理智 ' + (rest || '').trim()).trim(), mode:null, card, ruleKey, me});
    }
  },
  // ★ M3：payload 只存事实，判定结论现场推导 —— 这里是「从骰点事实还原结论」的唯一入口。
  //   与 runCheck 共用同一个 judgeCoc，判定逻辑仍然只有一份。
  replayVerdict(f){
    if(f.dc == null) return null;
    const v = judgeCoc(f.diceSum, f.dc);
    return {verdict:v, natNote:v.why || null};      // ★ why 是当时显示的判定说明，必须一起还原
  },
};

/* ---------- 匕首心包 ---------- */

export { COC_PACK };

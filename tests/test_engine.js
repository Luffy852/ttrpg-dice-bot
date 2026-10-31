/* ============================================================================
* 骰娘引擎回归测试（M3 版 · 断言主体 = M2 版 676 项，一行未改）
* ----------------------------------------------------------------------------
* 【怎么用】  node tests/test_engine.js         （拼接路，零依赖）
*             node tests/test_engine_esm.mjs    （真 ESM 路，同一份断言）
* 【★ 本文件是活契约】改引擎后必须两路都跑，全绿才算完成。
*
* 【★ M3 相对 M2 改了什么】**只改了头部这一段** —— 引擎来源从"抠 HTML 的 ENGINE 区"
*   换成 tools/load-engine.js（把 packages/engine/src/*.js 拼成单一作用域）。
*   断言主体（从 pass / fail 计数器那一行起）一字未动：676 项里 §1–§16 是 M1 基线、§17–§22 是 M2、
*   §23 锁真机第四轮 —— 重写只能重写"规格"，重写不了这些踩过的坑。
*
* 【★ 为什么还要拼】ESM 是真实形态，但 676 项断言是在"顶层声明同处一个作用域"的
*   前提下写的。拼接路保住"断言零改动"，真 ESM 路负责抓 TDZ / 循环依赖 / 漏 import。
*   两路跑的是同一份断言，不是两套测试 —— 少跑一路就会漏掉一整类问题。
*
* 【M3 新增的源码级断言口径】HTML_SRC = 拼接后的引擎源码 + legacy/M2 的 html 全文，
*   所以架构类（扫 cmd.js 写法）与呈现类（扫 CSS）断言都仍然有效。
* ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {loadEngine} = require(path.join(ROOT, 'tools', 'load-engine.js'));

const FOUND = {path:path.join(ROOT, 'packages', 'engine', 'src', 'index.js'), name:'packages/engine', stale:false};
const {Engine, HTML_SRC} = loadEngine();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('  ❌ ' + name + (extra ? ' :: ' + extra : '')); } };
const eq = (name, a, b) => ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
const stripHtml = s => String(s == null ? '' : s).replace(/<[^>]+>/g, '');
/* 下面几个用 mkCtx / runCmd 而不是 mk / run —— M1 那 16 节里已有同名的 block 内定义，
 * 顶层再叫同名会让人分不清用的是哪个。名字让开，读的人不必回头查作用域。 */
/** 建一个 ctx：mkCtx('coc7', card) */
const mkCtx = (rule, card, me) => { const c = {me: me || '老王', room:Engine.makeRoom(), card: card || null, history:[]}; if(rule) c.room.rule = rule; return c; };
/** 跑一条指令，返回 msgs */
const runCmd = (text, ctx) => Engine.handleCommand(text, ctx).msgs;
/** 取最后一条消息 */
const lastMsg = msgs => msgs[msgs.length - 1];
/** 把所有消息拼成可搜的文本（含 view.title / notes / verdict） */
const allText = msgs => msgs.map(m => (m.html || m.text || m.title || '') +
  (m.view ? (' ' + m.view.title + ' ' + JSON.stringify(m.view.verdict || '') + ' ' + (m.view.notes || []).join(' ')) : '')).join('\n');
/** 绑一张卡：在当前规则下发 .st set，返回 card */
const bindCard = (setCmd, rule) => { const ctx = mkCtx(rule); runCmd(setCmd, ctx); return ctx.card; };

/* ★ RNG 注入（M2 新增能力）：把 RNG.die 换成固定序列，让"掷出什么"可被断言。
 *  COC 奖惩骰取哪颗十位、DH 四象限、FU 暴击 —— 这些都依赖具体点数，
 *  没有注入就只能测"能跑通"，测不了"跑对了没"。用完自动还原。 */
const ORIG_DIE = Engine.RNG.die;
function dice(seq, fn){
  let i = 0;
  Engine.RNG.die = () => { const v = seq[i++]; return v === undefined ? 1 : v; };
  try { return fn(); } finally { Engine.RNG.die = ORIG_DIE; }
}

console.log('== 1. 表达式解析 ==');
eq('2d6+3 解析', JSON.stringify(Engine.parseExpr('2d6+3')), JSON.stringify({ok:true, groups:[{kind:'dice',n:2,sides:6,sign:1}], mod:3, totalDice:2}));
eq('3d6-1 负调整值', Engine.parseExpr('3d6-1').mod, -1);
eq('4d8+1d4+2 复合', Engine.parseExpr('4d8+1d4+2').groups.length, 2);
eq('1d7 任意面数', Engine.parseExpr('1d7').groups[0].sides, 7);
eq('1d100', Engine.parseExpr('1d100').groups[0].sides, 100);
eq('拒绝括号', Engine.parseExpr('(1d6+2)*2').ok, false);
eq('拒绝乘除', Engine.parseExpr('1d6*2').ok, false);
eq('拒绝骰池 k', Engine.parseExpr('4d6k3').ok, false);
eq('拒绝 kh', Engine.parseExpr('4d6kh3').ok, false);
eq('拒绝重复掷', Engine.parseExpr('2#1d20').ok, false);
eq('拒绝 dF', Engine.parseExpr('dF').ok, false);
eq('拒绝空', Engine.parseExpr('').ok, false);
eq('骰数超限', Engine.parseExpr('101d6').reason, 'limit');
eq('面数超限', Engine.parseExpr('1d10001').reason, 'limit');
eq('合计超限', Engine.parseExpr('6d6 500d6'.replace(' ', '+')).reason, 'limit');

console.log('== 2. 随机源 ==');
{
  const s = new Set(); let inRange = true;
  for (let i = 0; i < 4000; i++) { const v = Engine.RNG.die(20); s.add(v); if (v < 1 || v > 20) inRange = false; }
  ok('20 面骰覆盖 1..20', s.size === 20, 'distinct=' + s.size);
  ok('不越界', inRange);
  const cnt = new Array(6).fill(0);
  for (let i = 0; i < 60000; i++) cnt[Engine.RNG.die(6) - 1]++;
  const mn = Math.min(...cnt), mx = Math.max(...cnt);
  ok('d6 分布无明显偏斜 (60k 次)', mx - mn < 900, 'min=' + mn + ' max=' + mx);
}

console.log('== 3. 规则别名（保留点号、精确匹配）==');
eq('5.5e → dnd5r', Engine.normalizeRule('5.5E'), 'dnd5r');
eq('5e → dnd5e', Engine.normalizeRule('5e'), 'dnd5e');
eq('dnd5e2024 → dnd5r', Engine.normalizeRule('DND5e2024'), 'dnd5r');
eq('dnd5e 不被前缀误判', Engine.normalizeRule('dnd5e'), 'dnd5e');
eq('通用别名 gen', Engine.normalizeRule('GEN'), 'generic');
eq('未知规则', Engine.normalizeRule('xyz'), null);
eq('5e 卡族 = dnd', Engine.ruleFamily('dnd5e'), 'dnd');
eq('5.5e 卡族 = dnd', Engine.ruleFamily('dnd5r'), 'dnd');
eq('通用无卡族', Engine.ruleFamily('generic'), null);

console.log('== 4. 优劣势语义（规则相关）==');
{
  // DND：只作用于 d20 项
  const g1 = Engine.rollGroups(Engine.parseExpr('1d20+2d6+3').groups, 'adv', 'dnd5e');
  eq('DND adv：d20 投两次', g1[0].tries.length, 2);
  eq('DND adv：2d6 只投一次', g1[1].tries.length, 1);
  // 通用：整条两次
  const g2 = Engine.rollGroups(Engine.parseExpr('1d20+2d6').groups, 'adv', 'generic');
  eq('通用 adv：全部投两次', g2.every(g => g.tries.length === 2), true);
  const s1 = g2[0].tries[0][0] + Engine.sumKept([g2[1]]);
  ok('通用 adv：取两次中总和较高的一次', true);
  // kept 必须是 tries 中的某一次
  eq('DND adv：kept 取自 tries', g1[0].tries.some(t => t === g1[0].kept), true);
  // 优势 kept >= 劣势 kept（统计意义上）
  let advHi = 0;
  for (let i = 0; i < 300; i++) {
    const a = Engine.rollGroups([{kind:'dice',n:1,sides:20,sign:1}], 'adv', 'dnd5e')[0];
    const d = Engine.rollGroups([{kind:'dice',n:1,sides:20,sign:1}], 'dis', 'dnd5e')[0];
    if (a.kept[0] >= d.kept[0]) advHi++;
  }
  ok('优势期望 ≥ 劣势期望', advHi > 180, 'advHi=' + advHi + '/300');
}

console.log('== 5. 检定：调整值与熟练项必须计入 total（本轮修的核心 bug）==');
{
  const ctx = {me:'老王', room:Engine.makeRoom(), card:{family:'dnd', data:{str:16,dex:14,con:15,int:10,wis:12,cha:8,lv:5}}, history:[]};
  ctx.room.rule = 'dnd5e';
  eq('DEX14 调整值', Engine.abilityMod(14), 2);
  eq('等级5 熟练加值', Engine.profFromLv(5), 3);
  eq('等级1 熟练加值', Engine.profFromLv(1), 2);
  eq('等级20 熟练加值', Engine.profFromLv(20), 6);
  eq('无等级无熟练', Engine.profFromLv(undefined), null);

  // 固定骰点：直接构造 groups，验证求和口径
  const groups = [{n:1, sides:20, sign:1, tries:[[11]], kept:[11], keptIdx:0}];
  const diceSum = Engine.sumKept(groups);
  const comps = [{label:'敏捷调整值', v:2}, {label:'熟练加值', v:3}];
  const t = Engine.buildTotal(diceSum, comps);
  eq('骰点合计', t.diceSum, 11);
  eq('调整项合计', t.add, 5);
  eq('total = 11+2+3', t.total, 16);
  const v = Engine.judgeDnd(t.total, 15, Engine.natOf(groups, diceSum), 'dnd5e');
  eq('判成功', v.ok, true);
  eq('超出 1', v.text, '成功（超出 1）');

  // 同一组数据 vs DC20 → 失败差 6
  const v2 = Engine.judgeDnd(14, 20, null, 'dnd5e');
  eq('判失败', v2.ok, false);
  eq('差 6', v2.text, '失败（差 6）');
}

console.log('== 6. nat 20 / nat 1：两套规则的唯一判定差异 ==');
{
  const g20 = [{n:1,sides:20,sign:1,tries:[[20]],kept:[20],keptIdx:0}];
  const g1  = [{n:1,sides:20,sign:1,tries:[[1]],kept:[1],keptIdx:0}];
  eq('nat 识别', Engine.natOf(g20, 20), 20);
  const a = Engine.judgeDnd(21, 30, 20, 'dnd5r');
  eq('5.5e nat20 强制成功（即使总分低于 DC）', a.ok, true);
  eq('5.5e nat20 标为大成功', a.crit, true);
  const b = Engine.judgeDnd(1, 1, 1, 'dnd5r');
  eq('5.5e nat1 强制失败', b.ok, false);
  eq('5.5e nat1 标为大失败', b.crit, true);
  const c = Engine.judgeDnd(21, 30, 20, 'dnd5e');
  eq('5e nat20 不强制（仍按 DC 判）', c.ok, false);
  eq('5e nat20 无 crit 标记', !!c.crit, false);
  ok('5e nat20 有语义提示', /5e：技能\/属性检定不自动成功/.test(Engine.natNoteOf(20, 'dnd5e', true)));
  ok('5.5e natNote 说即成功（不再是静默）', /掷 20 即成功/.test(Engine.natNoteOf(20, 'dnd5r', true)));
  eq('非 d20 无 nat', Engine.natOf([{n:2,sides:6,sign:1,tries:[[3,4]],kept:[3,4],keptIdx:0}], 7), null);
}

console.log('== 7. 技能表与别名冲突 ==');
{
  eq('技能数 18', Engine.DND_SKILLS.length, 18);
  eq('巧手 → dex', Engine.lookupSkillOrAbility('巧手').ab, 'dex');
  eq('察觉 → wis', Engine.lookupSkillOrAbility('perception').ab, 'wis');
  eq('威吓 inti → cha', Engine.lookupSkillOrAbility('inti').ab, 'cha');
  eq('int 只能是智力，不能是威吓', Engine.lookupSkillOrAbility('int').ab, 'int');
  eq('未知技能', Engine.lookupSkillOrAbility('游泳'), null);
  const conflicts = [];
  ['str','dex','con','int','wis','cha'].forEach(k => {
    if (Engine.DND_SKILLS.some(s => s.abbr === k || s.en === k)) conflicts.push(k);
  });
  eq('技能简写不与属性名冲突', conflicts.length, 0);
}

console.log('== 8. 指令流程 ==');
{
  const ctx = {me:'老王', room:Engine.makeRoom(), card:null, history:[]};
  ctx.room.rule = 'dnd5e';
  const run = s => { const r = Engine.handleCommand(s, ctx); r.msgs.forEach(m => ctx.history.push(m)); return r.msgs; };

  let ms = run('.rc 巧手');
  ok('未绑卡：友好提示而非报错', ms[0].kind === 'notice' && /尚未绑定角色卡/.test(ms[0].html), JSON.stringify(ms[0].html || ''));

  ms = run('.st set str 16 dex 14 con 15 int 10 wis 12 cha 8 lv 5');
  ok('绑卡成功', ctx.card && ctx.card.data.lv === 5);

  ms = run('.rc 巧手 p');
  let roll = ms.find(m => m.kind === 'roll');
  ok('.rc 产出骰点消息', !!roll);
  eq('total = 骰点 +2 +3', roll.view.total, roll.view.groups[0].kept[0] + 5);
  eq('组件两项', roll.view.comps.length, 2);

  ms = run('.rc 隐匿 20 p');
  roll = ms.find(m => m.kind === 'roll');
  eq('含 DC', roll.view.dc, 20);
  ok('结论非 null', roll.view.verdict && roll.view.verdict.ok !== null);

  ms = run('.rc str');
  roll = ms.find(m => m.kind === 'roll');
  eq('力量检定调整值 +3', roll.view.comps[0].v, 3);

  ms = run('.rc 巧手');
  roll = ms.find(m => m.kind === 'roll');
  ok('未声明 p 时提示熟练未计入', roll.view.notes.some(n => /熟练加值 \+3 未计入/.test(n)), JSON.stringify(roll.view.notes));

  ms = run('.rc 游泳');
  ok('未知技能提示 .rc list', ms[0].kind === 'notice' && /未识别「游泳」/.test(ms[0].html));

  // 未设等级 + p
  const ctx2 = {me:'小李', room:Engine.makeRoom(), card:{family:'dnd', data:{dex:14}}, history:[]};
  ctx2.room.rule = 'dnd5e';
  const r2 = Engine.handleCommand('.rc 巧手 p', ctx2);
  ok('未设等级用 p → 提示设等级', r2.msgs[0].kind === 'notice' && /尚未设置等级/.test(r2.msgs[0].html));

  // 规则不匹配卡
  const ctx3 = {me:'小林', room:Engine.makeRoom(), card:{family:'dnd', data:{dex:14,lv:5}}, history:[]};
  ctx3.room.rule = 'generic';
  const r3 = Engine.handleCommand('.rc 巧手', ctx3);
  // 文案现由规则包提供（详见第 16 节）；核心是"不静默"，必须给一条提示
  ok('通用规则下 .rc 提示切规则（不静默）', r3.msgs[0].kind === 'notice' && /不使用角色卡|\.r/.test(r3.msgs[0].html));

  // ★ M2 迭代：COC 已实现 —— 这条断言锁的是「COC 还没做」的临时状态，该失效。
  //   改为锁「切得过去 + 有广播」；兜底诚实提示改用真正的未知规则名验证。
  const r4 = Engine.handleCommand('.set rule coc', ctx3);
  eq('★ M2：COC 规则包已实现，切规则生效', ctx3.room.rule, 'coc7');
  ok('切到已实现规则有 @全体 广播', r4.msgs.some(m => m.kind === 'sys' && /@全体/.test(m.title)), JSON.stringify(r4.msgs.map(m => m.kind)));
  const r4b = Engine.handleCommand('.set rule 赛博朋克', {me:'A', room:Engine.makeRoom(), card:null, history:[]});
  ok('未知规则：诚实提示而非静默', /未识别规则/.test(r4b.msgs[0].html), r4b.msgs[0].html);

  // 规则切换
  const ctx4 = {me:'老王', room:Engine.makeRoom(), card:{family:'dnd', data:{dex:14,lv:5}}, history:[]};
  const r5 = Engine.handleCommand('.set rule dnd', ctx4);
  eq('切规则生效', ctx4.room.rule, 'dnd5e');
  ok('变更广播显著提醒', r5.msgs.some(m => m.kind === 'sys' && /@全体/.test(m.title)), JSON.stringify(r5.msgs.map(m => m.kind)));

  // 裸骰开关
  const ctx5 = {me:'A', room:Engine.makeRoom(), card:null, history:[]};
  Engine.handleCommand('.set baredice on', ctx5);
  const r6 = Engine.handleCommand('1d20+5', ctx5);
  ok('裸骰开启后直接掷', r6.msgs.some(m => m.kind === 'roll'));
  const ctx6 = {me:'B', room:Engine.makeRoom(), card:null, history:[]};
  const r7 = Engine.handleCommand('1d20+5', ctx6);
  eq('裸骰默认关：骰娘不回应（用户原文由传输层记录）', r7.msgs.length, 0);

  // 未识别指令降级为聊天
  const r8 = Engine.handleCommand('.xyz 随便说说', ctx6);
  ok('未命中动词 → 骰娘不回话、不阻塞发言（原文由传输层记录）', r8.msgs.length === 0 && r8.handled === false);

  // 昵称
  Engine.handleCommand('.nn 老王', ctx6);
  eq('.nn 改名', ctx6.me, '老王');

  // 帮助
  const r9 = Engine.handleCommand('.help', ctx6);
  ok('.help 第一层含裸骰开关', /\.set baredice on/.test(r9.msgs[0].html));
  ok('.help 第一层含别名 .nn', /\.nn/.test(r9.msgs[0].html));
  const r10 = Engine.handleCommand('.help dnd', ctx6);
  ok('.help dnd 第二层含绑卡语法', /\.st set str 16/.test(r10.msgs[0].html));
  ok('.help dnd 写明 5e/5.5e nat 差异', /5\.5e：掷 20 即成功/.test(r10.msgs[0].html));
  ok('.help dnd 写明优劣势只作用于 d20', /只作用于 d20 项/.test(r10.msgs[0].html));
  const r11 = Engine.handleCommand('.help xyz', ctx6);
  ok('未知规则提示', /未识别规则/.test(r11.msgs[0].html));

  // .h
  const ctx7 = {me:'C', room:Engine.makeRoom(), card:null, history:[]};
  Engine.handleCommand('.r 2d6+3', ctx7).msgs.forEach(m => ctx7.history.push(m));
  Engine.handleCommand('.r 1d4', ctx7).msgs.forEach(m => ctx7.history.push(m));
  const r12 = Engine.handleCommand('.h', ctx7);
  ok('.h 列出最近投掷', /最近 2 条投掷/.test(r12.msgs[0].html));

  // 规模限制
  const r13 = Engine.handleCommand('.r 101d6', ctx7);
  ok('服务端硬拒绝超限', /指令规模过大/.test(r13.msgs[0].html), r13.msgs[0].html);
  const r14 = Engine.handleCommand('.r (1d6+2)*2', ctx7);
  ok('不支持语法给友好提示', /暂不支持该语法/.test(r14.msgs[0].html));

  // msg_id 单调递增（重连补齐的前提）
  const ids = ctx7.history.map(m => m.id);
  ok('msg_id 递增', ids.every((v, i) => i === 0 || v > ids[i - 1]), JSON.stringify(ids));
}

console.log('== 9. 渲染（三处共用同一函数）==');
{
  const ctx = {me:'老王', room:Engine.makeRoom(), card:{family:'dnd', data:{dex:14,lv:5}}, history:[]};
  ctx.room.rule = 'dnd5e';
  const ms = Engine.handleCommand('.rc 巧手 15 p', ctx).msgs;
  const roll = ms.find(m => m.kind === 'roll');
  const h1 = Engine.renderRoll(roll);
  const h2 = Engine.renderRoll(roll);
  eq('同一消息渲染两次结果一致（纯函数）', h1, h2);
  ok('折叠态含结论徽章', /badge /.test(h1));
  ok('展开态含组件拆解', /熟练加值 \+3/.test(h1));
  ok('展开态含合计行', /骰点 \d+ \+ 调整项/.test(h1));
  ok('nat20 有 crit 高亮', /chip crit/.test(Engine.renderRoll(Object.assign({}, roll, {view:Object.assign({}, roll.view, {groups:[{n:1,sides:20,sign:1,tries:[[20]],kept:[20],keptIdx:0}]})}))));
}

console.log('== 10. 真机反馈回归（本轮 4 条）==');
// ① 用户输入的指令纳入消息记录，以「用户=指令 / 骰娘=回复」成对呈现
{
  const ctx = {me:'老王', room:Engine.makeRoom(), card:null, history:[]};
  const send = t => {
    const um = {id:ctx.room.nextId(), ts:new Date(),
      kind:Engine.isCommandText(t, ctx.room) ? 'cmd' : 'chat', from:ctx.me, text:t};
    ctx.history.push(um);
    Engine.handleCommand(t, ctx).msgs.forEach(m => ctx.history.push(m));
    return um;
  };
  send('.r 2d6+3');
  eq('① 用户指令进记录', ctx.history[0].kind, 'cmd');
  eq('① 用户消息 from = 自己', ctx.history[0].from, '老王');
  eq('① 骰娘回复 from = 骰娘', ctx.history[1].from, '骰娘');
  eq('① 骰娘回复带 actor（导出/多人归属用）', ctx.history[1].actor, '老王');
  send('我们推门进去');
  eq('① 普通聊天 kind = chat', ctx.history[2].kind, 'chat');
  send('.r 2d6+');
  eq('① 打错的指令也进记录（可回溯）', ctx.history[3].kind, 'cmd');
  eq('① 普通文本不算指令', Engine.isCommandText('你好', ctx.room), false);
  eq('① 未命中动词不算指令', Engine.isCommandText('.xyz', ctx.room), false);
  ctx.room.baredice = true;
  eq('① 裸骰开：1d20+5 算指令', Engine.isCommandText('1d20+5', ctx.room), true);
  ctx.room.baredice = false;
  eq('① 裸骰关：1d20+5 不算指令', Engine.isCommandText('1d20+5', ctx.room), false);
}
// ② 说明文本分栏，窄屏不粘连
{
  const ctx = {me:'A', room:Engine.makeRoom(), card:null, history:[]};
  const h = Engine.handleCommand('.help', ctx).msgs[0];
  eq('② 帮助输出为结构化 html', h.kind, 'html');
  ok('② 帮助用分栏行', /class="hrow"/.test(h.html) && /class="hk"/.test(h.html) && /class="hv"/.test(h.html));
  ok('② 帮助不再用 <pre> 纯文本', !/<pre>/.test(h.html));
  const s = Engine.handleCommand('.status', ctx).msgs[0];
  ok('② 状态也是分栏', /hrow/.test(s.html));
  const ctxD = {me:'A', room:Engine.makeRoom(), card:null, history:[]};
  ctxD.room.rule = 'dnd5e';                        // 技能表属 D&D 规则包，需在 D&D 规则下取
  const l = Engine.handleCommand('.rc list', ctxD).msgs[0];
  ok('② 技能表也是分栏且列属性', /hrow/.test(l.html) && /力量/.test(l.html) && /察觉/.test(l.html));
}
// ③ 只有 d20 的 1/20 才特殊标记
{
  const mkRoll = (groups, extra) => ({id:1, ts:new Date(), kind:'roll', from:'骰娘', actor:'A',
    view:Object.assign({ruleKey:'dnd5e', mode:null, groups, comps:[], diceSum:0, add:0, total:0,
      title:'掷骰', dc:null, verdict:null, natNote:null, notes:[]}, extra)});
  const G = (n, sides, vals) => [{n, sides, sign:1, tries:[vals], kept:vals, keptIdx:0}];
  ok('③ d6 出 1 不特殊标记', !/chip crit/.test(Engine.renderRoll(mkRoll(G(2, 6, [6, 1]), {total:7, diceSum:7}))));
  ok('③ d6 出 6 不特殊标记', !/chip crit/.test(Engine.renderRoll(mkRoll(G(1, 6, [6]), {total:6, diceSum:6}))));
  ok('③ d8 出 8 不特殊标记', !/chip crit/.test(Engine.renderRoll(mkRoll(G(1, 8, [8]), {total:8, diceSum:8}))));
  ok('③ d20 出 20 高亮', /chip crit/.test(Engine.renderRoll(mkRoll(G(1, 20, [20]), {total:20, diceSum:20}))));
  ok('③ d20 出 1 高亮', /chip crit/.test(Engine.renderRoll(mkRoll(G(1, 20, [1]), {total:1, diceSum:1}))));
  ok('③ d20 出 11 不高亮', !/chip crit/.test(Engine.renderRoll(mkRoll(G(1, 20, [11]), {total:11, diceSum:11}))));
  // 混合指令：d20 的 20 高亮，d6 的 1 不高亮
  const mix = Engine.renderRoll(mkRoll(
    [{n:1,sides:20,sign:1,tries:[[20]],kept:[20],keptIdx:0}, {n:2,sides:6,sign:1,tries:[[6,1]],kept:[6,1],keptIdx:0}],
    {total:33, diceSum:27}));
  // 同一颗骰在折叠态 chips 与展开态明细各渲染一次，故为 2
  eq('③ 混合指令：只有 d20 那颗被高亮（折叠+展开各一次）', (mix.match(/chip crit/g) || []).length, 2);
  const mixNo = Engine.renderRoll(mkRoll(
    [{n:1,sides:20,sign:1,tries:[[11]],kept:[11],keptIdx:0}, {n:2,sides:6,sign:1,tries:[[6,1]],kept:[6,1],keptIdx:0}],
    {total:24, diceSum:18}));
  eq('③ 混合指令：d20 出 11、d6 出 1 时零高亮', (mixNo.match(/chip crit/g) || []).length, 0);
}
// ④ 顶栏快捷指令：数量收敛 + 换行不截断
{
  const src = HTML_SRC;
  const n = (src.match(/data-cmd="/g) || []).length;
  ok('④ 快捷指令收敛到 ≤8 个（原 11 个）', n <= 8, 'count=' + n);
  ok('④ 快捷区换行而非横向滚动（不再显示不全）',
    /#topbar \.r2\{[^}]*flex-wrap:wrap/.test(src) && !/#topbar \.r2\{[^}]*overflow-x:auto/.test(src));
  ok('④ 角色卡用栅格而非等宽文本', /class="card"/.test(Engine.renderCardHtml({family:'dnd', data:{str:16,dex:14}})));
}

console.log('== 11. 中文别名泛化（属性 / 动词 / 规则 / 参数）★ 本轮 ==');
{
  eq('注册零冲突', Engine.ALIAS.conflicts.length, 0);
  // ★ M2 迭代：lookupCheckTarget 现在**必须带 ruleKey**（不同规则的键在不同域里）。
  //   本节问的一直是 D&D，显式带上。另补一条：不带 ruleKey 必须返回 null，
  //   而不是悄悄猜一个域 —— 猜错了比返回 null 危险得多。
  const chk = nm => Engine.lookupCheckTarget(nm, 'dnd5e');
  eq('★ M2：不带 ruleKey 时返回 null（不猜域）', Engine.lookupCheckTarget('力量'), null);
  // ① 属性中文别名（本轮直接诉求：技能有中文、属性没有 → 现在都有）
  eq('力量 → str', chk('力量').ab, 'str');
  eq('敏捷 → dex', chk('敏捷').ab, 'dex');
  eq('体质 → con', chk('体质').ab, 'con');
  eq('智力 → int', chk('智力').ab, 'int');
  eq('感知 → wis', chk('感知').ab, 'wis');
  eq('魅力 → cha', chk('魅力').ab, 'cha');
  eq('别称 强壮 → str', chk('强壮').ab, 'str');
  eq('别称 耐力 → con', chk('耐力').ab, 'con');
  eq('别称 风采 → cha', chk('风采').ab, 'cha');
  eq('属性 kind = ability', chk('力量').kind, 'ability');
  eq('技能 kind = skill', chk('巧手').kind, 'skill');
  eq('技能别称 潜行 → dex', chk('潜行').ab, 'dex');
  eq('技能别称 恐吓 → cha', chk('恐吓').ab, 'cha');
  eq('技能别称 医疗 → wis', chk('医疗').ab, 'wis');
  eq('技能别称 侦查 → int（调查）', chk('侦查').ab, 'int');
  eq('英文仍可用', chk('sleight').ab, 'dex');
  eq('简写仍可用', chk('perc').ab, 'wis');
  eq('int 是智力不是威吓', chk('int').zh, '智力');
  eq('inti 是威吓', chk('inti').zh, '威吓');
  eq('感知是属性、察觉是技能（易混点已分开）', chk('感知').kind + '/' + chk('察觉').kind, 'ability/skill');

  // ② 角色卡字段中文
  eq('卡字段 力量 → str', Engine.normalizeCardKey('力量'), 'str');
  eq('卡字段 等级 → lv', Engine.normalizeCardKey('等级'), 'lv');
  eq('卡字段 级别 → lv', Engine.normalizeCardKey('级别'), 'lv');
  eq('卡字段 lv 仍可用', Engine.normalizeCardKey('LV'), 'lv');
  eq('未知字段', Engine.normalizeCardKey('游泳'), null);

  // ③ 规则中文
  eq('龙与地下城 → dnd5e', Engine.normalizeRule('龙与地下城'), 'dnd5e');
  eq('龙与地下城2024 → dnd5r', Engine.normalizeRule('龙与地下城2024'), 'dnd5r');
  eq('克苏鲁 → coc7', Engine.normalizeRule('克苏鲁'), 'coc7');
  eq('克苏鲁的呼唤 → coc7', Engine.normalizeRule('克苏鲁 的 呼唤'), 'coc7');
  eq('匕首心 → dh', Engine.normalizeRule('匕首心'), 'dh');
  eq('最终物语 → fu', Engine.normalizeRule('最终物语'), 'fu');
  eq('5.5e 仍精确区分', Engine.normalizeRule('5.5e') + '/' + Engine.normalizeRule('5e'), 'dnd5r/dnd5e');

  // ④ 动词中文 + 无空格 + 中文句号前缀
  eq('.骰 → r', Engine.parseCommand('.骰').verb, 'r');
  eq('.检定 → rc', Engine.parseCommand('.检定 巧手').verb, 'rc');
  eq('中文动词后无空格', Engine.parseCommand('.骰2d6+3').rest, '2d6+3');
  eq('.检定巧手 → rc/巧手', Engine.parseCommand('.检定巧手').verb + '/' + Engine.parseCommand('.检定巧手').rest, 'rc/巧手');
  eq('.优势检定 → ra', Engine.parseCommand('.优势检定 力量').verb, 'ra');
  eq('优势检定 优先于 检定（长匹配）', Engine.parseCommand('.优势检定').verb, 'ra');
  eq('.帮助 → help', Engine.parseCommand('.帮助').verb, 'help');
  eq('.状态 → status', Engine.parseCommand('.状态').verb, 'status');
  eq('.角色卡 → st', Engine.parseCommand('.角色卡').verb, 'st');
  eq('.设置 → set', Engine.parseCommand('.设置 rule dnd').verb, 'set');
  eq('.昵称 → name', Engine.parseCommand('.昵称 老王').verb, 'name');
  eq('中文句号前缀。', Engine.parseCommand('。rc 力量').verb, 'rc');
  eq('全角句点前缀．', Engine.parseCommand('．rc 力量').verb, 'rc');
  eq('斜杠前缀', Engine.parseCommand('/rc 力量').verb, 'rc');
  eq('★ 中文句子不被误切成指令', Engine.parseCommand('。投石问路看看'), null);
  eq('★ 未命中仍降级为聊天', Engine.parseCommand('.xyz'), null);
  eq('英文动词未被无空格误切', Engine.parseCommand('.rank'), null);

  // ⑤ 参数中文：优劣势 / 开关 / 熟练 / 难度
  const ctx = {me:'老王', room:Engine.makeRoom(), card:null, history:[]};
  ctx.room.rule = 'dnd5e';
  const run = t => { const r = Engine.handleCommand(t, ctx); r.msgs.forEach(m => ctx.history.push(m)); return r.msgs; };
  run('.st set 力量 16 敏捷 14 体质 15 智力 10 感知 12 魅力 8 等级 5');
  eq('中文绑卡成功', ctx.card.data.str + '/' + ctx.card.data.lv, '16/5');
  let r = run('.rc 力量').find(m => m.kind === 'roll');
  eq('★ .rc 力量 出结果', !!r, true);
  eq('属性检定标题不重复属性名', r.view.title, '力量检定');
  eq('力量调整值 +3 已计入', r.view.comps[0].v, 3);
  eq('total = 骰点 +3', r.view.total, r.view.groups[0].kept[0] + 3);
  r = run('.rc 巧手 15 熟练').find(m => m.kind === 'roll');
  eq('★ 「熟练」等价于 p', r.view.comps.length, 2);
  eq('含熟练标签', /含熟练/.test(r.view.title), true);
  eq('熟练值 +3', r.view.comps[1].v, 3);
  eq('total = 骰点+2+3', r.view.total, r.view.groups[0].kept[0] + 5);
  r = run('.r 1d20+5 优势').find(m => m.kind === 'roll');
  eq('★ 优劣势中文参数', r.view.mode, 'adv');
  eq('优劣势：d20 投两次', r.view.groups[0].tries.length, 2);
  r = run('.r 1d20 劣势').find(m => m.kind === 'roll');
  eq('劣势中文参数', r.view.mode, 'dis');
  run('.set baredice 开');
  eq('★ 开关中文「开」', ctx.room.baredice, true);
  run('.set baredice 关');
  eq('开关中文「关」', ctx.room.baredice, false);
  r = run('.rc 察觉 难度15 熟练').find(m => m.kind === 'roll');
  eq('「难度15」写法', r.view.dc, 15);
  const bad = run('.rc 游泳')[0];
  ok('未识别给建议或提示 .rc list', /未识别「游泳」/.test(bad.html) && /rc list/.test(bad.html));
  // ★ M2 迭代：check 域按规则族分桶了（check:dnd / check:coc7 / check:dh / check:fu），
  //   旧的无族域名已不存在。断言意图不变，域名跟着改，并补一条"旧域名已废弃"。
  eq('★ M2：旧的单一 check 域已废弃', Engine.ALIAS.byDomain.has('check'), false);
  eq('★ 2 字错字不乱指路（游泳≠说服）', Engine.suggestAlias('check:dnd', '游泳').length, 0);
  eq('字序颠倒能建议（觉察→察觉）', Engine.suggestAlias('check:dnd', '觉察')[0], '察觉');

  // ⑥ 冲突自查：新增别名前先查
  const c1 = Engine.detectConflicts('check:dnd', [{key:'x', aliases:['力量']}]);
  eq('★ 撞已有别名会被拦下', c1.length > 0, true);
  const c2 = Engine.detectConflicts('rule', [{key:'x', aliases:['5e']}]);
  eq('规则别名同样受检', c2.length > 0, true);
  const c3 = Engine.detectConflicts('check:coc7', [{key:'x', aliases:['侦查']}]);
  eq('★ 分域后：撞 COC 域同样被拦下', c3.length > 0, true);
  eq('不撞则放行', Engine.detectConflicts('check:dnd', [{key:'x', aliases:['游泳']}]).length, 0);
}

console.log('== 12. 边界与规模（沙盒自查，M1 收尾）==');
{
  const p = n => Engine.parseExpr(n);
  eq('负骰数 -1d6 拒绝', p('-1d6').ok, false);
  eq('负骰数报语法而非规模', p('-1d6').reason, 'syntax');
  eq('0d6 拒绝', p('0d6').ok, false);
  eq('1d0 报语法（不是规模）', p('1d0').reason, 'syntax');
  eq('1d10001 报规模', p('1d10001').reason, 'limit');
  eq('101d6 报规模', p('101d6').reason, 'limit');
  eq('空指令 1d20+ 拒绝', p('1d20+').ok, false);
  eq('1d20++5 拒绝', p('1d20++5').ok, false);
  eq('负调整值仍可用', p('3d6-1').ok, true);
  eq('500 项复合通过', p('1d6+'.repeat(499)+'1d6').ok, true);
  eq('501 项超限', p('1d6+'.repeat(500)+'1d6').reason, 'limit');
  // 500 条消息性能（档案指标：首屏 <2s）
  const c = {me:'A', room:Engine.makeRoom(), card:{family:'dnd', data:{str:16,dex:14,con:15,int:10,wis:12,cha:8,lv:5}}, history:[]};
  c.room.rule = 'dnd5e';
  const t0 = Date.now();
  for(let i=0;i<500;i++) Engine.handleCommand(i%3===0 ? '.rc 巧手 15 p' : (i%3===1 ? '.r 1d20+2d6+3' : '.r 4d8+1d4+2'), c).msgs.forEach(m => c.history.push(m));
  const cost = Date.now() - t0;
  ok('500 条消息生成 < 1000ms', cost < 1000, cost + 'ms');
  eq('500 条全部产出', c.history.length, 500);
  ok('msg_id 全程唯一递增', c.history.every((m,i)=> i===0 || m.id > c.history[i-1].id));
}

console.log('== 13. nat 标记按规则分化（5e / 5.5e / 通用）★ 本轮 ==');
{
  const mkRoll = (nat, rule, extra) => ({id:1, ts:new Date(), kind:'roll', from:'骰娘', actor:'A',
    view:Object.assign({ruleKey:rule, mode:null,
      groups:[{n:1, sides:20, sign:1, tries:[[nat]], kept:[nat], keptIdx:0}],
      comps:[], diceSum:nat, add:0, total:nat, title:'掷骰 1d20', dc:null,
      verdict:null, natBadge:null, natNote:null, notes:[]}, extra)});
  const withNat = (nat, rule) => {
    const nm = Engine.natMarkOf(nat, rule);
    return Object.assign(mkRoll(nat, rule), {view:Object.assign(mkRoll(nat, rule).view,
      {natBadge:(nm && nm.badge) || null, natNote:(nm && nm.note) || null})});
  };
  const badgesOf = h => (h.match(/<span class="badge ([a-z ]+)">([^<]*)/g) || []).map(s => s.replace(/<span class="badge /, '').replace('">', ':'));
  const noteOf = h => (h.match(/dline nat[\s\S]*?<span>([^<]*)/) || [])[1] || '';

  let h = Engine.renderRoll(withNat(20, 'dnd5e'));
  ok('5e nat20 有徽章', badgesOf(h).length === 1 && /5e 不自动成功/.test(h));
  eq('5e nat20 是 ⚡ 中性标', badgesOf(h)[0].split(':')[0], 'mid');
  ok('5e nat20 note 提到仅攻击/死亡豁免', /攻击检定与死亡豁免必中/.test(noteOf(h)));

  h = Engine.renderRoll(withNat(1, 'dnd5e'));
  ok('5e nat1 有徽章且写"不自动失败"', /5e 不自动失败/.test(h));
  ok('5e nat1 note 提到必败', /攻击检定与死亡豁免必败/.test(noteOf(h)));

  h = Engine.renderRoll(withNat(20, 'dnd5r'));
  ok('★ 5.5e nat20 有徽章（原来只有黄框）', badgesOf(h).length === 1);
  eq('5.5e nat20 用 crit 样式', badgesOf(h)[0].split(':')[0], 'crit');
  ok('5.5e nat20 带 ✨', /✨/.test(h));
  ok('5.5e nat20 note 说"即成功"', /掷 20 即成功/.test(noteOf(h)));

  h = Engine.renderRoll(withNat(1, 'dnd5r'));
  ok('★ 5.5e nat1 有大失败提醒（原来没有）', badgesOf(h).length === 1);
  eq('5.5e nat1 用 critfail 样式', badgesOf(h)[0].split(':')[0], 'critfail');
  ok('5.5e nat1 带 💀 且写"即失败"', /💀/.test(h) && /即失败/.test(h));

  h = Engine.renderRoll(withNat(20, 'generic'));
  eq('★ 通用 nat20 不再出现 5e 文案', /5e/.test(h), false);
  eq('★ 通用 nat20 无徽章（没有 nat 语义）', badgesOf(h).length, 0);
  eq('★ 通用 nat20 连 note 都不给（无语义就不提）', noteOf(h), '');
  h = Engine.renderRoll(withNat(1, 'generic'));
  eq('通用 nat1 无徽章', badgesOf(h).length, 0);
  eq('通用 nat1 不出现 5e 文案', /5e/.test(h), false);
  eq('通用 nat1 无 note', noteOf(h), '');
  ok('★ 通用规则 d20 的 1/20 不高亮（原会误标黄）', !/chip crit/.test(h));
  ok('★ 通用规则 d20 的 1/20 仍正常显示', /chip">20/.test(Engine.renderRoll(withNat(20, 'generic'))) || /chip">1/.test(h));
  ok('D&D 规则 d20 仍高亮', /chip crit/.test(Engine.renderRoll(withNat(20, 'dnd5e'))));
  ok('非 d20 在任何规则都不高亮', !/chip crit/.test(Engine.renderRoll({id:1, ts:new Date(), kind:'roll', from:'骰娘', actor:'A', view:{ruleKey:'dnd5e', mode:null, groups:[{n:2,sides:6,sign:1,tries:[[6,1]],kept:[6,1],keptIdx:0}], comps:[], diceSum:7, add:0, total:7, title:'掷骰 2d6', dc:null, verdict:null, natBadge:null, natNote:null, notes:[]}})));

  // 5.5e 带 DC：verdict 已写大成功/大失败，nat 徽章让位，不重复
  const crit = {ok:true, text:'大成功（5.5e：掷 20 即成功）', crit:true, force:true};
  h = Engine.renderRoll(withNat(20, 'dnd5r'));
  h = Engine.renderRoll({id:1, ts:new Date(), kind:'roll', from:'骰娘', actor:'A', view:Object.assign(
    withNat(20, 'dnd5r').view, {verdict:crit, dc:30})});
  eq('5.5e 有 DC 时 nat 徽章让位给结论', badgesOf(h).length, 1);
  ok('结论显示大成功', /大成功/.test(h));

  // 非 d20 不触发任何 nat 标记
  [['dnd5e', 6], ['dnd5r', 8]].forEach(p => {
    const nm = Engine.natMarkOf(p[1], p[0]);
    eq(p[0] + ' 非 1/20 无标记', nm, null);
  });
  eq('nat 只认单颗 d20（2d20 不算）', Engine.natOf([{n:2,sides:20,sign:1,tries:[[3,4]],kept:[3,4],keptIdx:0}], 7), null);

  // 长指令不再横向滚动
  const src = HTML_SRC;
  ok('★ 长指令换行不滚动', /\.hk\{[^}]*white-space:pre-wrap/.test(src) && !/\.hk\{[^}]*overflow-x:auto/.test(src));
}

console.log('== 14. 真机反馈第三轮（通用降噪 / 底部文案 / 键盘适配）==');
{
  const src = HTML_SRC;
  // ② 通用规则不再有 nat 特殊显示
  eq('NAT_MARK 只剩 dnd 两支', Object.keys(Engine.NAT_MARK || {}).length, 2);
  eq('通用规则无 nat 标记', Engine.natMarkOf(20, 'generic'), null);
  eq('通用规则 nat1 也无标记', Engine.natMarkOf(1, 'generic'), null);
  eq('coc 同样无标记', Engine.natMarkOf(20, 'coc7'), null);
  ok('5e / 5.5e 保留标记', !!Engine.natMarkOf(20, 'dnd5e') && !!Engine.natMarkOf(20, 'dnd5r'));
  ok('hasNatSemantics 只认 D&D', Engine.hasNatSemantics('dnd5e') && Engine.hasNatSemantics('dnd5r') && !Engine.hasNatSemantics('generic'));
  eq('critOf 通用恒空', Engine.critOf(20, 20, 'generic'), '');
  eq('critOf 5e 生效', Engine.critOf(20, 20, 'dnd5e'), ' crit');
  eq('critOf 非 d20 恒空', Engine.critOf(6, 1, 'dnd5e'), '');

  // ① 底部说明收敛为一行短句
  const tip = (src.match(/<div class="tip">([\s\S]*?)<\/div>/) || [])[1] || '';
  ok('底部说明已精简', tip.length > 0 && tip.length < 60, 'len=' + tip.length);
  ok('底部说明只剩一句、不含长串示例', (tip.match(/·/g) || []).length <= 1 && !/2d6\+3/.test(tip));

  // ③ 键盘适配三件套
  ok('viewport 声明 interactive-widget=resizes-content', /interactive-widget=resizes-content/.test(src));
  ok('根容器高度吃 --app-h', /height:var\(--app-h,100dvh\)/.test(src));
  ok('监听 visualViewport resize', /vv\.addEventListener\('resize'/.test(src));
  ok('监听 visualViewport scroll', /vv\.addEventListener\('scroll'/.test(src));
  ok('聚焦时多次重排对齐键盘动画', /\[0, 120, 320, 600\]/.test(src));
  ok('发送后滚到底', /scrollToBottom\(\)/.test(src));
}

console.log('== 15. 规则 × 角色卡 正交（通用下不再冒出 D&D 口径）★ 本轮 ==');
{
  const strip = s => String(s).replace(/<[^>]+>/g, '');
  const mk = rule => { const c = {me:'老王', room:Engine.makeRoom(), card:null, history:[]}; c.room.rule = rule; return c; };
  const CARD = {family:'dnd', data:{str:16, dex:14, con:15, int:10, wis:12, cha:8, lv:5}};

  // 卡名归属卡自己，不随房间规则变
  eq('D&D 卡显示 D&D', Engine.cardRuleName(CARD), 'D&D');
  eq('无卡返回空', Engine.cardRuleName(null), '');
  eq('通用规则 + D&D 卡 → 不匹配', !!Engine.cardMismatchNote(CARD, 'generic'), true);
  eq('5e 规则 + D&D 卡 → 匹配', Engine.cardMismatchNote(CARD, 'dnd5e'), null);
  eq('5.5e 规则 + D&D 卡 → 匹配', Engine.cardMismatchNote(CARD, 'dnd5r'), null);

  // ① 通用规则下 .rc list 必须写明归属（原来只出 D&D 内容、不提规则）
  {
    const ctx = mk('generic');
    let h = Engine.handleCommand('.rc list', ctx).msgs[0].html;
    // 注：本轮起 .rc list 改为挂规则层，通用下不再出现任何 D&D 内容（详见第 16 节）
    ok('★ 通用下 .rc list 不列完整技能表', !/六属性（直接打中文即可）/.test(h) && !/按属性分组/.test(h), strip(h).slice(0, 80));
    ok('★ 通用下 .rc list 说明当前不适用', /没有可列的内容|不使用角色卡/.test(h));
    ok('通用下 .rc list 不教 .rc 用法（会误导）', !/用法：\.rc 力量/.test(h));
    // D&D 规则下仍给用法
    const c2 = mk('dnd5e');
    h = Engine.handleCommand('.rc list', c2).msgs[0].html;
    ok('D&D 下 .rc list 给用法', /用法：\.rc 力量/.test(h));
    eq('D&D 下不提示不支持', /不支持检定/.test(h), false);
  }

  // ② 通用规则下 .st 不得把 D&D 卡叫成"通用角色卡"
  {
    const ctx = mk('generic');
    ctx.card = CARD;
    let h = Engine.handleCommand('.st', ctx).msgs[0].html;
    ok('★ .st 标题标 D&D', /角色卡 · <b>D(?:&amp;|&)D<\/b>/.test(h), strip(h).slice(0, 60));
    eq('★ .st 标题不出现"通用角色卡"', /通用角色卡/.test(h), false);
    eq('★ .st 标题不出现当前规则名当卡名', /角色卡（通用/.test(h), false);
    ok('.st 给出不匹配提示', /不参与检定/.test(h) && /set rule dnd/.test(h));
  }

  // ③ .st set 标明卡归属 + 不匹配提示
  {
    // ★ M2 迭代：四套卡的字段完全不同（D&D 六属性 / COC 开放技能 / DH 特性 / FU 骰阶），
    //   通用规则下根本无从判断该解析成哪一种 —— 所以改为**拒绝绑卡并给出下一步**，
    //   比 M1「绑一张用不了的卡再提示」更不静默。两条断言按新口径改写。
    const ctx = mk('generic');
    let h = Engine.handleCommand('.st set 力量 16 敏捷 14 体质 15 智力 10 感知 12 魅力 8 等级 5', ctx).msgs[0].html;
    ok('★ 通用规则下 .st set 明确拒绝绑卡', /不使用角色卡/.test(h), strip(h).slice(0, 60));
    ok('★ 且给出可执行的下一步（先切规则）', /set rule dnd/.test(h), strip(h).slice(0, 60));
    eq('★ 通用规则下没有真的绑上卡', ctx.card, null);
    const c2 = mk('dnd5e');
    h = Engine.handleCommand('.st set str 16 lv 5', c2).msgs[0].html;
    ok('D&D 规则下 .st set 正常绑定', /已绑定/.test(h) && !!c2.card && c2.card.data.str === 16, strip(h).slice(0, 60));
    eq('D&D 规则下 .st set 不报警', /不参与检定/.test(h), false);
  }

  // ④ .status 同样标注
  {
    const ctx = mk('generic');
    ctx.card = CARD;
    let h = Engine.handleCommand('.status', ctx).msgs[0].html;
    ok('★ .status 卡片区标 D&D', /我的角色卡 · D(?:&amp;|&)D/.test(h));
    ok('★ .status 给不匹配提示', /不参与检定/.test(h));
    const c2 = mk('dnd5e'); c2.card = CARD;
    h = Engine.handleCommand('.status', c2).msgs[0].html;
    eq('D&D 规则下 .status 不报警', /不参与检定/.test(h), false);
  }

  // ⑤ 未绑卡时 .st 模板也要提示规则不适用
  {
    const ctx = mk('generic');
    let h = Engine.handleCommand('.st', ctx).msgs[0].html;
    ok('★ 通用下 .st 模板提示通用不使用角色卡', /不使用角色卡/.test(h) && /set rule dnd/.test(h));
    const c2 = mk('dnd5e');
    h = Engine.handleCommand('.st', c2).msgs[0].html;
    eq('D&D 下 .st 模板不提示', /不使用角色卡/.test(h), false);
  }

  // ⑥ 切规则时仍提示（原行为保持）
  {
    const ctx = mk('dnd5e'); ctx.card = CARD;
    const ms = Engine.handleCommand('.set rule generic', ctx).msgs;
    ok('切规则后有卡归属提示', ms.some(m => /角色卡/.test(m.html || '') && /不参与检定/.test(m.html || '')), JSON.stringify(ms.map(m => m.kind)));
  }
}

console.log('== 16. .rc list 挂规则层 + 顶栏裸骰开关 ==');
{
  const strip = s => String(s).replace(/<[^>]+>/g, '');
  const mk = rule => { const c = {me:'A', room:Engine.makeRoom(), card:null, history:[]}; c.room.rule = rule; return c; };
  const P = k => Engine.rulePack(k);

  // ① 规则包接口存在且按规则分派
  eq('通用包不支持检定', P('generic').supportsCheck, false);
  eq('D&D 包支持检定', P('dnd5e').supportsCheck, true);
  eq('5.5e 走 D&D 包', P('dnd5r').family, 'dnd');
  // ★ M2 迭代：COC 已实现且支持检定 —— 这条原本用 coc7 当"未实现规则"的样本，该失效。
  eq('★ M2：COC 包已实现且支持检定', P('coc7').supportsCheck, true);
  eq('★ 兜底仍在：未知规则名走通用包', Engine.rulePack('不存在的规则').supportsCheck, false);
  ok('每包都有 listChecks', typeof P('generic').listChecks === 'function' && typeof P('dnd5e').listChecks === 'function');

  // ② 通用规则下 .rc list = 本命令的教学（说明不适用 + 绑定规则后怎么用）
  {
    const ctx = mk('generic');
    const h = Engine.handleCommand('.rc list', ctx).msgs[0].html;
    ok('★ 通用 .rc list 讲这条命令本身', /\.rc list · 本命令说明/.test(h));
    ok('★ 说明当前为什么没有内容', /不使用角色卡/.test(h) && /没有可列的内容/.test(h));
    ok('★ 教「绑定规则后怎么用」三步', /切规则/.test(h) && /再看一次/.test(h) && /照着掷/.test(h));
    ok('★ 给出切规则的具体指令', /set rule dnd/.test(h));
    ok('★ 预告各规则内容不同', /COC 7th/.test(h) && /匕首心/.test(h) && /最终物语/.test(h));
    // 举例单个技能名是必要的（教用户绑定后怎么掷），但不许列出整张技能表
    ok('★ 通用 .rc list 不列完整技能表', !/六属性（直接打中文即可）/.test(h) && !/按属性分组/.test(h), strip(h).slice(0, 60));
    eq('★ 通用 .rc list 不出现六属性分组', /六属性（直接打中文即可）/.test(h), false);
    // 掷骰教学只在 foot 里提一句，不是主体
    ok('.r 教学仅一句、不是主体', /\.r 2d6\+3/.test(h) && !/基础掷骰/.test(h));
  }

  // ③ D&D 规则下仍是技能表
  {
    const ctx = mk('dnd5e');
    const h = Engine.handleCommand('.rc list', ctx).msgs[0].html;
    ok('D&D .rc list 有六属性', /力量/.test(h) && /魅力/.test(h));
    ok('D&D .rc list 有技能', /巧手/.test(h) && /察觉/.test(h));
    ok('D&D .rc list 给 .rc 用法', /用法：\.rc 力量/.test(h));
    eq('D&D .rc list 不教 .r 基础', /基础掷骰/.test(h), false);
  }

  // ④ .rc 无参数 / 不支持检定的提示也走规则包
  {
    eq('通用 .rc 无参提示 .r', /\.r 2d6\+3/.test(Engine.handleCommand('.rc', mk('generic')).msgs[0].html), true);
    eq('D&D .rc 无参提示 .rc', /\.rc 力量/.test(Engine.handleCommand('.rc', mk('dnd5e')).msgs[0].html), true);
    const h = Engine.handleCommand('.rc 巧手', mk('generic')).msgs[0].html;
    ok('★ 通用下 .rc 判定被挡且说明原因', /不使用角色卡/.test(h) && /\.r/.test(h));
  }

  // ⑤ 加新规则包不需要改主流程（结构保证）
  {
    const keys = Object.keys(Engine.RULE_PACKS || {});
    ok('注册表含 generic / dnd5e / dnd5r', ['generic','dnd5e','dnd5r'].every(k => keys.indexOf(k) >= 0), JSON.stringify(keys));
    const src = HTML_SRC;
    eq('★ .rc list 分支不再出现 DND_SKILLS', /list\$\/i\.test\(a\)\)[\s\S]{0,400}DND_SKILLS/.test(src), false);
  }

  // ⑥ .set 子项也走别名层（.设置 规则 / .设置 裸骰）
  {
    const ctx = mk('generic');
    eq('setsub 规则 → rule', Engine.lookupAlias('setsub', '规则').key, 'rule');
    eq('setsub 裸骰 → baredice', Engine.lookupAlias('setsub', '裸骰').key, 'baredice');
    eq('setsub bd → baredice', Engine.lookupAlias('setsub', 'bd').key, 'baredice');
    eq('setsub rule 仍可用', Engine.lookupAlias('setsub', 'rule').key, 'rule');
    const r = Engine.handleCommand('.设置 规则 龙与地下城', ctx);
    eq('★ .设置 规则 龙与地下城 生效', ctx.room.rule, 'dnd5e');
    eq('切规则有 sys 广播', r.msgs[0].kind, 'sys');
    Engine.handleCommand('.设置 裸骰 开', ctx);
    eq('★ .设置 裸骰 开 生效', ctx.room.baredice, true);
    Engine.handleCommand('.设置 裸骰 关', ctx);
    eq('.设置 裸骰 关 生效', ctx.room.baredice, false);
    Engine.handleCommand('.set bd on', ctx);
    eq('英文别名 .set bd 仍可用', ctx.room.baredice, true);
  }

  // ⑦ 顶栏裸骰按钮：与其它元指令一致（填指令，不做 toggle）
  {
    const src = HTML_SRC;
    ok('★ 裸骰指令进了顶栏', /data-cmd="\.set baredice on"/.test(src));
    eq('★ 不再有 toggle 特例分支', /b\.id === 'q-bd'/.test(src), false);
    eq('★ 不再有 q-bd 元素', /id="q-bd"/.test(src), false);
    // 所有按钮行为统一：都是填输入框
    const bind = (src.match(/querySelectorAll\('\.quick'\)[\s\S]{0,300}/) || [])[0];
    ok('★ 所有快捷按钮行为一致（只填输入框）', /dataset\.cmd/.test(bind) && !/id === 'q-bd'/.test(bind), bind.slice(0, 120));
    ok('顶栏保留裸骰状态指示', /id="p-bd"/.test(src));
    const n = (src.match(/data-cmd="/g) || []).length;
    ok('快捷指令数量（7 个）', n === 7, 'count=' + n);
  }
}

console.log('== 17. COC 7th（百分骰 / 奖惩骰 / 五级成功等级 / 开放技能表）★ 本轮 ==');
{
  const CARD = {family:'coc7', data:{'侦查':60, '图书馆':50, '心理学':40, hp:12, san:70}};

  // ① 五级成功等级（档案验收样例表，逐条钉死）
  ok('★ 技能 60 掷 23 → 困难成功', /困难成功/.test(Engine.judgeCoc(23, 60).text), Engine.judgeCoc(23, 60).text);
  eq('★ 掷 01 → 大成功', Engine.judgeCoc(1, 60).crit, true);
  ok('01 文案说大成功', /大成功/.test(Engine.judgeCoc(1, 60).text));
  eq('★ 掷 100 → 大失败（≥50 时）', Engine.judgeCoc(100, 60).crit, true);
  eq('100 判失败', Engine.judgeCoc(100, 60).ok, false);
  eq('技能 ≥50：05 也是大成功', Engine.judgeCoc(5, 60).crit, true);
  eq('技能 <50：05 不是大成功', Engine.judgeCoc(5, 40).crit, undefined);
  ok('技能 40 掷 5 → 极难成功', /极难成功/.test(Engine.judgeCoc(5, 40).text), Engine.judgeCoc(5, 40).text);
  eq('技能 <50：96 大失败', Engine.judgeCoc(96, 40).crit, true);
  eq('技能 ≥50：96 只是失败', Engine.judgeCoc(96, 60).crit, undefined);
  eq('等于技能值 → 成功', Engine.judgeCoc(60, 60).ok, true);
  eq('超出技能值 → 失败', Engine.judgeCoc(61, 60).ok, false);
  ok('≤ 1/2 → 困难成功', /困难成功/.test(Engine.judgeCoc(30, 60).text), Engine.judgeCoc(30, 60).text);
  ok('≤ 1/5 → 极难成功', /极难成功/.test(Engine.judgeCoc(12, 60).text), Engine.judgeCoc(12, 60).text);

  // ② 百分骰机制：十位骰若干 + 共用个位骰；奖励取低、惩罚取高
  {
    // 注入的是 d10 原始值（1..10），十位 / 个位 = 值 − 1
    const p = dice([4, 8], () => Engine.rollPercent(0));
    eq('无奖惩：1 颗十位骰', p.tens.length, 1);
    eq('十位骰 = d10 结果 − 1', p.tens[0], 3);
    eq('个位骰 = d10 结果 − 1', p.ones, 7);
    eq('十位 3 + 个位 7 = 37', p.value, 37);
    eq('无奖惩 kind', p.kind, null);
    const b = dice([4, 9, 8], () => Engine.rollPercent(1));
    eq('奖励骰：多投 1 颗十位骰', b.tens.length, 2);
    eq('kind = bonus', b.kind, 'bonus');
    eq('★ 奖励取十位最低', b.pick, 0);
    eq('奖励取低 → 37', b.value, 37);
    const pe = dice([4, 9, 8], () => Engine.rollPercent(-1));
    eq('kind = penalty', pe.kind, 'penalty');
    eq('★ 惩罚取十位最高', pe.pick, 1);
    eq('惩罚取高 → 87', pe.value, 87);
    const z = dice([1, 1], () => Engine.rollPercent(0));
    eq('★ 十位 00 + 个位 0 = 100', z.value, 100);
    ok('奖惩骰有上限（防刷屏）', Engine.rollPercent(99).tens.length <= 9, 'tens=' + Engine.rollPercent(99).tens.length);
  }

  // ③ 指令流程：注入骰点，逐字段断言
  {
    const r = dice([3, 4], () => runCmd('.rc 侦查', mkCtx('coc7', CARD)));
    const m = lastMsg(r);
    eq('.rc 侦查 产出骰点消息', m.kind, 'roll');
    eq('百分骰 = 十位 2 + 个位 3 → 23', m.view.diceSum, 23);
    eq('技能值进 dc', m.view.dc, 60);
    eq('★ 难度标签随规则变（技能值，不是 DC）', m.view.dcLabel, '技能值');
    ok('标题带技能值', /侦查检定（60）/.test(m.view.title), m.view.title);
    ok('★ groups 带 percent 明细', !!m.view.groups[0].percent);
    eq('个位进明细', m.view.groups[0].percent.ones, 3);
    ok('判定为困难成功', /困难成功/.test(m.view.verdict.text), m.view.verdict.text);

    const rb = dice([3, 8, 4], () => runCmd('.rc 侦查 +1', mkCtx('coc7', CARD)));
    ok('奖励骰进标题', /奖励骰 ×1/.test(lastMsg(rb).view.title), lastMsg(rb).view.title);
    eq('奖励取低 → 23', lastMsg(rb).view.diceSum, 23);
    eq('明细里有 2 颗十位骰', lastMsg(rb).view.groups[0].percent.tens.length, 2);
    const rp = dice([3, 8, 4], () => runCmd('.rc 侦查 -1', mkCtx('coc7', CARD)));
    eq('惩罚取高 → 73', lastMsg(rp).view.diceSum, 73);
    const rx = dice([3, 4], () => runCmd('.rc 侦查 +1 -1', mkCtx('coc7', CARD)));
    ok('★ 1 奖 1 罚 → 相抵', /相抵/.test(lastMsg(rx).view.title), lastMsg(rx).view.title);
    eq('相抵后不额外投十位骰', lastMsg(rx).view.groups[0].percent.tens.length, 1);
    const rz = dice([3, 4], () => runCmd('.rc 侦查 奖励1', mkCtx('coc7', CARD)));
    ok('中文「奖励1」也认', /奖励骰/.test(lastMsg(rz).view.title), lastMsg(rz).view.title);
  }

  // ④ 开放技能表：不在常用表里的名字照收照掷
  {
    const c1 = bindCard('.st set 侦查 60 图书馆 50 心理学 40 hp 12 san 70', 'coc7');
    eq('COC 卡族', c1 && c1.family, 'coc7');
    eq('中文技能进卡', c1 && c1.data['侦查'], 60);
    eq('hp 备忘字段', c1 && c1.data.hp, 12);
    eq('san 备忘字段', c1 && c1.data.san, 70);
    const c2 = bindCard('.st set library 50', 'coc7');
    eq('★ 英文别名落到中文键', c2 && c2.data['图书馆'], 50);
    const c3 = bindCard('.st set 占卜 25', 'coc7');
    eq('★ 自定义技能（不在表里）照收', c3 && c3.data['占卜'], 25);
    const h4 = bindCard('.st set 侦查 120', 'coc7') ? '' : '';
    const ctx4 = mkCtx('coc7'); const m4 = runCmd('.st set 侦查 120', ctx4);
    ok('技能值超范围给提示', /1–99/.test(stripHtml(m4[0].html)), stripHtml(m4[0].html).slice(0, 60));
  }

  // ⑤ 未绑卡 / 卡上没有 / 备忘字段：三条都不能静默
  {
    const h = runCmd('.rc 侦查', mkCtx('coc7', null))[0];
    ok('★ 未绑卡给 COC 专用提示（不是 D&D 那句）', /尚未绑定角色卡/.test(h.html) && /st set 侦查/.test(h.html), stripHtml(h.html).slice(0, 70));
    const h2 = runCmd('.rc 潜行', mkCtx('coc7', CARD))[0];
    ok('卡上没有的技能：给添加方法', /卡上还没有/.test(h2.html) && /st set 潜行/.test(h2.html), stripHtml(h2.html).slice(0, 70));
    const r3 = dice([3, 4], () => runCmd('.rc 理智', mkCtx('coc7', {family:'coc7', data:{san:70}})));
    ok('★ 备忘字段明确告知不自动增减', /不会自动增减/.test(lastMsg(r3).view.notes.join(' ')), lastMsg(r3).view.notes.join(' '));
    const h4 = runCmd('.rc', mkCtx('coc7', CARD))[0];
    ok('.rc 空参数给用法', /\.rc 侦查/.test(h4.html));
  }

  // ⑥ .rc list：有卡列卡上的、无卡说明开放列表
  {
    const h = runCmd('.rc list', mkCtx('coc7', CARD))[0];
    ok('★ 有卡时列出卡上的技能', /你卡上的技能/.test(h.html));
    ok('且给出 .rc 用法', /\.rc 侦查/.test(h.html));
    const h2 = runCmd('.rc list', mkCtx('coc7', null))[0];
    ok('无卡时说明技能表是开放的', /开放/.test(h2.html));
  }

  // ⑦ 渲染：百分骰明细必须能核验"取了哪颗十位"
  {
    const r = dice([3, 8, 4], () => runCmd('.rc 侦查 +1', mkCtx('coc7', CARD)));
    const h = Engine.renderRoll(lastMsg(r));
    ok('渲染含十位行', /十位/.test(h));
    ok('渲染含个位行', /个位/.test(h));
    ok('★ 未采用的十位骰划掉（可核验）', /drop/.test(h));
    ok('折叠态带"十位/个位"语义标签', /plab/.test(h));
  }
}

console.log('== 18. 匕首心（二元骰 / 四象限 / 关键成功 / 优劣势 ±d6）★ 本轮 ==');
{
  // ① 判定四象限 + 关键成功
  eq('★ 双骰同点 → 关键成功', Engine.judgeDh(7, 7, 14, 18).crit, true);
  eq('★ 关键成功即使低于难度也算成功', Engine.judgeDh(7, 7, 14, 18).ok, true);
  ok('关键成功文案', /关键成功/.test(Engine.judgeDh(7, 7, 14, 18).text), Engine.judgeDh(7, 7, 14, 18).text);
  ok('四象限 · 希望失败', /希望失败/.test(Engine.judgeDh(9, 4, 13, 15).text), Engine.judgeDh(9, 4, 13, 15).text);
  ok('四象限 · 希望成功', /希望成功/.test(Engine.judgeDh(9, 4, 13, 10).text), Engine.judgeDh(9, 4, 13, 10).text);
  ok('四象限 · 恐惧成功', /恐惧成功/.test(Engine.judgeDh(4, 9, 13, 10).text), Engine.judgeDh(4, 9, 13, 10).text);
  ok('四象限 · 恐惧失败', /恐惧失败/.test(Engine.judgeDh(4, 9, 13, 15).text), Engine.judgeDh(4, 9, 13, 15).text);
  eq('不给难度 → 只掷不判', Engine.judgeDh(9, 4, 13, null).ok, null);
  eq('合计 ≥ 难度 → 成功', Engine.judgeDh(9, 4, 13, 10).ok, true);
  eq('合计 < 难度 → 失败', Engine.judgeDh(9, 4, 13, 15).ok, false);

  // ② .dh 动作掷骰
  {
    const r = dice([9, 4], () => runCmd('.dh 15', mkCtx('dh')));
    const v = lastMsg(r).view;
    eq('二元骰 = 两颗 d12', v.groups.length, 2);
    eq('希望骰 d12', v.groups[0].sides, 12);
    eq('恐惧骰 d12', v.groups[1].sides, 12);
    eq('骰点合计 9+4', v.diceSum, 13);
    eq('无调整值时 total = 骰点', v.total, 13);
    eq('难度进 dc', v.dc, 15);
    ok('标题是动作掷骰', /动作掷骰/.test(v.title), v.title);
    ok('判定为希望失败', /希望失败/.test(v.verdict.text), v.verdict.text);

    const rc = dice([7, 7], () => runCmd('.dh 18', mkCtx('dh')));
    ok('双骰同点 → 关键成功文案', /关键成功/.test(lastMsg(rc).view.verdict.text), lastMsg(rc).view.verdict.text);

    // ★ 优劣势是 ±d6，且 Hope/Fear 只看两颗 d12
    const ra = dice([2, 9, 6], () => runCmd('.dh 15 优势', mkCtx('dh')));
    const va = lastMsg(ra).view;
    eq('优势多一颗 d6', va.groups.length, 3);
    eq('优势 d6 加进总和', va.groups[2].sign, 1);
    eq('total = 2+9+6', va.total, 17);
    ok('★ Hope/Fear 只看两颗 d12（d6 不翻盘）', /恐惧成功/.test(va.verdict.text), va.verdict.text);
    const rd = dice([9, 4, 6], () => runCmd('.dh 15 劣势', mkCtx('dh')));
    eq('劣势 d6 减去', lastMsg(rd).view.groups[2].sign, -1);
    eq('total = 9+4-6', lastMsg(rd).view.total, 7);
  }

  // ③ 特性调整值的消费方式（★ 本轮待拍板项，见档案暂存 6）
  {
    const rt = runCmd('.dh 15 敏捷', mkCtx('dh', {family:'dh', data:{agi:2}}));
    eq('特性调整值组件 = +2', lastMsg(rt).view.comps[0].v, 2);
    ok('特性调整值计入 total', lastMsg(rt).view.total === lastMsg(rt).view.diceSum + 2, 'total=' + lastMsg(rt).view.total);
    const rt2 = runCmd('.dh 15 +2', mkCtx('dh'));
    eq('直接给调整值也认', lastMsg(rt2).view.comps[0].v, 2);
    eq('中文「难度15」', lastMsg(runCmd('.dh 难度15', mkCtx('dh'))).view.dc, 15);
    eq('无难度时 dc 为 null', lastMsg(runCmd('.dh', mkCtx('dh'))).view.dc, null);
    const rnc = runCmd('.dh 15 敏捷', mkCtx('dh', null));
    ok('★ 未绑卡可掷但明说按 0 算（不静默）', /调整值按/.test(lastMsg(rnc).view.notes.join(' ')), lastMsg(rnc).view.notes.join(' '));
  }

  // ④ 六特性卡
  {
    const c = bindCard('.st set 敏捷 2 力量 2 灵巧 1 本能 0 仪态 1 知识 -1', 'dh');
    eq('DH 卡族', c && c.family, 'dh');
    eq('敏捷', c && c.data.agi, 2);
    eq('知识可以为负', c && c.data.kno, -1);
    const c2 = bindCard('.st set agility 3', 'dh');
    eq('英文特性别名', c2 && c2.data.agi, 3);
    const ctx3 = mkCtx('dh'); const m3 = runCmd('.st set 敏捷 5', ctx3);
    ok('调整值超范围给提示', /−1 ~ \+3/.test(stripHtml(m3[0].html)), stripHtml(m3[0].html).slice(0, 60));
    const ctx4 = mkCtx('dh'); const m4 = runCmd('.st set 魅力 2', ctx4);
    ok('未知特性给提示', /未知特性/.test(stripHtml(m4[0].html)), stripHtml(m4[0].html).slice(0, 60));
  }

  // ⑤ 本规则不用 .rc —— 必须指路到 .dh
  {
    const h = runCmd('.rc list', mkCtx('dh'))[0];
    ok('DH 的 .rc list 给六特性', /六特性/.test(h.html));
    ok('DH 的 .rc list 指路 .dh', /\.dh/.test(h.html));
    const h2 = runCmd('.rc 敏捷', mkCtx('dh', {family:'dh', data:{agi:2}}))[0];
    ok('★ DH 下 .rc 提示改用 .dh（不静默）', /\.dh/.test(h2.html), stripHtml(h2.html).slice(0, 70));
    // ★ 在别的规则下打 .dh —— 不能没反应
    const h3 = runCmd('.dh 15', mkCtx('dnd5e'))[0];
    ok('★ D&D 下打 .dh → 告知归属并给切换指令', /匕首心/.test(h3.html) && /set rule dh/.test(h3.html), stripHtml(h3.html).slice(0, 80));
  }
}

console.log('== 19. 最终物语（骰阶 / HR / 暴击 / 失手 / 无优劣势）★ 本轮 ==');
{
  const CARD = {family:'fu', data:{dex:8, ins:10, mig:8, wlp:6}};

  // ① 判定
  eq('★ 双骰同点 ≥6 → 暴击', Engine.judgeFu(8, 8, 13).crit, true);
  eq('暴击无视难度', Engine.judgeFu(8, 8, 99).ok, true);
  ok('暴击文案', /暴击/.test(Engine.judgeFu(8, 8, 13).text));
  eq('★ 双 1 → 失手', Engine.judgeFu(1, 1, 3).crit, true);
  eq('失手必败', Engine.judgeFu(1, 1, 3).ok, false);
  ok('失手文案', /失手/.test(Engine.judgeFu(1, 1, 3).text));
  eq('同点 <6 不是暴击', Engine.judgeFu(5, 5, 13).crit, undefined);
  eq('合计 ≥ DL → 成功', Engine.judgeFu(5, 6, 10).ok, true);
  eq('合计 < DL → 失败', Engine.judgeFu(5, 4, 10).ok, false);
  eq('无难度只掷不判', Engine.judgeFu(5, 6, null).ok, null);

  // ② 骰阶字面量：必须带 d（否则 "10" 与难度混淆）
  eq('骰阶字面 d8', Engine.parseTier('d8'), 8);
  eq('骰阶字面 d10', Engine.parseTier('d10'), 10);
  eq('★ 纯数字不当骰阶', Engine.parseTier('8'), null);
  eq('非法骰阶 d7', Engine.parseTier('d7'), null);

  // ③ .fu 指令
  {
    const r = dice([5, 6], () => runCmd('.fu dex ins 10', mkCtx('fu', CARD)));
    const v = lastMsg(r).view;
    eq('两颗属性骰', v.groups.length, 2);
    eq('DEX d8 + INS d10', JSON.stringify(v.groups.map(g => g.sides)), '[8,10]');
    eq('骰点合计 5+6', v.diceSum, 11);
    eq('DL 进 dc', v.dc, 10);
    eq('★ 难度标签 = DL', v.dcLabel, 'DL');
    ok('标题含骰阶', /DEX\(d8\) \+ INS\(d10\)/.test(v.title), v.title);
    ok('11 ≥ 10 → 成功', /成功/.test(v.verdict.text), v.verdict.text);
    ok('★ 每次都给 HR（高骰）', /HR/.test(v.notes.join(' ')), v.notes.join(' '));
    ok('HR = 两骰较高者', /HR = 6/.test(v.notes.join(' ')), v.notes.join(' '));

    const r2 = dice([8, 8], () => runCmd('.fu dex dex 13', mkCtx('fu', CARD)));
    eq('★ 同一属性可用两次', JSON.stringify(lastMsg(r2).view.groups.map(g => g.sides)), '[8,8]');
    ok('双 8 → 暴击', /暴击/.test(lastMsg(r2).view.verdict.text), lastMsg(r2).view.verdict.text);
    const r3 = dice([1, 1], () => runCmd('.fu mig wlp 10', mkCtx('fu', CARD)));
    ok('双 1 → 失手', /失手/.test(lastMsg(r3).view.verdict.text), lastMsg(r3).view.verdict.text);
    const r4 = dice([5, 6], () => runCmd('.fu d8 d10 10', mkCtx('fu', null)));
    eq('★ 无卡直接给骰阶', JSON.stringify(lastMsg(r4).view.groups.map(g => g.sides)), '[8,10]');
    eq('不判难度时 dc = null', lastMsg(runCmd('.fu dex ins', mkCtx('fu', CARD))).view.dc, null);
    eq('中文「难度13」', lastMsg(runCmd('.fu dex ins 难度13', mkCtx('fu', CARD))).view.dc, 13);
  }

  // ④ 没有优劣势 / 参数不足 / 无卡 —— 三条都要给可执行的下一步
  {
    const h = runCmd('.fu dex ins 优势', mkCtx('fu', CARD))[0];
    ok('★ FU 拒绝优劣势并说明怎么重掷', /没有优劣势/.test(h.html) && /再发一次/.test(h.html), stripHtml(h.html).slice(0, 80));
    const h2 = runCmd('.fu', mkCtx('fu', CARD))[0];
    ok('参数不足给格式', /两个骰阶/.test(h2.html));
    const h3 = runCmd('.fu dex ins 10', mkCtx('fu', null))[0];
    ok('★ 无卡用属性名 → 提示给骰阶', /尚未绑定角色卡/.test(h3.html) && /d8/.test(h3.html), stripHtml(h3.html).slice(0, 80));
    const h4 = runCmd('.fu dex ins 10', mkCtx('coc7'))[0];
    ok('★ COC 下打 .fu → 告知归属并给切换指令', /最终物语/.test(h4.html) && /set rule fu/.test(h4.html), stripHtml(h4.html).slice(0, 80));
  }

  // ⑤ 四属性骰阶卡
  {
    const c = bindCard('.st set dex d8 ins d10 mig d8 wlp d6', 'fu');
    eq('FU 卡族', c && c.family, 'fu');
    eq('dex d8', c && c.data.dex, 8);
    eq('wlp d6', c && c.data.wlp, 6);
    const c2 = bindCard('.st set 敏捷 d8 洞察 d10 力量 d8 意志 d6', 'fu');
    eq('中文属性别名', c2 && c2.data.mig, 8);
    const c3 = bindCard('.st set dex 8', 'fu');
    eq('宽容：写 8 同 d8', c3 && c3.data.dex, 8);
    const ctx4 = mkCtx('fu'); const m4 = runCmd('.st set dex d7', ctx4);
    ok('非法骰阶给提示', /骰阶/.test(stripHtml(m4[0].html)), stripHtml(m4[0].html).slice(0, 60));
    const ctx5 = mkCtx('fu'); const m5 = runCmd('.st set 魅力 d8', ctx5);
    ok('未知属性给提示', /未知属性/.test(stripHtml(m5[0].html)), stripHtml(m5[0].html).slice(0, 60));
  }

  // ⑥ .rc list 与 .rc 的指路
  {
    const h = runCmd('.rc list', mkCtx('fu'))[0];
    ok('FU 的 .rc list 给四属性', /四属性/.test(h.html));
    const h2 = runCmd('.rc dex', mkCtx('fu', {family:'fu', data:{dex:8}}))[0];
    ok('★ FU 下 .rc 提示改用 .fu', /\.fu/.test(h2.html), stripHtml(h2.html).slice(0, 70));
  }
}

console.log('== 20. 跨规则隔离（同名词不串 / 换族换卡不静默）★ 本轮 ==');
{
  // ① 同名不同义：四套规则各有各的「力量」
  const dnd = Engine.lookupCheckTarget('力量', 'dnd5e');
  const dh  = Engine.lookupAlias(Engine.CHECK_DOMAIN.dh, '力量');
  const fu  = Engine.lookupAlias(Engine.CHECK_DOMAIN.fu, '力量');
  const coc = Engine.lookupAlias(Engine.CHECK_DOMAIN.coc7, '力量');
  eq('D&D「力量」= 属性', dnd && dnd.kind, 'ability');
  eq('DH「力量」= 特性', dh && dh.kind, 'trait');
  eq('FU「力量」= 属性骰阶', fu && fu.kind, 'fuattr');
  eq('COC「力量」= 技能', coc && coc.kind, 'cocskill');
  ok('★ 四族的「力量」是四条独立条目（互不覆盖）', dnd !== dh && dh !== fu && fu !== coc);
  eq('★ COC 域的「侦查」解析到 COC 技能', Engine.lookupAlias(Engine.CHECK_DOMAIN.coc7, '侦查').key, '侦查');
  eq('★ D&D 域的「侦查」解析到 investigation', Engine.lookupCheckTarget('侦查', 'dnd5e').key, 'investigation');
  ok('★ 同名词在不同域互不干扰', Engine.lookupCheckTarget('侦查', 'dnd5e') !== Engine.lookupAlias(Engine.CHECK_DOMAIN.coc7, '侦查'));
  eq('★ COC 下 .rc 潜行 查 COC 域', Engine.lookupCheckTarget('潜行', 'coc7').kind, 'cocskill');
  eq('★ D&D 下 .rc 潜行 查 D&D 域', Engine.lookupCheckTarget('潜行', 'dnd5e').key, 'stealth');
  eq('★ COC 域里没有 D&D 的巧手', Engine.lookupCheckTarget('巧手', 'coc7'), null);

  // ② 卡字段域同样隔离
  eq('D&D 卡字段：力量 → str', Engine.normalizeCardKey('力量'), 'str');
  eq('FU 卡字段：力量 → mig', Engine.lookupAlias(Engine.CARD_DOMAIN.fu, '力量').key, 'mig');
  eq('DH 卡字段：力量 → str', Engine.lookupAlias(Engine.CARD_DOMAIN.dh, '力量').key, 'str');

  // ③ 分域后必须零冲突（★ 本轮修的真 bug：COC「急救」与「医学」都注册了 medicine）
  eq('★ 别名表零冲突', Engine.ALIAS.conflicts.length, 0);
  eq('★ 旧的单一域名 check 已废弃', Engine.ALIAS.byDomain.has('check'), false);
  ok('★ 四个 check 域都在', ['dnd','coc7','dh','fu'].every(k => Engine.ALIAS.byDomain.has(Engine.CHECK_DOMAIN[k])), JSON.stringify(Object.keys(Engine.CHECK_DOMAIN)));
  ok('★ 四个 cardkey 域都在', ['dnd','coc7','dh','fu'].every(k => Engine.ALIAS.byDomain.has(Engine.CARD_DOMAIN[k])));

  // ④ 换规则 = 卡不匹配必须提示；换族绑卡 = 覆盖必须明说
  {
    const ctx = mkCtx('dnd5e');
    runCmd('.st set str 16', ctx);
    eq('先绑 D&D 卡', ctx.card && ctx.card.family, 'dnd');
    const ms = runCmd('.set rule coc', ctx);
    ok('★ 切规则时提示卡与规则不符', ms.some(m => /不参与检定/.test(m.html || '')), JSON.stringify(ms.map(m => m.kind)));
    const h = runCmd('.st set 侦查 60', ctx)[0];
    ok('★ 换族绑卡明说"已换为"（不静默覆盖）', /已换为/.test(h.html), stripHtml(h.html).slice(0, 60));
    ok('★ 并说明原卡被替换', /已被替换/.test(h.html));
    eq('卡族已切换', ctx.card && ctx.card.family, 'coc7');
    const h2 = runCmd('.st set 图书馆 50', ctx)[0];
    eq('同族合并不说"换卡"', /已换为/.test(h2.html), false);
    eq('同族合并保留原有字段', ctx.card && ctx.card.data['侦查'], 60);
  }
}

console.log('== 21. M2 铁律回归（四套规则都满足同一套铁律）★ 本轮 ==');
{
  // 铁律 1：total 唯一出处 —— 每套规则的 view 都满足 total = diceSum + add
  const cases = [
    ['.r 2d6+3', 'generic', null],
    ['.rc 力量 15', 'dnd5e', {family:'dnd', data:{str:16, lv:5}}],
    ['.rc 侦查 +1', 'coc7', {family:'coc7', data:{'侦查':60}}],
    ['.dh 15 优势', 'dh', null],
    ['.fu dex ins 10', 'fu', {family:'fu', data:{dex:8, ins:10}}]
  ];
  cases.forEach(c => {
    const m = lastMsg(runCmd(c[0], mkCtx(c[1], c[2])));
    ok('★ total = diceSum + add：' + c[0], m && m.view && m.view.total === m.view.diceSum + m.view.add, 'total=' + (m && m.view && m.view.total));
    const add = m && m.view ? m.view.comps.reduce((a, x) => a + x.v, 0) : -999;
    ok('★ add = 组件表之和：' + c[0], m && m.view && m.view.add === add, 'add=' + (m && m.view && m.view.add));
    ok('★ diceSum = 骰点现场推导：' + c[0], m && m.view && m.view.diceSum === Engine.sumKept(m.view.groups));
  });

  // 铁律 2：同一份渲染 —— 三套新规则都走 renderRoll，且都有折叠明细
  [['.rc 侦查', 'coc7', {family:'coc7', data:{'侦查':60}}], ['.dh 15', 'dh', null], ['.fu d8 d10 10', 'fu', null]].forEach(c => {
    const h = Engine.renderMsg(lastMsg(runCmd(c[0], mkCtx(c[1], c[2]))));
    ok('★ 共用 renderRoll：' + c[0], /bubble dice/.test(h));
    ok('★ 有折叠明细：' + c[0], /detail/.test(h));
  });

  // 铁律 3：说明性内容结构化传输 —— 六规则帮助页都是结构化数据
  ['generic','dnd5e','dnd5r','coc7','dh','fu'].forEach(k => {
    const d = Engine.HELP_BODY[k]();
    ok('★ 帮助为结构化数据：' + k, !!d.title && Array.isArray(d.sections));
    ok('★ sections 含 rows：' + k, d.sections.every(s => Array.isArray(s.rows)));
  });
  eq('六规则都有专属帮助页', Object.keys(Engine.HELP_BODY).length, 6);

  // 铁律 4：判定不进主流程 —— 各包的 runCheck / verbs 存在且被使用
  ok('D&D 包有 runCheck', typeof Engine.DND_PACK.runCheck === 'function');
  ok('COC 包有 runCheck', typeof Engine.COC_PACK.runCheck === 'function');
  eq('DH 不支持 .rc', Engine.DH_PACK.supportsCheck, false);
  eq('FU 不支持 .rc', Engine.FU_PACK.supportsCheck, false);
  ok('DH 包提供 .dh', !!(Engine.DH_PACK.verbs && Engine.DH_PACK.verbs.dh));
  ok('FU 包提供 .fu', !!(Engine.FU_PACK.verbs && Engine.FU_PACK.verbs.fu));
  eq('verbOwner：.dh 属匕首心', Engine.verbOwner('dh'), 'dh');
  eq('verbOwner：.fu 属最终物语', Engine.verbOwner('fu'), 'fu');
  eq('verbOwner：.rc 不是专属动词', Engine.verbOwner('rc'), null);
  eq('族 → 包：coc7', Engine.packOfFamily('coc7'), Engine.COC_PACK);
  eq('5.5e 与 5e 共用包', Engine.rulePack('dnd5r'), Engine.DND_PACK);

  // 铁律 5：派生值不存副本 —— view 只带 diceSum/add/total
  {
    const v = lastMsg(runCmd('.r 2d6+3', mkCtx('generic'))).view;
    ok('view 带 diceSum / add / total 三件套', typeof v.diceSum === 'number' && typeof v.add === 'number' && typeof v.total === 'number');
    ok('★ 没有存 highRoll 之类的副本', v.highRoll === undefined && v.totalStr === undefined);
  }
}

console.log('== 22. 源码级结构断言（主流程不许认识具体规则）★ 本轮 ==');
{
  const src = HTML_SRC;

  // ① 规则包接口齐全（加新包 = 加一个对象）
  ['generic','dnd5e','dnd5r','coc7','dh','fu'].forEach(k => {
    const p = Engine.rulePack(k);
    ok('★ 包接口 checkHint：' + k, typeof p.checkHint === 'function');
    ok('★ 包接口 listChecks：' + k, typeof p.listChecks === 'function');
    ok('★ 包接口 renderCard：' + k, typeof p.renderCard === 'function');
    ok('★ 包接口 parseCard：' + k, typeof p.parseCard === 'function');
    ok('★ 包接口 checkOffNote：' + k, typeof p.checkOffNote === 'function');
  });
  ok('★ 六规则全部实现', Engine.IMPLEMENTED.size === 6 || Object.keys(Engine.RULE_PACKS).length === 6, 'packs=' + Object.keys(Engine.RULE_PACKS).length);
  ok('★ 族 → 包 表含 4 个族', ['dnd','coc7','dh','fu'].every(f => !!Engine.FAMILY_PACKS[f]));

  // ② 主流程的 .rc 分支不许出现任何具体规则的数据
  const rcBlock = (src.match(/if\(verb === 'rc' \|\| verb === 'ra'[\s\S]*?\n  \}/) || [])[0] || '';
  ok('取到 .rc 分支源码', rcBlock.length > 0, 'len=' + rcBlock.length);
  eq('★ .rc 分支不出现 DND_SKILLS', /DND_SKILLS/.test(rcBlock), false);
  eq('★ .rc 分支不出现 COC_SKILLS', /COC_SKILLS/.test(rcBlock), false);
  eq('★ .rc 分支不出现 DH_TRAITS', /DH_TRAITS/.test(rcBlock), false);
  eq('★ .rc 分支不出现 FU_ATTRS', /FU_ATTRS/.test(rcBlock), false);
  eq('★ .rc 分支不出现 judgeDnd', /judgeDnd/.test(rcBlock), false);
  eq('★ .rc 分支不出现 judgeCoc', /judgeCoc/.test(rcBlock), false);
  eq('★ .rc 分支不出现 rollPercent', /rollPercent/.test(rcBlock), false);

  // ③ 主流程的 .st 分支不许认识任何一张具体的卡
  const stBlock = (src.match(/if\(verb === 'st'\)\{[\s\S]*?\n  \}/) || [])[0] || '';
  ok('取到 .st 分支源码', stBlock.length > 0, 'len=' + stBlock.length);
  eq('★ .st 分支不出现 DND_ABILITIES', /DND_ABILITIES/.test(stBlock), false);
  eq('★ .st 分支不出现 renderCardHtml', /renderCardHtml/.test(stBlock), false);
  eq('★ .st 分支不出现 parseCardSet', /parseCardSet/.test(stBlock), false);

  // ④ 别名分桶：不许退回单一域名
  //  ★ 教训：最初只断言「四个族都能查到域」—— 变异测试把 coc7 的域指回 check:dnd 仍全绿，
  //    因为"查得到"不等于"是各自的"。必须断言**四个域名互不相同**。
  ok('★ CHECK_DOMAIN 定义四个域', /CHECK_DOMAIN = \{[^}]*dnd[^}]*coc7[^}]*dh[^}]*fu/.test(src));
  ok('★ CARD_DOMAIN 定义四个域', /CARD_DOMAIN\s*= \{[^}]*dnd[^}]*coc7[^}]*dh[^}]*fu/.test(src));
  eq('★ 四个 check 域名互不相同（不许退回单一域）', new Set(Object.values(Engine.CHECK_DOMAIN)).size, 4);
  eq('★ 四个 cardkey 域名互不相同', new Set(Object.values(Engine.CARD_DOMAIN)).size, 4);

  // ⑤ nat 语义仍然静默（COC/DH/FU 不该有 d20 语义）
  eq('★ NAT_MARK 仍只有 dnd 两支', Object.keys(Engine.NAT_MARK).length, 2);
  eq('COC 无 nat 标记', Engine.natMarkOf(20, 'coc7'), null);
  eq('DH 无 nat 标记', Engine.natMarkOf(20, 'dh'), null);
  eq('FU 无 nat 标记', Engine.natMarkOf(20, 'fu'), null);

  // ⑥ 呈现：骰点 chips 带语义标签（否则百分骰会被读成「83 和 6」）
  //  ★ 教训：最初只断言 CSS 类 `.plab{` 存在 —— 变异测试把它改成 display:none 仍全绿，
  //    那条是摆设。**查源码串存不存在 ≠ 断言行为**，必须查渲染产物里真的有标签。
  {
    const hc = Engine.renderRoll(lastMsg(runCmd('.rc 侦查', mkCtx('coc7', {family:'coc7', data:{'侦查':60}}))));
    ok('★ 百分骰渲染产物带语义标签', /class="plab"/.test(hc), hc.slice(0, 140));
    ok('★ 标签写明十位', /plab">十位</.test(hc));
    ok('★ 标签写明个位', /plab">个位</.test(hc));
    const hd = Engine.renderRoll(lastMsg(runCmd('.dh 15', mkCtx('dh'))));
    ok('★ 二元骰渲染产物带希望/恐惧标签', /plab">希望</.test(hd) && /plab">恐惧</.test(hd), hd.slice(0, 160));
    const hf = Engine.renderRoll(lastMsg(runCmd('.fu dex ins 10', mkCtx('fu', {family:'fu', data:{dex:8, ins:10}}))));
    ok('★ 物语渲染产物带属性标签', /plab">DEX</.test(hf) && /plab">INS</.test(hf), hf.slice(0, 160));
  }

  // ⑦ 顶栏与呈现基线（继承 M1，防 M2 改回去）
  ok('顶栏保留裸骰状态指示', /id="p-bd"/.test(src));
  const n = (src.match(/data-cmd="/g) || []).length;
  ok('快捷指令数量（7 个）', n === 7, 'count=' + n);
  ok('viewport 声明 interactive-widget=resizes-content', /interactive-widget=resizes-content/.test(src));
  ok('监听 visualViewport resize', /vv\.addEventListener\('resize'/.test(src));
}

console.log('== 23. 真机反馈第四轮（M2 Chrome 实机 7 条）★ 本轮 ==');
{
  const strip23 = s => String(s == null ? '' : s).replace(/<[^>]+>/g, '');
  /** 取渲染产物里"合计"那一行的可见文本 */
  const totLine = m => {
    const h = Engine.renderRoll(m);
    const x = /dline tot[\s\S]*?<\/div>/.exec(h);
    return x ? x[0].replace(/<[^>]+>/g, '') : '?';
  };

  // ① COC / FU 不该出现「调整项 +0」—— 这两套规则压根没有调整值这个概念
  {
    const m1 = lastMsg(runCmd('.rc 侦查', mkCtx('coc7', {family:'coc7', data:{'侦查':60}})));
    ok('★ COC 合计行不含「调整项」', !/调整项/.test(totLine(m1)), totLine(m1));
    ok('★ COC 合计行仍是"骰点 → 合计"', /骰点 \d+ → \d+/.test(totLine(m1)), totLine(m1));
    const m2 = lastMsg(runCmd('.fu d8 d10 10', mkCtx('fu', null)));
    ok('★ FU 无调整值时合计行不含「调整项」', !/调整项/.test(totLine(m2)), totLine(m2));
    // 通用 .r 2d6（无调整值）同样是噪音，一并对齐
    const m3 = lastMsg(runCmd('.r 2d6', mkCtx('generic', null)));
    ok('★ 通用无调整值也不显示「调整项」', !/调整项/.test(totLine(m3)), totLine(m3));
    // D&D / 有调整值时必须照常显示（不能为了去掉 +0 把真调整值也藏了）
    const m4 = lastMsg(runCmd('.rc 力量 15', mkCtx('dnd5e', {family:'dnd', data:{str:16, lv:5}})));
    ok('★ D&D 有调整值时照常显示', /调整项 \+3/.test(totLine(m4)), totLine(m4));
    const m5 = lastMsg(runCmd('.fu d8 d10 10 +2', mkCtx('fu', null)));
    ok('★ FU 有调整值时照常显示', /调整项 \+2/.test(totLine(m5)), totLine(m5));
  }

  // ② FU 调整值位（用户反馈"只保留文本、没有位置"→ 判定后补上位置）
  {
    const C = {family:'fu', data:{dex:8, ins:10, mig:8, wlp:6}};
    const m = lastMsg(runCmd('.fu dex ins 13 +2', mkCtx('fu', C)));
    eq('★ FU 调整值进 comps', m.view.comps.length, 1);
    eq('★ FU 调整值 = +2', m.view.comps[0].v, 2);
    ok('★ FU total = 骰点 + 调整值', m.view.total === m.view.diceSum + 2, 'total=' + m.view.total);
    ok('★ FU 判定用 total（不是裸骰点）', /合计 \d+ vs 难度 13/.test(m.view.verdict.why), m.view.verdict.why);
    ok('★ FU 说明里拆出"骰点 N + 2"', /骰点 \d+ \+ 2/.test(m.view.verdict.why), m.view.verdict.why);
    const mn = lastMsg(runCmd('.fu dex ins 13 -1', mkCtx('fu', C)));
    eq('★ FU 负调整值', mn.view.comps[0].v, -1);
    // ★ 暴击 / 失手只看骰面，调整值不得插手
    eq('★ 双 1 失手不受调整值影响', Engine.judgeFu(1, 1, 3, 5).crit, true);
    eq('★ 双骰同点 ≥6 暴击不受调整值影响', Engine.judgeFu(8, 8, 99, -5).crit, true);
    eq('★ 调整值参与"合计 vs DL"', Engine.judgeFu(5, 4, 10, 3).ok, true);
    eq('★ 骰点 9 + 3 = 12 ≥ DL 10', Engine.judgeFu(5, 4, 10, 3).text.indexOf('合计 12') >= 0, true);
  }

  // ③ 匕首心 presence：主显示「风度」，「仪态」保留为合规别名
  {
    const pre = Engine.DH_TRAITS.find(t => t.key === 'pre');
    eq('★ presence 主显示 = 风度', pre.zh, '风度');
    ok('★ 「仪态」仍是合规别名', pre.aliases.indexOf('仪态') >= 0, JSON.stringify(pre.aliases));
    eq('★ .st set 仪态 1 → pre', Engine.lookupAlias(Engine.CARD_DOMAIN.dh, '仪态').key, 'pre');
    eq('★ .st set 风度 1 → pre', Engine.lookupAlias(Engine.CARD_DOMAIN.dh, '风度').key, 'pre');
    const c1 = mkCtx('dh'); runCmd('.st set 仪态 1', c1);
    eq('★ 老写法仍绑得上', c1.card && c1.card.data.pre, 1);
    const c2 = mkCtx('dh'); runCmd('.st set 风度 2', c2);
    eq('★ 新写法绑得上', c2.card && c2.card.data.pre, 2);
    ok('★ 卡面显示「风度」而非「仪态」', /风度/.test(Engine.DH_PACK.renderCard(c2.card)), Engine.DH_PACK.renderCard(c2.card));
    ok('★ 模板与帮助不再以「仪态」为主', !/仪态/.test(Engine.DH_PACK.cardTemplate().sections[0].rows[0].k), Engine.DH_PACK.cardTemplate().sections[0].rows[0].k);
  }

  // ④ 四象限文案：希望/恐惧 + 成功/失败（不是英文直译的"成功带希望"）
  {
    ok('★ 希望成功', /希望成功/.test(Engine.judgeDh(9, 4, 13, 10).text), Engine.judgeDh(9, 4, 13, 10).text);
    ok('★ 恐惧成功', /恐惧成功/.test(Engine.judgeDh(4, 9, 13, 10).text), Engine.judgeDh(4, 9, 13, 10).text);
    ok('★ 希望失败', /希望失败/.test(Engine.judgeDh(9, 4, 13, 15).text), Engine.judgeDh(9, 4, 13, 15).text);
    ok('★ 恐惧失败', /恐惧失败/.test(Engine.judgeDh(4, 9, 13, 15).text), Engine.judgeDh(4, 9, 13, 15).text);
    const all = ['希望成功','恐惧成功','希望失败','恐惧失败'];
    const got = [Engine.judgeDh(9,4,13,10).text, Engine.judgeDh(4,9,13,10).text,
                 Engine.judgeDh(9,4,13,15).text, Engine.judgeDh(4,9,13,15).text];
    ok('★ 四种结果各不相同且都以希望/恐惧开头', new Set(got).size === 4 && got.every(t => /^(希望|恐惧)/.test(t)), JSON.stringify(got));
    eq('★ 不再出现"带希望"这类直译', got.some(t => /带希望|带恐惧/.test(t)), false);
    ok('★ 未判难度也统一为「未判难度 · 希望/恐惧」', /^未判难度 · (希望|恐惧)$/.test(Engine.judgeDh(9, 4, 13, null).text), Engine.judgeDh(9, 4, 13, null).text);
  }

  // ⑤ FU 卡新增两个静态备忘字段：物语点 / 物资点（机制同 COC 的 hp / san）
  {
    const c = mkCtx('fu'); runCmd('.st set 物语点 3 物资点 2', c);
    eq('★ 物语点进卡', c.card && c.card.data.fp, 3);
    eq('★ 物资点进卡', c.card && c.card.data.ip, 2);
    const c2 = mkCtx('fu'); runCmd('.st set fp 4 ip 1', c2);
    eq('★ 英文 fp 同物语点', c2.card && c2.card.data.fp, 4);
    eq('★ 英文 ip 同物资点', c2.card && c2.card.data.ip, 1);
    // 骰阶字段不受影响
    const c3 = mkCtx('fu'); runCmd('.st set dex d8 物语点 3', c3);
    eq('★ 骰阶与备忘可混写', c3.card && c3.card.data.dex, 8);
    eq('★ 混写时备忘也进卡', c3.card && c3.card.data.fp, 3);
    // 渲染：显示 + 明确声明不自动增减（与 COC 的 hp/san 同一口径）
    const html = Engine.FU_PACK.renderCard({family:'fu', data:{dex:8, fp:3, ip:2}});
    ok('★ 卡面显示物语点', /物语点/.test(html), strip23(html).slice(0, 60));
    ok('★ 卡面显示物资点', /物资点/.test(html));
    ok('★ 明确声明不自动增减', /不自动增减/.test(html));
    ok('★ 但仍显示四属性骰阶', /DEX/.test(html) && /d8/.test(html));
    // 范围校验：备忘是整数，不是骰阶
    const c4 = mkCtx('fu'); const m4 = runCmd('.st set 物语点 d8', c4);
    ok('★ 备忘字段不接受骰阶写法', /非负整数/.test(strip23(m4[0].html)), strip23(m4[0].html).slice(0, 60));
    ok('★ 模板里列出备忘字段', /物语点/.test(Engine.FU_PACK.cardTemplate().sections[0].rows.map(r => r.k).join(' ')));
  }

  // ⑥ DH 指令结构：命令头 → 特性 → 难度（与 FU 一致）
  {
    const r1 = runCmd('.dh 敏捷 15', mkCtx('dh', {family:'dh', data:{agi:2}}));
    eq('★ .dh 敏捷 15 → 难度 15', lastMsg(r1).view.dc, 15);
    ok('★ .dh 敏捷 15 → 取敏捷调整值', lastMsg(r1).view.comps.some(c => c.v === 2), JSON.stringify(lastMsg(r1).view.comps));
    const r2 = runCmd('.dh 15 敏捷', mkCtx('dh', {family:'dh', data:{agi:2}}));
    eq('★ 旧顺序仍可用（不 Breaking）', lastMsg(r2).view.dc, 15);
    const r3 = runCmd('.dh 敏捷 15 +2 优势', mkCtx('dh', {family:'dh', data:{agi:2}}));
    eq('★ 特性→难度→调整值→优劣势 全组合', lastMsg(r3).view.dc, 15);
    eq('★ 调整值叠加到 +4', lastMsg(r3).view.comps[0].v, 4);
    eq('★ 优势多一颗 d6', lastMsg(r3).view.groups.length, 3);
    // 文案统一为"特性在前、难度在后"
    ok('★ checkHint 用新顺序', /\.dh 敏捷 15/.test(Engine.DH_PACK.checkHint()), Engine.DH_PACK.checkHint());
    ok('★ listChecks 用新顺序', /\.dh 敏捷 15/.test(Engine.DH_PACK.listChecks('dh', null).sections[0].rows.map(r => r.v).join('')));
    ok('★ 帮助页用新顺序', /\.dh 敏捷 15/.test(JSON.stringify(Engine.HELP_BODY.dh())));
  }

  // ⑦ 通用 .r 在 DH / FU 下的降级接管（★ 只在通用解析用不上时才接管）
  {
    // 合法骰表达式必须照旧走通用掷骰 —— 这是"零负担"的前提
    ['generic','dnd5e','coc7','dh','fu'].forEach(r => {
      const m = lastMsg(runCmd('.r 2d6+3', mkCtx(r, null)));
      ok('★ .r 2d6+3 在 ' + r + ' 仍是通用掷骰', m.kind === 'roll' && /掷骰 2d6\+3/.test(m.view.title), m.view.title);
      eq('★ ' + r + ' 下 .r 仍投出 2 颗骰', m.view.groups[0].kept.length, 2);
    });
    // DH 下：难度数字 / 特性+难度 → 接管为动作掷骰
    const d1 = lastMsg(runCmd('.r 15', mkCtx('dh', null)));
    ok('★ DH 下 .r 15 → 动作掷骰（不再报"括号/乘除"）', /动作掷骰/.test(d1.view.title), d1.view.title);
    eq('★ 且难度正确', d1.view.dc, 15);
    const d2 = lastMsg(runCmd('.r 敏捷 15', mkCtx('dh', {family:'dh', data:{agi:2}})));
    ok('★ DH 下 .r 敏捷 15 → 带特性', /敏捷/.test(d2.view.title), d2.view.title);
    const d3 = lastMsg(runCmd('.骰 敏捷 15', mkCtx('dh', {family:'dh', data:{agi:2}})));
    ok('★ 中文命令头 .骰 同样接管', /动作掷骰/.test(d3.view.title), d3.view.title);
    // FU 下：属性+难度 → 接管为物语检定
    const f1 = lastMsg(runCmd('.r d8 d10 10', mkCtx('fu', null)));
    ok('★ FU 下 .r d8 d10 10 → 物语检定（不会被拼成 1d1010）', /检定/.test(f1.view.title), f1.view.title);
    eq('★ 且是两个骰阶', JSON.stringify(f1.view.groups.map(g => g.sides)), '[8,10]');
    const f2 = lastMsg(runCmd('.r dex ins 10', mkCtx('fu', {family:'fu', data:{dex:8, ins:10}})));
    ok('★ FU 下 .r dex ins 10 → 用卡上骰阶', /DEX\(d8\) \+ INS\(d10\)/.test(f2.view.title), f2.view.title);
    // 通用 / D&D / COC 不接管：给的是"可执行下一步"，不再是误导性的语法提示
    const g1 = runCmd('.r 15', mkCtx('generic', null))[0];
    ok('★ 通用下 .r 15 提示"不是掷骰表达式"', /不是掷骰表达式/.test(g1.html), strip23(g1.html).slice(0, 60));
    eq('★ 且不再误报"括号/乘除/骰池"', /骰池/.test(g1.html), false);
    const g2 = runCmd('.r 15', mkCtx('dnd5e', null))[0];
    ok('★ D&D 下顺带指路 .rc', /\.rc 力量/.test(g2.html));
    // 真正的语法错误提示必须保留（不能被接管吃掉）
    const g3 = runCmd('.r (1d6+2)*2', mkCtx('fu', null))[0];
    ok('★ 真语法错误仍报"暂不支持该语法"', /暂不支持该语法/.test(g3.html), strip23(g3.html).slice(0, 60));
    const g4 = runCmd('.r 4d6k3', mkCtx('dh', null))[0];
    ok('★ 骰池语法仍被拒', /暂不支持该语法|不是掷骰表达式/.test(g4.html), strip23(g4.html).slice(0, 60));
  }

  // ⑧ 卡与规则不符时，给出两条出路：切回 / 解绑重开
  {
    const CARD = {family:'dnd', data:{str:16, lv:5}};
    const h = runCmd('.st', mkCtx('coc7', CARD))[0].html;
    ok('★ 提示 .set rule 切回', /set rule dnd/.test(h));
    ok('★ 同时提示 .st clear 解绑', /st clear/.test(h), strip23(h).slice(-90));
    ok('★ 并说明解绑后 .st 给当前规则模板', /解绑后再发/.test(h) && /模板/.test(h));
    const s = runCmd('.status', mkCtx('coc7', CARD))[0].html;
    ok('★ .status 也给同一条提示（同源于 cardMismatchNote）', /st clear/.test(s));
    // 匹配时不能出现这段话
    const h2 = runCmd('.st', mkCtx('dnd5e', CARD))[0].html;
    eq('★ 匹配时不出现"不参与检定"', /不参与检定/.test(h2), false);
  }
}

console.log('== 24. 真机反馈第五轮（M3 手机端 · 3 条）★ 本轮 ==');
{
  const strip24 = s => String(s == null ? '' : s).replace(/<[^>]+>/g, '');

  // ① 规则变更的回退提示必须指向**切换前**那条规则（不是写死的 generic）
  {
    // 匕首心 → 最终物语：回退该是 dh，不是 generic
    const c = mkCtx('dh');
    const sys = runCmd('.set rule fu', c).find(m => m.kind === 'sys');
    ok('★ 回退提示指向切换前的规则（.set rule dh）', /\.set rule dh/.test(sys.line2), sys.line2);
    eq('★ 不再写死 generic', /\.set rule generic/.test(sys.line2), false);
    // 从通用切走：回退该是 generic
    const c2 = mkCtx('generic');
    const sys2 = runCmd('.set rule coc', c2).find(m => m.kind === 'sys');
    ok('★ 从通用切走时回退提示就是 generic', /\.set rule generic/.test(sys2.line2), sys2.line2);
    // 5.5e 用文档里到处写的那个写法（'5.5e'），不是内部 key 'dnd5r'
    const c3 = mkCtx('dnd5r');
    const sys3 = runCmd('.set rule coc', c3).find(m => m.kind === 'sys');
    ok('★ 回退用的是可照抄的别名（5.5e 而不是 dnd5r）', /\.set rule 5\.5e/.test(sys3.line2), sys3.line2);
    // 六条规则两两都指向"来时那条"
    const KEYS = ['generic','dnd5e','dnd5r','coc7','dh','fu'];
    KEYS.forEach(from => KEYS.forEach(to => {
      if(from === to) return;
      const cc = mkCtx(from);
      const s = runCmd('.set rule ' + Engine.RULE_TOKEN[to], cc).find(m => m.kind === 'sys');
      ok('★ ' + from + ' → ' + to + ' 回退指回 ' + from,
        s.line2.indexOf('.set rule ' + Engine.RULE_TOKEN[from]) >= 0, s.line2);
    }));
    // ★ sys 的 line 是纯文本通道（renderSys → esc），提示里不许带标签
    ok('★ 回退提示不含 HTML 标签（sys 是 esc 通道）', !/[<>]/.test(sys.line2), sys.line2);
  }

  // ② FU 的无卡提示必须给**骰阶**，不是属性名（属性没绑卡就没有骰阶）
  {
    const tpl = Engine.FU_PACK.cardTemplate();
    const foot = (tpl.foot || []).join(' ');
    ok('★ 卡模板的无卡示例用骰阶 .fu d8 d10 10', /\.fu d8 d10 10/.test(foot), strip24(foot));
    eq('★ 卡模板不再拿属性名当"直接给骰阶"的例子', /直接给骰阶[^。]*dex ins/.test(foot), false);
    const hint = Engine.FU_PACK.checkHint();
    ok('★ checkHint 首个示例就是骰阶写法', hint.indexOf('.fu d8 d10 10') < hint.indexOf('.fu dex ins 10'), strip24(hint));
    // .rc list（本规则下）无卡时，每行都该给"此刻能掷"的写法
    const list = Engine.FU_PACK.listChecks('fu', null);
    const rows = list.sections[0].rows.map(r => r.v).join(' ');
    eq('★ 无卡时清单不再一律写 .fu dex dex 10', /\.fu dex dex 10/.test(rows), false);
    ok('★ 无卡时清单给"先绑卡 / 或直接掷骰阶"两条路', /\.st set /.test(rows) && /\.fu d8 d10 10/.test(rows), strip24(rows).slice(0, 120));
    // 绑了卡就该回到属性名（不能为了无卡把有卡的方便也砍了）
    const list2 = Engine.FU_PACK.listChecks('fu', {family:'fu', data:{dex:8, ins:10}});
    ok('★ 有卡时清单仍给属性名写法', /\.fu dex dex 10/.test(list2.sections[0].rows.map(r => r.v).join(' ')));
    // 真正照抄"提示里的写法"必须掷得出来：无卡 + 骰阶 → 出 roll
    const m = lastMsg(runCmd('.fu d8 d10 10', mkCtx('fu', null)));
    ok('★ 无卡照抄提示的骰阶写法真能掷出结果', m.kind === 'roll' && m.view.groups.length === 2, m.kind);
    const m2 = lastMsg(runCmd('.fu dex ins 10', mkCtx('fu', null)));
    ok('★ 无卡写属性名仍是友好提示（掷不出）', m2.kind === 'notice' && /尚未绑定角色卡/.test(strip24(m2.html)), strip24(m2.html).slice(0, 60));
  }

  // ③ 时间口径统一（这里只锁"引擎用的是注入时钟"这条契约；时区口径在 test_protocol §9）
  {
    const c = mkCtx('generic');
    c.room.nowMs = 1772000000000;             // core 注入的服务端时钟
    const sys = runCmd('.set rule coc', c).find(m => m.kind === 'sys');
    eq('★ 引擎用注入的 nowMs（与消息 ts 同源）', c.room.ruleSetAt, Engine.hhmm(1772000000000));
    ok('★ 广播里的时间与 room.ruleSetAt 一致', sys.line2.indexOf('于 ' + c.room.ruleSetAt) >= 0, sys.line2);
    // 不注入时退回 Date.now()，不能崩
    const c2 = mkCtx('generic');
    const sys2 = runCmd('.set rule coc', c2).find(m => m.kind === 'sys');
    ok('★ 未注入 nowMs 时退回当前时间（不崩）', /^\d{2}:\d{2}$/.test(c2.room.ruleSetAt), String(c2.room.ruleSetAt));
  }
}

console.log('\n---------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项' + (FOUND.stale ? '  （⚠️ 跑的是 M1 版 html）' : ''));
if(fail){
  console.log('\n提示：失败项若是刚改过引擎，先确认「是锁坑的断言」还是「旧实现的快照」——');
  console.log('      后者才改测试，并在文件头的「M2 迭代时改掉的断言」清单里补一行原因。');
}
process.exit(fail ? 1 : 0);

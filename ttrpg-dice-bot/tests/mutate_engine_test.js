/* ============================================================================
* 变异测试：验证 test_engine.js 的断言**真的能抓到问题**
* ----------------------------------------------------------------------------
* 【怎么用】  node tests/mutate_engine_test.js
*
* 【为什么要有这个】"装了但从没触发过的防护 = 没有防护" —— 这是本项目 M2 自己踩的坑
*   （COC「急救」与「医学」都注册了 medicine 别名，冲突检测装了却从未触发过）。
*   测试全绿只能说明"引擎现在是对的"，说明不了"引擎错了会被发现"。
*   所以：故意把引擎改坏 N 处，看测试是否失败。漏掉的那条就是摆设断言，必须修。
*
* 【★ 修断言的规矩】被漏掉的变异，几乎都说明那条断言测的是"字符串存在"而不是"行为"：
*     ❌ /\.plab\{/.test(src)                  —— CSS 类改成 display:none 仍然匹配
*     ✅ /class="plab"/.test(renderRoll(...))   —— 渲染产物里真的有才算
*   本轮就抓出过两条这样的摆设（chips 语义标签 / 别名分桶），已按上面的规矩修掉。
*   再遇到漏网的，照这个思路改断言 —— **改断言，不是改引擎**。
*
* 【★ M3 相对 M2 的改动】MUTATIONS 从 [说明, from, to] 改为 **[说明, 文件, from, to]** ——
*   拆包后引擎散在 packages/engine/src/*.js 里，必须指到具体文件。
*   22 条变异**一条没删也没改判据**，全部重新定位过（coc 4 / dh 4 / fu 4 / cmd 5 /
*   render 2 / pack_dh 1 / pack_coc 1 / pack_fu 1 / dnd 1 / card 1）。
*
* 【加新变异】往 MUTATIONS 里加一项：[说明, 文件名, 原文片段, 改成什么]。
*   每次给引擎加重要判定，都应同时加一条变异 —— 否则不知道有没有真的锁住。
* ========================================================================== */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'packages', 'engine', 'src');
const TEST = path.join(ROOT, 'tests', 'test_engine.js');
if(!fs.existsSync(TEST)){ console.error('❌ 找不到 tests/test_engine.js'); process.exit(1); }

const MUTATIONS = [
  ["★ COC 奖励骰改成取高（应被 §17 抓到）",
   'coc.js',
   "if(kind === 'bonus') tens.forEach((t, i) => { if(t < tens[pick]) pick = i; });", "if(kind === 'bonus') tens.forEach((t, i) => { if(t > tens[pick]) pick = i; });"],
  ["★ COC 掷 100 不再大失败（应被 §17 抓到）",
   'coc.js',
   "if(value === 100) return {ok:false, crit:true,", "if(false) return {ok:false, crit:true,"],
  ["★ DH 关键成功失效（应被 §18 抓到）",
   'dh.js',
   "if(hope === fear){\n    return {ok:true, crit:true,", "if(false){\n    return {ok:true, crit:true,"],
  ["★ DH 优劣势 d6 不参与总和（应被 §18 抓到）",
   'pack_dh.js',
   "sign:(mode === 'adv' ? 1 : -1)", "sign:0"],
  ["★ FU 暴击阈值放开为任意同点（应被 §19 抓到）",
   'fu.js',
   "if(v1 === v2 && v1 >= 6)", "if(v1 === v2)"],
  ["★ FU 骰阶不再要求带 d（应被 §19 抓到）",
   'fu.js',
   "const m = String(tok == null ? '' : tok).match(/^d(\\d+)$/i);", "const m = String(tok == null ? '' : tok).match(/^d?(\\d+)$/i);"],
  ["★ 主流程 .rc 分支里直接用 DND_SKILLS（应被 §22 抓到）",
   'cmd.js',
   "const r = pack.runCheck({args:a,", "const _x = DND_SKILLS.length; const r = pack.runCheck({args:a,"],
  ["★ chips 去掉语义标签（应被 §22 抓到）",
   'render.js',
   "const p = g.percent, out = ['<span class=\"plab\">\u5341\u4f4d</span>'];", "const p = g.percent, out = [];"],
  ["★ 跨规则 .dh 提示改回静默（应被 §18 抓到）",
   'cmd.js',
   "notice('\u300c<b>.' + verb + '</b>\u300d\u662f <b>'", "if(true) return {msgs:out, handled:false};\n      notice('\u300c<b>.' + verb + '</b>\u300d\u662f <b>'"],
  ["★ 换族换卡不再提示（应被 §20 抓到）",
   'cmd.js',
   "'\u5df2\u6362\u4e3a ' : '\u5df2\u7ed1\u5b9a '", "'\u5df2\u7ed1\u5b9a ' : '\u5df2\u7ed1\u5b9a '"],
  ["★ 别名分桶退回单一域（应被 §22 抓到）",
   'domains.js',
   "const CHECK_DOMAIN = {dnd:'check:dnd', coc7:'check:coc7'", "const CHECK_DOMAIN = {dnd:'check:dnd', coc7:'check:dnd'"],
  ["★ COC hp/san 不再声明不追踪（应被 §17 抓到）",
   'pack_coc.js',
   "notes.push('\u300c' + esc(hit.key.toUpperCase()) + '\u300d\u662f\u5907\u5fd8\u5b57\u6bb5 \u2014\u2014 \u9ab0\u5a18\u4e0d\u4f1a\u81ea\u52a8\u589e\u51cf\uff0c\u53ea\u6309\u5361\u4e0a\u7684\u6570\u503c\u68c0\u5b9a');", ""],
  ["★ COC 合计行恢复\"调整项 +0\"（应被 §23 抓到）",
   'render.js',
   "((v.comps && v.comps.length)\n    ? ('\u9ab0\u70b9 ' + v.diceSum + ' + \u8c03\u6574\u9879 ' + fmtMod(v.add) + ' \u2192 ' + v.total)\n    : ('\u9ab0\u70b9 ' + v.diceSum + ' \u2192 ' + v.total))", "('\u9ab0\u70b9 ' + v.diceSum + ' + \u8c03\u6574\u9879 ' + fmtMod(v.add) + ' \u2192 ' + v.total)"],
  ["★ FU 调整值不进 total（应被 §23/§21 抓到）",
   'pack_fu.js',
   "const t = buildTotal(sumKept(groups), comps);\n      const verdict = judgeFu(v1, v2, dl, mod);", "const t = buildTotal(sumKept(groups), []);\n      const verdict = judgeFu(v1, v2, dl, 0);"],
  ["★ FU 失手判定被调整值影响（应被 §23 抓到）",
   'fu.js',
   "if(v1 === 1 && v2 === 1) return {ok:false, crit:true,", "if(v1 === 1 && v2 === 1 && mod <= 0) return {ok:false, crit:true,"],
  ["★ presence 改回仪态（应被 §23 抓到）",
   'dh.js',
   "{key:'pre', zh:'\u98ce\u5ea6', en:'presence',", "{key:'pre', zh:'\u4eea\u6001', en:'presence',"],
  ["★ 「仪态」别名被移除（应被 §23 抓到）",
   'dh.js',
   "'\u98ce\u5ea6','\u4eea\u6001','\u4eea\u5bb9','\u98ce\u91c7'", "'\u98ce\u5ea6','\u4eea\u5bb9','\u98ce\u91c7'"],
  ["★ 四象限退回英文直译（应被 §23 抓到）",
   'dh.js',
   "text:'\u5e0c\u671b\u6210\u529f \u2014\u2014 \u4f60\u83b7\u5f97 1 \u5e0c\u671b\u70b9'", "text:'\u6210\u529f\u5e26\u5e0c\u671b \u2014\u2014 \u4f60\u83b7\u5f97 1 \u5e0c\u671b\u70b9'"],
  ["★ FU 物语点/物资点不再识别（应被 §23 抓到）",
   'fu.js',
   "registerAliases(CARD_DOMAIN.fu, FU_MEMO.map(m => ({key:m.key, kind:'fumemo', zh:m.zh, en:m.en, display:m.zh, aliases:m.aliases})));", ""],
  ["★ .r 不再降级接管（应被 §23 抓到）",
   'cmd.js',
   "if(fn && !broken && (!p.ok || /\\s/.test(ex))){", "if(fn && !broken && false){"],
  ["★ 真语法错误被接管吃掉（应被 §23 抓到）",
   'cmd.js',
   "const broken = /[()*/#]/.test(ex) || /\\d*d\\d+[a-zA-Z]/.test(ex);", "const broken = false;"],
  ["★ 卡不匹配时不提示 .st clear（应被 §23 抓到）",
   'card.js',
   "'\u6216\u7528 <b>.st clear</b> \u89e3\u7ed1\uff08\u89e3\u7ed1\u540e\u518d\u53d1 <b>.st</b> \u5c31\u662f\u5f53\u524d\u89c4\u5219\u7684\u89d2\u8272\u5361\u6a21\u677f\uff09'", "'\u3002'"],

];

let caught = 0; const missed = [];
for(const m of MUTATIONS){
  const name = m[0], file = m[1], from = m[2], to = m[3];
  const abs = path.join(SRC, file);
  if(!fs.existsSync(abs)){ missed.push(name + '  [文件不存在：' + file + ']'); console.log('  ⚠️  文件不存在：' + file + ' · ' + name); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  if(!src.includes(from)){
    console.log('  ⚠️  变异点没找到（引擎源码已变？请更新本文件的 MUTATIONS）：' + name + ' @ ' + file);
    missed.push(name + '  [变异点本身失效]');
    continue;
  }
  const backup = abs + '.mutate-backup';
  fs.writeFileSync(backup, src);
  fs.writeFileSync(abs, src.replace(from, to));
  let r;
  try { r = cp.spawnSync('node', [TEST], {encoding:'utf8'}); }
  finally {
    fs.copyFileSync(backup, abs);          // ★ 无论测试怎么崩，引擎必须还原
    fs.unlinkSync(backup);
  }
  const out = (r.stdout || '') + (r.stderr || '');
  const m2 = out.match(/通过 (\d+) 项，失败 (\d+) 项/);
  if(r.status !== 0){
    caught++;
    const why = m2 ? ('（' + m2[2] + ' 项断言失败）') : '（引擎崩溃 —— 也算抓到，但最好给友好提示）';
    console.log('  ✅ 抓到 · ' + name + ' ' + why);
  }else{
    missed.push(name);
    console.log('  ❌ 漏了 · ' + name + '　（测试仍全绿 —— 这条防护是摆设，必须修断言）');
  }
}

console.log('\n变异测试：' + caught + ' / ' + MUTATIONS.length + ' 被抓到');
if(missed.length){
  console.log('漏掉的（要修 test_engine.js 的断言，不是改引擎）：');
  missed.forEach(m => console.log('  · ' + m));
  process.exit(1);
}
console.log('全绿 ✅ —— 被验证过的断言都不是摆设');

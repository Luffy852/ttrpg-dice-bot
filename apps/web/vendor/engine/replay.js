/* ============================================================================
 * replay.js —— payload(事实) ⇄ view(含派生) 的**唯一转换口**（★ M3 新增）
 * ----------------------------------------------------------------------------
 * 【为什么必须有一个】
 *   铁律（原则 6）：派生值不存副本 —— total / 成功等级 / Hope-Fear 归属 / HR /
 *   暴击失手标记一律**不进 payload**。但三处都要用它们：
 *     ① 聊天流气泡（浏览器）② 详情 / 历史面板 ③ 导出的战报（Worker）
 *   没有统一转换口，三处就会各写一遍"怎么算 total"，然后慢慢漂移 ——
 *   这正是"同一份渲染不写两遍"（原则 4）在 M3 的落点。
 *
 * 【链路】
 *   view ──factsFromView──► payload(事实，可落库)
 *   payload ──viewFromPayload──► view(含派生) ──renderRoll──► HTML / Markdown
 *
 * 【★ title 为什么算事实】"这一掷叫什么"（如「侦查」「掷骰 2d6+3」）是用户认的标签，
 *   不含任何计算结果，改不了也不会与骰点不一致；若由 replay 反推，措辞迟早与当时不同。
 *   反过来，total / verdict 这些**能被事实算出来的**一律不存。
 * ========================================================================== */
import {sumKept, buildTotal, natOf, natMarkOf} from './view.js';
import {rulePack} from './packs.js';

/** view → payload（落库前的事实化） */
export function factsFromView(view, extra){
  return Object.assign({
    title: view.title || '',
    rule_at: view.ruleKey || 'generic',
    mode: view.mode || null,
    dc: (view.dc == null ? null : view.dc),
    groups: view.groups || [],
    comps: view.comps || [],
    notes: view.notes || [],
  }, extra || {});
}

/**
 * payload → view（派生值现场推导）
 * ★ 任何"把 view 存下来"的写法都是错的：事实变了，副本不会变。
 */
export function viewFromPayload(p){
  const ruleKey = (p && p.rule_at) || 'generic';
  const groups = (p && p.groups) || [];
  const comps = (p && p.comps) || [];
  const diceSum = sumKept(groups);
  const t = buildTotal(diceSum, comps);
  const nat = natOf(groups, diceSum);
  const nm = natMarkOf(nat, ruleKey);
  const pack = rulePack(ruleKey);
  // ★ 包可以只回 verdict，也可以回 {verdict, natNote} —— COC 把「为什么这个等级」写在
  //   natNote 里（verdict.why），只回 verdict 会让还原后的消息少一行判定说明，
  //   与当时别人看到的不一样。宁可让包多返回一个字段，也不要在 replay 里猜。
  const rv = (pack && pack.replayVerdict)
    ? pack.replayVerdict({groups, comps, diceSum, total:t.total, dc:(p.dc == null ? null : p.dc), nat, ruleKey})
    : null;
  const verdict = (rv && typeof rv === 'object' && 'verdict' in rv) ? rv.verdict : rv;
  const natNote = (rv && rv.natNote) || (nm && nm.note) || null;
  return {
    ruleKey, mode:(p.mode || null), groups, comps,
    diceSum:t.diceSum, add:t.add, total:t.total,
    title:(p.title || ''), dc:(p.dc == null ? null : p.dc),
    verdict:verdict || null, natBadge:(nm && nm.badge) || null, natNote,
    notes:(p.notes || []),
  };
}

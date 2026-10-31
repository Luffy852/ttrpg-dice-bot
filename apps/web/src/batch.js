/* ============================================================================
 * batch.js —— 一个批次消息该怎么落地（**唯一实现**）
 * ----------------------------------------------------------------------------
 * 【为什么单独抽一个文件】这段逻辑原先写在 main.js 的 on.batch 里，
 *   而 tests/dom_smoke.js 为了驱动页面又**抄了一份**简化版。
 *   两份实现的后果（2026-10-31 真机事故 · D 组第 4 条）：
 *     main.js 首屏分支把字段名写成 info.hasMore（net.js 里其实叫 hasMoreOlder）
 *     → hasMoreOlder 恒为 false → 顶部的"加载更早"入口不出现、滚到顶也不触发；
 *     而冒烟测试用的是自己那份副本，字段名是对的 —— 于是**测试全绿、真机全废**。
 *   抽成一个函数后，生产代码与冒烟测试跑的是同一段代码，不可能再各错各的。
 *
 * 【三批语义】why 由服务端在 OUT.BATCH 上显式标注：
 *   first = 首屏（最近 N 条）→ 记下分页锚点
 *   page  = 上翻的结果      → 插到顶部
 *   live  = 实时广播        → 追加到底
 * ========================================================================== */

/**
 * @param ui    createUI() 的返回值
 * @param msgs  消息数组
 * @param info  net.js 透传的批次信息 {why, oldest, total, hasMoreOlder}
 * @returns {string} 判定出的批次类型，便于测试断言
 */
export function applyBatch(ui, msgs, _cursor, _hasMore, info){
  const w = (info && info.why) || 'live';
  if(w === 'page'){
    ui.prepend(msgs);
    ui.doneLoadingOlder(!!(info && info.hasMoreOlder));
    ui.setPaging(info);
  }else{
    (msgs || []).forEach(m => ui.append(m));
    if(w === 'first') ui.setPaging(info);
  }
  return w;
}

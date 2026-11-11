/* ============================================================================
 * frame-route.js —— 出站帧路由的**唯一实现**（T3a）
 * ----------------------------------------------------------------------------
 * 【为什么抽出来】S1 时代 net.js 的 route() 与 tests/dom_smoke.js 里那份是
 *   两份手写的 `if(f.t === OUT.X)` 分发（坑 #18：测试那份抄对了、生产那份字段名
 *   写错 → 测试全绿、真机全废）。batch.js 已经把"批次怎么落地"抽成唯一实现，
 *   但"帧名 → 谁来处理"这条映射一直到 T3a 仍是双份。
 *
 * 【单一源】FRAME_ROUTES 是全项目唯一的「OUT 帧 → handler 名」映射表。
 *   net.js（生产）与 dom_smoke.js（冒烟）都只写各自的 handler 实现，
 *   再调同一个 createFrameRouter() 生成 route —— 分发逻辑本身只有这一份。
 *   功能开发轮加 INIT 帧时，只要在 frames.js 的 OUT 加值 + 在这张表注册，
 *   tools/check-frame-route.mjs 会强制覆盖，漏接即红。
 *
 * 【老客户端兼容】未注册的帧一律静默忽略（与旧版 else 分支一致），
 *   **运行时不抛错** —— 全覆盖由静态断言守，不靠线上崩一次才发现。
 * ========================================================================== */
import {OUT} from '../vendor/protocol/frames.js';

/** ★ 唯一映射表：OUT 帧值 → handler 名。键集合 = 已接管的帧。 */
export const FRAME_ROUTES = {
  [OUT.WELCOME]:  'welcome',
  [OUT.BATCH]:    'batch',
  [OUT.ACK]:      'ack',
  [OUT.DUP]:      'dup',
  [OUT.REJECT]:   'reject',
  [OUT.STATE]:    'state',
  [OUT.PRESENCE]: 'presence',
  [OUT.ERROR]:    'error',
  [OUT.RELOAD]:   'reload',
};

/**
 * ★ 显式豁免清单：这些 OUT 帧**当前没有消费者**。
 * PONG：心跳回包，服务端用它计时，客户端收到也不需要处理（frames.js 的注释口径）。
 * 新增帧要么进 FRAME_ROUTES，要么进这里并写明理由 —— 不许悄悄不接。
 */
export const ROUTE_EXEMPT = [OUT.PONG];

/**
 * 生成帧路由器。net.js 与 dom_smoke.js 调的是**同一个函数**。
 * @param handlers {[name:string]: (f) => any} 键必须是 FRAME_ROUTES 里的 handler 名；
 *        允许只实现自己关心的那几个（未实现的帧被忽略，等价于旧版 else 分支）。
 * @returns (f) => any  分发单帧；未知 / 豁免帧静默忽略
 */
export function createFrameRouter(handlers){
  if(!handlers || typeof handlers !== 'object') throw new Error('[frame-route] handlers 必须是对象');
  return function route(f){
    if(!f || typeof f !== 'object') return;
    const name = FRAME_ROUTES[f.t];
    if(!name) return;                       // 豁免帧 / 老客户端不认识的新帧：忽略，不崩
    const h = handlers[name];
    return typeof h === 'function' ? h(f) : undefined;
  };
}

/* ============================================================================
 * index.js —— Worker 入口：HTTP 路由 + 静态资源
 * ----------------------------------------------------------------------------
 * 【路由表】
 *   POST /api/room                  创建房间（6 位数字，惰性撞号检测）
 *   POST /api/room/:code/join       进房（PIN 房间校验；签发 token）
 *   GET  /api/room/:code/meta       房间信息（规则 / 成员 / 当前游标）
 *   GET  /api/room/:code/history    ws 不可用时的兜底拉取（cursor 增量）
 *   GET  /api/room/:code/export     导出（ndjson / md 战报，可带 from / to / sender 筛选）
 *   GET  /ws/:code?token=           实时连接
 *   其它                            → 静态资源（apps/web）
 *
 * 【★ 两条不要发挥】
 *   ① 房间号是 6 位数字，**必然可枚举**（10⁶）—— 开放房间靠"号码不公开"这一层。
 *      这是已定决策（Q26 定了 6 位、PIN 是主防护），不要再改成长随机码。
 *   ② 全局清理不在这里 —— DO 之间无全局视图。2026-11-03 实测后**取消自建 KV + Cron**：
 *      VACUUM 在 DO 上被隐式事务禁止、DELETE 后 databaseSize 立即回落，
 *      且自建方案只看得见本应用。改用 Cloudflare 原生 Alerts 对账户级 5 GB 告警。
 * ========================================================================== */
import {RoomDO} from './room.js';
import {newCode, isPin} from './auth.js';

export {RoomDO};

const JSON_ = (o, s) => Response.json(o, {status:s || 200});
const stubOf = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));
const doFetch = (stub, path, init) =>
  stub.fetch('https://room.do' + path, Object.assign({headers:{'content-type':'application/json'}}, init));

/** ★ 惰性创建式撞号检测：访问该 DO 读 created_at —— 不用 KV 维护 10⁶ 个已用号码 */
async function createRoom(env, pin){
  for(let i = 0; i < 5; i++){
    const code = newCode();
    const r = await doFetch(stubOf(env, code), '/init',
      {method:'POST', body:JSON.stringify({code, pin:(pin && isPin(pin)) ? String(pin) : null})});
    const j = await r.json();
    if(j.fresh) return {code, has_pin:!!pin};
  }
  return null;                       // 5 次都撞上：概率极低，宁可报错也不要返回撞号的房间
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);

    /* ★ T1：两个无鉴权诊断端点已移除（一次 GET 即可枚举房间号 / 成员数 / 规则 / 密钥配置，
     *   或用 PIN_SECRET 自签 token 替访客发起 ws 握手）。排障改用 Cloudflare 网页端日志；
     *   所有 /api/* 未命中分支一律返回 404，不落到静态资源 SPA 兜底（见文件末尾）。 */

    if(url.pathname === '/api/room' && request.method === 'POST'){
      let body = {};
      try{ body = await request.json(); }catch(e){}
      if(body.pin && !isPin(body.pin)) return JSON_({error:'bad_pin_format'}, 400);
      const r = await createRoom(env, body.pin);
      if(!r) return JSON_({error:'code_space_busy'}, 503);
      // ★ PIN 固化：创建这一次是唯一一次展示。房间号与 PIN 分开返回，前端必须分开显示
      //   （截图时极易只截到一个，漏看 = 永久锁死）
      return JSON_({code:r.code, has_pin:r.has_pin, pin:(body.pin && isPin(body.pin)) ? String(body.pin) : null});
    }

    let m = url.pathname.match(/^\/api\/room\/(\d{6})(\/join|\/meta|\/history|\/export|\/import)?$/);
    if(m){
      const code = m[1], sub = m[2] || '';
      const stub = stubOf(env, code);
      /* ★★ DO 回包必须连 HTTP 状态一起透传（J8 真机事故的根因之一）★★
       * 【症状】导入战报显示"新增 undefined 条 / 房间现有 undefined 条"，但没有任何报错。
       * 【链路】前端漏带 token → DO 返回 401 {error:'bad_token'} → 网关只透传 body、
       *   JSON_ 默认 200 → 前端 api() 看 r.ok=true 不抛错 → 把错误对象当成功回包渲染。
       * 【为什么比报错更糟】错误被伪装成成功，且文件根本没被解析，用户会以为"战报格式不兼容"。
       * 【为什么统一改】join 早就是 `JSON_(await r.json(), r.status)`，说明本就该透传；
       *   meta / history / import 三处漏了 —— 同类坑只修一处，下次还会从别处冒出来。 */
      const proxyDO = async (path, init) => {
        const r = await doFetch(stub, path, init);
        return JSON_(await r.json(), r.status);
      };
      if(sub === '/join' && request.method === 'POST'){
        let b = {}; try{ b = await request.json(); }catch(e){}
        /* ★ cid 必须一起转发（真机踩到）：这里原先只转 {nick, pin}，
         *   前端辛苦生成并持久化的 cid 在网关这一层被丢掉 —— DO 侧逻辑全对也没用。
         *   这类"转发漏字段"的 bug 单测很难发现（room.js 单独跑是好的），只能靠端到端。 */
        const r = await doFetch(stub, '/join', {method:'POST', body:JSON.stringify({nick:b.nick, pin:b.pin, cid:b.cid})});
        /* ★ 原样透传：join 的 nick 是服务端算出的权威昵称（找回身份时可能与客户端填的不同），
         *   网关丢字段 = 前端又拿默认"玩家"当自己 —— 上次 cid 就是这么丢的。 */
        return JSON_(await r.json(), r.status);
      }
      if(sub === '/meta')    return proxyDO('/meta');
      if(sub === '/history') return proxyDO('/history?' + url.searchParams.toString());
      if(sub === '/export'){
        const r = await doFetch(stub, '/export?' + url.searchParams.toString());
        /* ★ 状态也带上：导出是下载流，但 DO 侧 401 / 500 时回的是 JSON 错误体，
         *   伪装成 200 会让浏览器把一个 error.json 当成正常战报。 */
        return new Response(r.body, {status:r.status, statusText:r.statusText, headers:r.headers});
      }
      /* ★ 导入：必须把**整个 body 原文**转过去。
       *   战报文本可能很长（几百条消息），在网关解一次再重新序列化既浪费又可能改坏内容；
       *   而且只在 POST 时转发 —— 没有 body 的 GET 会得到 400，不必让 DO 白跑一趟。 */
      if(sub === '/import' && request.method === 'POST'){
        /* ★ token 在**查询串**里，必须一起转发：只转 body 的话 DO 侧拿不到 token →
         *   bad_token。/export 那边是拼了 searchParams 的，这里漏了就会 401。
         *   ★ 前端那一跳也必须拼 token（apps/web/src/main.js onImport），两边缺一不可。 */
        return proxyDO('/import?' + url.searchParams.toString(),
          {method:'POST', body:await request.text()});
      }
      return JSON_({error:'bad_sub'}, 404);
    }

    /* ★ T1：/api/* 已知分支都未命中 → 明确 404，不交给 env.ASSETS。
     *   wrangler.toml 的 not_found_handling = "single-page-application" 会把未知路径
     *   兜成 index.html + 200；光删端点会让被删的诊断地址拿到 200 页面，既达不到
     *   「返回 404」的验收，也会把 API 路径伪装成正常页面。 */
    if(url.pathname.startsWith('/api/')) return new Response('not found', {status:404});

    m = url.pathname.match(/^\/ws\/(\d{6})$/);
    if(m){
      const token = url.searchParams.get('token');
      if(!token) return new Response('missing token', {status:401});
      /* ★ 必须**原样透传 request**，不能只传 URL。
       * WebSocket 握手靠的是请求头：Upgrade / Connection / Sec-WebSocket-Key / Sec-WebSocket-Version。
       * 早先这里写成 `stub.fetch('https://room.do/ws?token=...')` —— 等于只转了 URL，
       * 那些头全丢了，DO 就算回了 101 也建立不了连接，浏览器立刻断开 → 前端无限重连
       * （现象：页面一直刷"连接断开，正在重连"，指令卡在"发送中"）。
       * 透传 request 会把方法与全部请求头一起带过去，握手才成立。 */
      return stubOf(env, m[1]).fetch(request);
    }

    // 静态资源（apps/web）：前端与 Worker 同一域名，所以不需要 CORS
    if(env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', {status:404});
  },
};

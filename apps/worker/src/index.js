/* ============================================================================
 * index.js —— Worker 入口：HTTP 路由 + 静态资源
 * ----------------------------------------------------------------------------
 * 【路由表】
 *   POST /api/room                  创建房间（6 位数字，惰性撞号检测）
 *   POST /api/room/:code/join       进房（PIN 房间校验；签发 token）
 *   GET  /api/room/:code/meta       房间信息（规则 / 成员 / 当前游标）
 *   GET  /api/room/:code/history    ws 不可用时的兜底拉取（cursor 增量）
 *   GET  /api/room/:code/export     导出（ndjson 全量 / md 战报）
 *   GET  /ws/:code?token=           实时连接
 *   其它                            → 静态资源（apps/web）
 *
 * 【★ 两条不要发挥】
 *   ① 房间号是 6 位数字，**必然可枚举**（10⁶）—— 开放房间靠"号码不公开"这一层。
 *      这是已定决策（Q26 定了 6 位、PIN 是主防护），不要再改成长随机码。
 *   ② 全局 500M 清理不在这里 —— DO 之间无全局视图，需要 KV 索引 + Cron（阶段 4 的 cron.js）。
 * ========================================================================== */
import {RoomDO} from './room.js';
import {newCode, isCode, isPin} from './auth.js';

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

    let m = url.pathname.match(/^\/api\/room\/(\d{6})(\/join|\/meta|\/history|\/export)?$/);
    if(m){
      const code = m[1], sub = m[2] || '';
      const stub = stubOf(env, code);
      if(sub === '/join' && request.method === 'POST'){
        let b = {}; try{ b = await request.json(); }catch(e){}
        const r = await doFetch(stub, '/join', {method:'POST', body:JSON.stringify({nick:b.nick, pin:b.pin})});
        return JSON_(await r.json(), r.status);
      }
      if(sub === '/meta')    return JSON_(await (await doFetch(stub, '/meta')).json());
      if(sub === '/history') return JSON_(await (await doFetch(stub, '/history?' + url.searchParams.toString())).json());
      if(sub === '/export'){
        const r = await doFetch(stub, '/export?' + url.searchParams.toString());
        return new Response(r.body, {headers:r.headers});
      }
      return JSON_({error:'bad_sub'}, 404);
    }

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

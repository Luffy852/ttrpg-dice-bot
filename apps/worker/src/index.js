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
import {newCode, isCode, isPin, signToken} from './auth.js';

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

    /* ★ 在线诊断：打开一个网址就能看到"到底哪一步不通"（纯文本，浏览器直接显示）
     * 【为什么要有】ws 连不上时，我在沙盒里**拿不到任何服务端日志**（部署不了、没有 tail）。
     *   只能靠推理，已经错了两轮。这个端点把运行时的事实一次性打出来：
     *   密钥有没有、DO 绑定在不在、房间号能不能匹配、DO 能不能访问。
     *   用法：浏览器打开 /api/diag?code=123456 —— 把看到的文字整段发给我。 */
    /* ★ ws 握手专项诊断：从 Worker 内部用 fetch 带 Upgrade 头打一次 DO，看它回什么
     * 【与 /api/diag 的区别】/api/diag 只证明"DO 活着、认得房间号"；
     *   这里直接模拟一次 WebSocket 握手，能区分三种失败：
     *     ① DO 回了 101        → 服务端没问题，问题在 Cloudflare 的路由/静态资源层
     *     ② DO 回了 401        → token 校验挂了（PIN_SECRET 变了 / token 过期）
     *     ③ DO 回了 404/500    → 路由没匹配或代码抛异常
     *   用法：浏览器打开 /api/wsdiag?code=123456 */
    if(url.pathname === '/api/wsdiag'){
      const c = (url.searchParams.get('code') || '').trim();
      const L = [];
      const say = (k, v) => L.push(k.padEnd(24) + ' : ' + v);
      if(!/^\d{6}$/.test(c)){
        return new Response('需要 6 位房间号：/api/wsdiag?code=123456', {status:400,
          headers:{'content-type':'text/plain; charset=utf-8'}});
      }
      try{
        const t = await signToken({code:c, anon_id:'diag', exp:Math.floor(Date.now() / 1000) + 300}, env.PIN_SECRET);
        const up = new Request('https://room.do/ws/' + c + '?token=' + encodeURIComponent(t), {
          headers:{'Upgrade':'websocket', 'Connection':'Upgrade',
            'Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version':'13'},
        });
        const r = await stubOf(env, c).fetch(up);
        say('DO 握手返回状态', r.status + '  ' + ((r.status === 101) ? '✅ 101 = 握手成功' : '❌ 期待 101'));
        say('Upgrade 响应头', r.headers.get('Upgrade') || '(无)');
        say('Connection 响应头', r.headers.get('Connection') || '(无)');
        say('webSocket 对象', r.webSocket ? '✅ 已附上' : '❌ 缺失（DO 没走 WebSocketPair）');
        L.push('');
        L.push('判读：');
        L.push('  101 + 已附上 → 服务端 OK，问题在 Cloudflare 路由层（run_worker_first / 静态资源）');
        L.push('  401          → token 校验挂了：PIN_SECRET 与签发时不一致，或服务器时间不对');
        L.push('  404          → DO 里没匹配上 /ws 路径（room.js 的路由）');
        L.push('  500          → DO 代码抛异常');
      }catch(e){
        say('DO 握手', '❌ 抛异常：' + String((e && e.message) || e));
      }
      return new Response(L.join('\n'), {headers:{'content-type':'text/plain; charset=utf-8'}});
    }

    if(url.pathname === '/api/diag'){
      const code = (url.searchParams.get('code') || '').trim();
      const L = [];
      const say = (k, v) => L.push(k.padEnd(22) + ' : ' + v);
      say('Worker', '运行中（能看到这行就说明 Worker 活着）');
      say('PIN_SECRET', env.PIN_SECRET ? ('已设置（长度 ' + String(env.PIN_SECRET).length + '）') : '❌ 未设置');
      say('ROOM 绑定', env.ROOM ? '已绑定' : '❌ 未绑定（wrangler.toml 的 durable_objects 没生效）');
      say('ASSETS 绑定', env.ASSETS ? '已绑定' : '❌ 未绑定');
      say('房间号入参', code ? code : '（未带 code 参数）');
      say('房间号格式(6位数字)', /^\d{6}$/.test(code) ? '✅ 合法' : '❌ 不合法');
      if(env.ROOM && /^\d{6}$/.test(code)){
        try{
          const r = await stubOf(env, code).fetch('https://room.do/meta');
          const j = await r.json().catch(() => ({}));
          say('DO 可访问', '✅ 是（HTTP ' + r.status + '）');
          say('DO 返回的房间号', j.code || '(空)');
          say('DO 是否认得这个房间', (j.code === code) ? '✅ 认得' : '❌ 对不上（DO 的 idFromName 与房间号不一致）');
          say('规则', j.rule || '(空)');
          say('成员数', (j.members || []).length);
        }catch(e){
          say('DO 可访问', '❌ 抛异常：' + String(e && e.message || e));
        }
      }
      L.push('');
      L.push('—— 如果上面都正常但仍连不上，请把这段整段发我 ——');
      return new Response(L.join('\n'), {headers:{'content-type':'text/plain; charset=utf-8'}});
    }

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
      if(sub === '/meta')    return JSON_(await (await doFetch(stub, '/meta')).json());
      if(sub === '/history') return JSON_(await (await doFetch(stub, '/history?' + url.searchParams.toString())).json());
      if(sub === '/export'){
        const r = await doFetch(stub, '/export?' + url.searchParams.toString());
        return new Response(r.body, {headers:r.headers});
      }
      /* ★ 导入：必须把**整个 body 原文**转过去。
       *   战报文本可能很长（几百条消息），在网关解一次再重新序列化既浪费又可能改坏内容；
       *   而且只在 POST 时转发 —— 没有 body 的 GET 会得到 400，不必让 DO 白跑一趟。 */
      if(sub === '/import' && request.method === 'POST'){
        /* ★ token 在**查询串**里，必须一起转发：只转 body 的话 DO 侧拿不到 token →
         *   bad_token。/export 那边是拼了 searchParams 的，这里漏了就会 401。 */
        return JSON_(await (await doFetch(stub, '/import?' + url.searchParams.toString(),
          {method:'POST', body:await request.text()})).json());
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

/* ============================================================================
 * net.js —— ws 客户端：重连退避 + 游标补齐 + 幂等重发
 * ----------------------------------------------------------------------------
 * 【★ 三条规矩（都是手册增补 6.7 的坑，写成代码而不是注释）】
 *   ① 客户端时间不可信 → 显示用的时间戳一律来自服务端消息，本文件不生成任何 ts
 *   ② 重连必须幂等 → 重连后上报 cursor（我已渲染到哪），服务端只补它之后的；
 *      同时本地按 msg_id 去重（ui.js 里的 seen），**两边都要有**
 *   ③ 动作必须带幂等键 → 同一条指令重试只发同一个 req_id，服务端回 dup 而不是掷第二次。
 *      所以"发送中"的气泡不会变成两颗骰子 —— 这是骰娘最不能错的地方
 *
 * 【不做乐观更新】规则/昵称/裸骰的显示一律等 state 帧回写（core 返回什么就显示什么）。
 * ========================================================================== */
import {IN, OUT, PROTOCOL_VERSION} from '../vendor/protocol/frames.js';
import {makeReqId, makeClientId, backoff, cursorOf} from '../vendor/protocol/cursor.js';

const HB_MS = 20000;        // 心跳间隔（服务端 45s 无帧断开）
const PAGE = 200;           // 首屏 / 翻页条数
const MAX_RETRY = 8;        // 重连上限：约 1 分钟内连不上就停，明确告知而不是无限刷屏

function clientId(){
  let c = null;
  try{ c = localStorage.getItem('db:cid'); }catch(e){}
  if(!c){ c = makeClientId(crypto); try{ localStorage.setItem('db:cid', c); }catch(e){} }
  return c;
}

export function createNet({code, token, nick, on = {}}){
  let ws = null, cursor = 0, tries = 0, dead = false, n = 0, hb = null;
  const outbox = [];                       // 断线期间攒的帧，连上后按序补发
  const cid = clientId();
  const nextReq = () => makeReqId(cid, ++n);
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
    '/ws/' + code + '?token=' + encodeURIComponent(token);

  function connect(){
    ws = new WebSocket(url);
    ws.onopen = () => {
      tries = 0;
      ws.send(JSON.stringify({t:IN.HELLO, v:PROTOCOL_VERSION, token, cursor, nick}));
      beat();
      while(outbox.length) ws.send(JSON.stringify(outbox.shift()));
      on.open && on.open();
    };
    ws.onmessage = e => {
      let f; try{ f = JSON.parse(e.data); }catch(err){ return; }
      route(f);
    };
    ws.onclose = () => {
      stopBeat();
      if(dead) return;
      /* ★ 重连必须有上限：服务端一旦持续拒绝（token 失效、握手建不起来），
       *   无差别重连会让页面一直刷"连接断开，正在重连"、指令永远卡在"发送中" ——
       *   用户看不出"是彻底连不上"还是"快连上了"。连满 N 次就停下并明说。 */
      if(tries >= MAX_RETRY){
        on.giveup && on.giveup();
        return;
      }
      const wait = backoff(tries++);       // 指数退避 + 抖动：一屋子人同时重连会把服务端打爆
      on.close && on.close(wait, tries);
      setTimeout(connect, wait);
    };
    ws.onerror = () => {};                 // 错误统一走 onclose 重连，不额外处理
  }

  function route(f){
    if(f.t === OUT.WELCOME) return on.welcome && on.welcome(f);
    if(f.t === OUT.BATCH){
      if(f.msgs && f.msgs.length){
        cursor = Math.max(cursor, cursorOf(f.msgs));
        on.batch && on.batch(f.msgs, f.cursor, f.has_more);
      }
      return;
    }
    if(f.t === OUT.ACK)     return on.ack && on.ack(f.req_id, f.seq);
    if(f.t === OUT.DUP)     return on.dup && on.dup(f.req_id, f.seq, f.deleted);
    if(f.t === OUT.REJECT)  return on.reject && on.reject(f.req_id, f.code);
    if(f.t === OUT.STATE)   return on.state && on.state(f.room);
    if(f.t === OUT.PRESENCE)return on.presence && on.presence(f.members);
    if(f.t === OUT.ERROR)   return on.error && on.error(f.code);
  }

  function beat(){ stopBeat(); hb = setInterval(() => { if(ws && ws.readyState === 1) ws.send(JSON.stringify({t:IN.PING, ts:Date.now()})); }, HB_MS); }
  function stopBeat(){ if(hb) clearInterval(hb); hb = null; }
  function post(f){ if(ws && ws.readyState === 1) ws.send(JSON.stringify(f)); else outbox.push(f); }

  return {
    connect,
    /** @returns {string} req_id —— 重试必须用同一个，否则会掷第二次 */
    send(text){ const reqId = nextReq(); post({t:IN.CMD, req_id:reqId, text}); return reqId; },
    sync(){ post({t:IN.SYNC, cursor, limit:PAGE}); },
    history(beforeSeq){ post({t:IN.HISTORY, before_seq:beforeSeq, limit:PAGE}); },
    close(){ dead = true; stopBeat(); if(ws) ws.close(1000, 'bye'); },
    get cursor(){ return cursor; },
    get live(){ return !!ws && ws.readyState === 1; },
  };
}

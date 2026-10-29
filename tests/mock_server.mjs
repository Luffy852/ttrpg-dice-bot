/* ============================================================================
 * mock_server.mjs —— 房间服务端的内存替身（帧路由用 core.js，不是另写一套）
 * ----------------------------------------------------------------------------
 * 【为什么需要它】room.js 是 DO 的 IO 胶水，沙盒跑不了（要 Cloudflare）。
 *   但"前端 ↔ 帧 ↔ 内核"这条链路**可以**在沙盒里真跑：把传输换成内存函数调用，
 *   其余（帧校验、core、engine、渲染）全是生产代码。
 *   这样 dom_smoke 验的是真的端到端，不是"UI 单独能渲染"。
 *
 * 【★ 它只替换 IO，不替换逻辑】帧处理顺序与 room.js 的 webSocketMessage 保持一致；
 *   若 room.js 改了协议行为，tools/check-worker.mjs 会提示两边对齐。
 * ========================================================================== */
import {createRoomCore} from '../apps/worker/src/core.js';
import {createMemoryStorage} from './memory_storage.mjs';
import {checkIn, IN, OUT, PROTOCOL_VERSION} from '../packages/protocol/src/frames.js';

export function createMockServer(code){
  const st = createMemoryStorage(code);
  let t = 1772000000000;
  const core = createRoomCore(st, {now: () => (t += 100)});
  const nicks = new Map();
  const conns = new Set();
  let anonSeq = 0;

  const members = () => Array.from(nicks, ([anon_id, nick]) => ({anon_id, nick}));

  return {
    storage: st, core,
    attach(ws, anonId, nick){ conns.add({ws, anonId, nick}); return () => { conns.delete([...conns].find(c => c.ws === ws)); }; },
    join(nick){
      const anonId = 'a' + (++anonSeq);
      nicks.set(anonId, nick || '玩家');
      return {anon_id:anonId, token:'tok-' + anonId};
    },
    /** 处理一帧。返回 {me:[…只回本连接], all:[…广播给所有连接]} */
    async frame(f, who){
      const bad = checkIn(f);
      if(bad) return {me:[{t:OUT.ERROR, code:bad}]};

      if(f.t === IN.HELLO){
        const room = await st.getRoom();
        const me = {me:[
          {t:OUT.WELCOME, v:PROTOCOL_VERSION, you:{anon_id:who.anonId, nick:f.nick || who.nick},
           room:{rule:room.rule, baredice:!!room.baredice, seq:room.seq}, server_time:Date.now(), members:members()},
        ]};
        const r = await core.since(f.cursor || 0, 200);
        if(r.msgs.length) me.me.push({t:OUT.BATCH, msgs:r.msgs, cursor:r.cursor, has_more:r.has_more});
        me.all = [{t:OUT.PRESENCE, members:members()}];
        return me;
      }
      if(f.t === IN.PING) return {me:[{t:OUT.PONG, ts:f.ts}]};
      if(f.t === IN.SYNC){
        const r = await core.since(f.cursor || 0, f.limit || 200);
        return {me:[{t:OUT.BATCH, msgs:r.msgs, cursor:r.cursor, has_more:r.has_more}]};
      }
      if(f.t === IN.HISTORY){
        const r = await core.history(f.before_seq, f.limit || 200);
        return {me:[{t:OUT.BATCH, msgs:r.msgs, cursor:r.cursor, has_more:false}]};
      }
      if(f.t === IN.CMD || f.t === IN.CHAT){
        const r = await core.apply({reqId:f.req_id, text:f.text, anonId:who.anonId, nick:who.nick});
        if(r.reject) return {me:[{t:OUT.REJECT, req_id:f.req_id, code:r.reject.code}]};
        if(r.dup)    return {me:[{t:OUT.DUP, req_id:f.req_id, seq:r.seq, deleted:!!r.deleted}]};
        const out = {me:[{t:OUT.ACK, req_id:f.req_id, seq:r.seq}],
          all:[{t:OUT.BATCH, msgs:r.msgs, cursor:r.msgs.length ? r.msgs[r.msgs.length - 1].seq : 0}]};
        if(r.state) out.all.push({t:OUT.STATE, room:r.state});
        return out;
      }
      return {me:[]};
    },
    broadcast(frames){ conns.forEach(c => frames.forEach(f => c.ws.emit(f))); },
    conns, members,
  };
}

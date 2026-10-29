/* ============================================================================
 * room.js —— 房间 Durable Object（每个房间一个 DO，SQLite 持久化 + ws 广播）
 * ----------------------------------------------------------------------------
 * 【★ 本文件只有 IO 胶水，没有业务逻辑】
 *   幂等 / 游标 / 防重掷 / 状态写回全部在 core.js（纯逻辑，node 里 51 项断言真跑过）。
 *   这里只做三件事：① 把 SQLite 包装成 core 要的 storage 接口 ② ws 收发 ③ alarm 清理。
 *   把机制写进 DO = 只能靠部署到 Cloudflare 才能验，而沙盒**部署不了**。
 *
 * 【★ 三条不能违反】
 *   ① 不存客户端时间：ts 一律服务端生成（core 已保证，这里不做任何 Date 覆盖）
 *   ② 不乐观更新：前端一律等状态帧回写（core 返回 state，这里只转发）
 *   ③ 连接信息进 attachment，不进内存 —— DO 会休眠，内存态会丢
 *
 * 【接口对齐】本文件的 storage 实现必须与 tests/memory_storage.mjs 逐方法对齐，
 *   tools/check-worker.mjs 会扫这个（两边漂移 = 沙盒里全绿、线上全错）。
 * ========================================================================== */
import {DurableObject} from 'cloudflare:workers';
import {createRoomCore} from './core.js';
import {checkIn, IN, ERR, OUT} from '../../../packages/protocol/src/frames.js';
import {exportAs, FORMAT} from './export.js';
import {verifyToken, verifyPin, newSalt, hashPin, signToken, TOKEN_TTL} from './auth.js';

const DAY = 86400000;
const KEEP_DAYS = 30;          // 房间消息留存
const WARN_DAYS = 23;          // 到期前 7 天提醒（档案：清理动作必须告知，不能静默）

/* ★ schema 的唯一出处是 schema.sql（含注释与理由）；这里是它的运行时副本。
   tools/check-worker.mjs 会比对两者是否一致 —— 不能只在其中一处改。 */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS room (
     id INTEGER PRIMARY KEY CHECK (id = 1), code TEXT NOT NULL, created_at INTEGER NOT NULL,
     last_active INTEGER NOT NULL, rule TEXT NOT NULL DEFAULT 'generic', baredice INTEGER NOT NULL DEFAULT 0,
     rule_set_by TEXT, rule_set_at INTEGER, pin_hmac TEXT, pin_salt TEXT,
     seq INTEGER NOT NULL DEFAULT 0, notified_clean INTEGER NOT NULL DEFAULT 0, ver INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS members (
     anon_id TEXT PRIMARY KEY, nick TEXT NOT NULL, joined_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL, msg_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS messages (
     seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, kind TEXT NOT NULL,
     from_name TEXT NOT NULL, actor TEXT, anon_id TEXT, req_id TEXT, rule_at TEXT, payload TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_req ON messages(req_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(anon_id, seq)`,
  `CREATE TABLE IF NOT EXISTS idempotency (req_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_idem_ts ON idempotency(ts)`,
  `CREATE TABLE IF NOT EXISTS pcs (anon_id TEXT PRIMARY KEY, family TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
];

export class RoomDO extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    SCHEMA.forEach(s => this.sql.exec(s));
    this.core = createRoomCore(this.storage(), {now: () => Date.now()});
  }

  /* ---------- storage：core.js 需要的接口（与 memory_storage 逐方法对齐） ---------- */
  storage(){
    const sql = this.sql, ctx = this.ctx;
    const q = (s, ...p) => sql.exec(s, ...p).toArray();
    const one = (s, ...p) => q(s, ...p)[0] || null;
    const row2msg = r => ({
      seq:r.seq, id:r.id, ts:r.ts, kind:r.kind, from:r.from_name, actor:r.actor,
      anon_id:r.anon_id, req_id:r.req_id, rule_at:r.rule_at, payload:JSON.parse(r.payload),
    });
    return {
      code: this.code,
      async getRoom(){
        const r = one('SELECT * FROM room WHERE id = 1');
        // ★ 未 /init 的空房间也返回可用默认值：core.buildCtx 不该为"表还没行"而崩
        return r ? {code:r.code, rule:r.rule, baredice:!!r.baredice, ruleSetBy:r.rule_set_by,
                    ruleSetAt:r.rule_set_at, seq:r.seq, created_at:r.created_at}
                 : {code:this.code, rule:'generic', baredice:false, ruleSetBy:null, ruleSetAt:null,
                    seq:0, created_at:Date.now()};
      },
      async setRoom(p){
        // 只写 core 会改的四个字段（diff，不整存 —— 少一次全行覆盖就少一处并发覆盖风险）
        sql.exec('UPDATE room SET rule = ?, baredice = ?, rule_set_by = ?, rule_set_at = ? WHERE id = 1',
          p.rule, p.baredice ? 1 : 0, p.ruleSetBy, p.ruleSetAt);
      },
      // ★ seq 分配必须在事务里：并发时两条指令不能拿到同一段（DO 单线程 + transactionSync 双保险）
      async allocSeq(n){
        let base = 0;
        ctx.storage.transactionSync(() => {
          const r = one('SELECT seq FROM room WHERE id = 1');
          base = (r ? r.seq : 0) + 1;
          sql.exec('UPDATE room SET seq = ? WHERE id = 1', base + n - 1);
        });
        return base;
      },
      async getCard(a){
        const r = one('SELECT family, data FROM pcs WHERE anon_id = ?', a);
        return r ? {family:r.family, data:JSON.parse(r.data)} : null;
      },
      async setCard(a, card){
        sql.exec(`INSERT INTO pcs (anon_id, family, version, data, updated_at) VALUES (?, ?, 1, ?, ?)
                  ON CONFLICT(anon_id) DO UPDATE SET family = excluded.family, data = excluded.data,
                  version = version + 1, updated_at = excluded.updated_at`,
          a, card.family, JSON.stringify(card.data), Date.now());
      },
      async setNick(a, n){ sql.exec('UPDATE members SET nick = ? WHERE anon_id = ?', n, a); },
      async getIdem(reqId){
        const r = one('SELECT seq, ts FROM idempotency WHERE req_id = ?', reqId);
        return r ? {req_id:reqId, seq:r.seq, ts:r.ts} : null;
      },
      async putIdem(reqId, seq, ts){
        sql.exec('INSERT OR IGNORE INTO idempotency (req_id, seq, ts) VALUES (?, ?, ?)', reqId, seq, ts);
      },
      async existsSeq(seq){ return !!one('SELECT 1 FROM messages WHERE seq = ?', seq); },
      async insertMsgs(list){
        // ★ 与幂等键同事务：崩在写消息之前，重试会拿到 dup（不重掷）；崩在中间也不会出现
        //   "骰了但没记"的空洞。逐条 exec 慢一点没关系 —— 一条指令最多产出几条消息。
        ctx.storage.transactionSync(() => {
          for(const m of list) sql.exec(
            'INSERT INTO messages (seq, id, ts, kind, from_name, actor, anon_id, req_id, rule_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            m.seq, m.id, m.ts, m.kind, m.from, m.actor || null, m.anon_id || null,
            m.req_id || null, m.rule_at || null, JSON.stringify(m.payload));
        });
      },
      async recentRolls(anonId, n){
        return q('SELECT * FROM messages WHERE kind = ? AND anon_id = ? ORDER BY seq DESC LIMIT ?', 'roll', anonId, n)
          .reverse().map(row2msg);
      },
      async since(cursor, limit){
        return q('SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?', cursor, limit).map(row2msg);
      },
      async history(beforeSeq, limit){
        return q('SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?', beforeSeq, limit)
          .reverse().map(row2msg);
      },
    };
  }

  /* ---------- HTTP：创建 / 加入 / meta / 历史 / 导出 / ws 升级 ---------- */
  async fetch(req){
    const url = new URL(req.url);
    const now = Date.now();

    if(url.pathname === '/init'){
      const body = await req.json();
      const pin = body.pin || null;
      let pinHmac = null, pinSalt = null;
      if(pin){ pinSalt = newSalt(); pinHmac = await hashPin(pin, pinSalt, this.env.PIN_SECRET); }
      this.sql.exec(`INSERT OR IGNORE INTO room (id, code, created_at, last_active, rule, baredice, seq)
                     VALUES (1, ?, ?, ?, 'generic', 0, 0)`, body.code, now, now);
      if(pin) this.sql.exec('UPDATE room SET pin_hmac = ?, pin_salt = ? WHERE id = 1', pinHmac, pinSalt);
      const r = this.sql.exec('SELECT created_at FROM room WHERE id = 1').toArray()[0];
      // ★ 惰性撞号检测：不存在或已过期即占用成功；存在且未过期说明撞号了（由 Worker 重试）
      return Response.json({created_at:r.created_at, fresh:(now - r.created_at) < 1000});
    }

    if(url.pathname === '/join'){
      const {nick, pin} = await req.json();
      const room = this.sql.exec('SELECT * FROM room WHERE id = 1').toArray()[0];
      if(!room) return Response.json({error:'no_room'}, {status:404});
      if(room.pin_hmac){
        const v = await verifyPin(String(pin || ''), room.pin_salt, room.pin_hmac, this.env.PIN_SECRET);
        if(!v.ok) return Response.json({error:'bad_pin'}, {status:401});
      }
      const anonId = crypto.randomUUID();
      this.sql.exec('INSERT OR IGNORE INTO members (anon_id, nick, joined_at, last_seen, msg_count) VALUES (?, ?, ?, ?, 0)',
        anonId, String(nick || '玩家').slice(0, 16), now, now);
      const token = await signToken({code:room.code, anon_id:anonId, exp:Math.floor(now / 1000) + TOKEN_TTL}, this.env.PIN_SECRET);
      return Response.json({token, anon_id:anonId, rule:room.rule});
    }

    if(url.pathname === '/meta'){
      const room = this.sql.exec('SELECT rule, baredice, created_at, seq, pin_hmac FROM room WHERE id = 1').toArray()[0];
      const members = this.sql.exec('SELECT anon_id, nick FROM members ORDER BY joined_at').toArray();
      if(!room) return Response.json({error:'no_room'}, {status:404});
      return Response.json({code:this.code, rule:room.rule, baredice:!!room.baredice,
        has_pin:!!room.pin_hmac, members, msg_seq:room.seq, created_at:room.created_at});
    }

    if(url.pathname === '/history'){
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const r = await this.core.since(cursor, Number(url.searchParams.get('limit') || 200));
      return Response.json(r);
    }

    if(url.pathname === '/export'){
      const t = url.searchParams.get('token');
      const v = await verifyToken(t, this.env.PIN_SECRET);
      if(!v.ok) return Response.json({error:v.why}, {status:401});
      const all = this.sql.exec('SELECT * FROM messages ORDER BY seq').toArray()
        .map(r => ({seq:r.seq, id:r.id, ts:r.ts, kind:r.kind, from:r.from_name, actor:r.actor,
                    anon_id:r.anon_id, req_id:r.req_id, rule_at:r.rule_at, payload:JSON.parse(r.payload)}));
      const room = this.sql.exec('SELECT rule FROM room WHERE id = 1').toArray()[0] || {};
      const out = exportAs(all, {code:this.code, rule:room.rule,
        exportedAt:new Date().toISOString().slice(0, 16).replace('T', ' ')},
        (url.searchParams.get('format') === FORMAT.MD) ? FORMAT.MD : FORMAT.NDJSON);
      return new Response(out.body, {headers:{'content-type':out.type,
        'content-disposition':'attachment; filename="' + out.name + '"'}});
    }

    if(url.pathname === '/ws'){
      const v = await verifyToken(url.searchParams.get('token'), this.env.PIN_SECRET);
      if(!v.ok) return new Response('bad token', {status:401});
      if(v.payload.code !== this.code) return new Response('token 与房间不符', {status:401});
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair.server);
      // ★ 身份只存 attachment：DO 休眠唤醒后内存态丢失，attachment 会被恢复
      pair.server.serializeAttachment({anon_id:v.payload.anon_id});
      this.sql.exec('UPDATE members SET last_seen = ? WHERE anon_id = ?', Date.now(), v.payload.anon_id);
      this.sql.exec('UPDATE room SET last_active = ? WHERE id = 1', Date.now());
      return new Response(null, {status:101, webSocket:pair.client});
    }
    return new Response('not found', {status:404});
  }

  /* ---------- WebSocket ---------- */
  async webSocketMessage(ws, data){
    let f;
    try{ f = JSON.parse(data); }catch(e){ return this.send(ws, {t:OUT.ERROR, code:ERR.BAD_FRAME}); }
    const bad = checkIn(f);
    if(bad) return this.send(ws, {t:OUT.ERROR, code:bad, req_id:f.req_id || null});

    const att = ws.deserializeAttachment() || {};
    const anonId = att.anon_id;

    if(f.t === IN.HELLO){
      const room = await this.storage().getRoom();
      const me = this.sql.exec('SELECT nick FROM members WHERE anon_id = ?', anonId).toArray()[0] || {};
      this.send(ws, {t:OUT.WELCOME, you:{anon_id:anonId, nick:f.nick || me.nick || '玩家'},
        room:{rule:room.rule, baredice:!!room.baredice, seq:room.seq}, server_time:Date.now(),
        members:this.sql.exec('SELECT anon_id, nick FROM members ORDER BY joined_at').toArray()});
      // ★ 补齐：客户端上报它已渲染到哪（cursor），服务端只发它之后的 —— 不存服务端 cursor
      const r = await this.core.since(f.cursor || 0, 200);
      if(r.msgs.length) this.send(ws, {t:OUT.BATCH, msgs:r.msgs, cursor:r.cursor, has_more:r.has_more});
      return this.broadcast({t:OUT.PRESENCE, members:this.members()}, ws);
    }

    if(f.t === IN.PING){ return this.send(ws, {t:OUT.PONG, ts:f.ts}); }
    if(f.t === IN.SYNC){
      const r = await this.core.since(f.cursor || 0, f.limit || 200);
      return this.send(ws, {t:OUT.BATCH, msgs:r.msgs, cursor:r.cursor, has_more:r.has_more});
    }
    if(f.t === IN.HISTORY){
      const r = await this.core.history(f.before_seq, f.limit || 200);
      return this.send(ws, {t:OUT.BATCH, msgs:r.msgs, cursor:r.cursor, has_more:false});
    }

    if(f.t === IN.CMD || f.t === IN.CHAT){
      const nickRow = this.sql.exec('SELECT nick FROM members WHERE anon_id = ?', anonId).toArray()[0] || {};
      const r = await this.core.apply({reqId:f.req_id, text:f.text, anonId, nick:nickRow.nick || '玩家'});
      if(r.reject) return this.send(ws, {t:OUT.REJECT, req_id:f.req_id, code:r.reject.code});
      if(r.dup)    return this.send(ws, {t:OUT.DUP, req_id:f.req_id, seq:r.seq, deleted:!!r.deleted});
      this.send(ws, {t:OUT.ACK, req_id:f.req_id, seq:r.seq});
      this.broadcast({t:OUT.BATCH, msgs:r.msgs, cursor:r.msgs.length ? r.msgs[r.msgs.length - 1].seq : 0});
      if(r.state) this.broadcast({t:OUT.STATE, room:r.state});       // ★ 前端一律以后端为准回写
      if(r.nick)  this.broadcast({t:OUT.PRESENCE, members:this.members()});
      return;
    }
  }
  async webSocketClose(ws){
    ws.close(1000, 'bye');
    this.broadcast({t:OUT.PRESENCE, members:this.members()});
  }
  async webSocketError(ws){ this.broadcast({t:OUT.PRESENCE, members:this.members()}); }

  members(){ return this.sql.exec('SELECT anon_id, nick FROM members ORDER BY joined_at').toArray(); }
  send(ws, obj){ try{ ws.send(JSON.stringify(obj)); }catch(e){ /* 连接已断，忽略 */ } }
  broadcast(obj, except){
    const s = JSON.stringify(obj);
    this.ctx.getWebSockets().forEach(ws => { if(ws !== except) try{ ws.send(s); }catch(e){} });
  }

  /* ---------- alarm：30 天清理 + 到期前提醒 ---------- */
  async alarm(){
    const now = Date.now();
    const room = this.sql.exec('SELECT * FROM room WHERE id = 1').toArray()[0];
    if(!room) return;
    const cut = now - KEEP_DAYS * DAY;
    // ① 到期前 7 天广播提醒（★ 静默删历史 = 用户某天打开发现记录没了，必须提前说）
    if(!room.notified_clean && now - room.created_at > WARN_DAYS * DAY){
      const base = await this.storage().allocSeq(1);
      const msg = {seq:base, id:this.code + ':' + base, ts:now, kind:'sys', from:'骰娘', actor:'骰娘',
        anon_id:null, req_id:null, rule_at:room.rule,
        payload:{title:'🧹 房间消息将在 7 天后清理', line1:'本房间消息只保留 30 天',
          line2:'重要战报请先导出（.help 看导出方式，或在顶栏导出按钮）'}};
      await this.storage().insertMsgs([msg]);
      this.sql.exec('UPDATE room SET notified_clean = 1 WHERE id = 1');
      this.broadcast({t:OUT.BATCH, msgs:[msg], cursor:base});
    }
    // ② 日常清理：只 DELETE（★ SQLite 删行不缩磁盘；VACUUM 锁库，只在 500M 全局触发时跑）
    this.sql.exec('DELETE FROM messages WHERE ts < ?', cut);
    this.sql.exec('DELETE FROM idempotency WHERE ts < ?', cut);   // 与消息同窗口，避免 dup 指向已删消息
    this.sql.exec('UPDATE room SET last_active = ? WHERE id = 1', now);
    this.ctx.storage.setAlarm(now + DAY);
  }

  get code(){ return this.ctx.id.name || ''; }
}

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
/* ★ 离线判定（真机反馈 · B 组）：手机息屏后 ws 常常**收不到关闭帧** ——
 *   系统直接掐掉网络，服务端那条连接在自己看来仍是 OPEN（半开连接）。
 *   于是人已经走了、在线数还挂着 1，次数一多就累积成"永远多一个人"。
 * 【做法】每条 ws 在 attachment 上记最后一次收到帧的时间；巡检超过 IDLE_MS 就主动关掉。
 * 【为什么是 3 分钟】前端每 20 秒发一次心跳，留 9 倍余量 —— 弱网重传不会误伤挂机的人。 */
const IDLE_MS  = 3 * 60 * 1000;
const SWEEP_MS = 60 * 1000;        // 巡检间隔：小于 IDLE_MS 太多会白跑，大于会延迟回落
const KEEP_DAYS = 30;          // 房间消息留存
const WARN_DAYS = 23;          // 到期前 7 天提醒（档案：清理动作必须告知，不能静默）

/* ★ schema 的唯一出处是 schema.sql（含注释与理由）；这里是它的运行时副本。
   tools/check-worker.mjs 会比对两者是否一致 —— 不能只在其中一处改。 */
export const TABLES = [
  `CREATE TABLE IF NOT EXISTS room (
     id INTEGER PRIMARY KEY CHECK (id = 1), code TEXT NOT NULL, created_at INTEGER NOT NULL,
     last_active INTEGER NOT NULL, rule TEXT NOT NULL DEFAULT 'generic', baredice INTEGER NOT NULL DEFAULT 0,
     rule_set_by TEXT, rule_set_at INTEGER, pin_hmac TEXT, pin_salt TEXT,
     seq INTEGER NOT NULL DEFAULT 0, notified_clean INTEGER NOT NULL DEFAULT 0, ver INTEGER NOT NULL DEFAULT 1)`,
  /* ★ cid = 客户端长期身份键（2026-10-31 真机反馈 · B 组）
   *   以前每次 /join 都现发一个随机 anon_id —— 关页重进就是"另一个人"，
   *   角色卡、昵称全部丢失。现在客户端在浏览器本地存一个 cid（见 apps/web/src/main.js），
   *   /join 带上它；服务端按 cid 找回同一个 anon_id（卡与昵称跟着回来）。
   *   【为什么 cid 与 anon_id 要分开】anon_id 会写进消息表与导出战报，
   *   是"房间内的稳定标识"；cid 是"这台浏览器"的凭据，不该进消息。 */
  `CREATE TABLE IF NOT EXISTS members (
     anon_id TEXT PRIMARY KEY, cid TEXT, nick TEXT NOT NULL, joined_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL, msg_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS messages (
     seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, kind TEXT NOT NULL,
     from_name TEXT NOT NULL, actor TEXT, anon_id TEXT, req_id TEXT, rule_at TEXT, payload TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS idempotency (req_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pcs (anon_id TEXT PRIMARY KEY, family TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
];

/* ★★ 索引必须**在建表 + 迁移之后**单独建（2026-10-31 线上事故 · 房间 009950 打不开）★★
 * 【事故经过】本次部署给 members 加了 cid 列，并把 `CREATE INDEX ... ON members(cid)`
 *   直接混在 SCHEMA 里。对**已存在的旧房间**：CREATE TABLE IF NOT EXISTS 什么都不做，
 *   cid 列还不存在，于是建索引立刻抛 "no such column: cid" —— DO 构造函数崩
 *   → 任何请求都 500，ws 握手也拿不到 101 → 浏览器报关闭码 1006。
 *   新房间（表是这次一起建的，自带 cid）完全正常，所以自测全绿、只有老房间炸。
 * 【为什么不能只靠 try/catch 把 ALTER 挪前面】顺序本身就是契约：
 *   表 → 迁移补列 → 索引。这里拆成两个数组，让顺序在代码里显式可见。 */
export const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_members_cid ON members(cid)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_req ON messages(req_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(anon_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_idem_ts ON idempotency(ts)`,
];
/** 兼容旧名（tools/check-worker.mjs 与其它引用） */
export const SCHEMA = TABLES.concat(INDEXES);

export class RoomDO extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    TABLES.forEach(s => this.sql.exec(s));
    /* ★ 旧库迁移：CREATE TABLE IF NOT EXISTS 对**已存在**的表什么都不做，
     *   所以已经跑过一轮的房间（里面有真实的卡和消息）不会自动长出 cid 列。
     *   这里补一条 ALTER；SQLite 没有 ADD COLUMN IF NOT EXISTS，
     *   列已存在会抛 "duplicate column name" —— 吞掉即可（幂等靠 try/catch）。
     *   【为什么不重建表】房间里有 30 天的消息与角色卡，重建 = 数据清空。 */
    try{ this.sql.exec('ALTER TABLE members ADD COLUMN cid TEXT'); }catch(e){ /* 列已存在 */ }
    /* ★ 逐条建且不让它炸：索引只是加速，缺了最多变慢；而构造函数抛异常 =
     *   这个房间**彻底打不开**（HTTP 500 + ws 1006，009950 就是这样挂的）。
     *   顺序（ALTER 之后）已经保证了正常路径，这里是最后一道保险。 */
    INDEXES.forEach(s => { try{ this.sql.exec(s); }catch(e){ /* 索引缺失只影响性能，不致命 */ } });
    /* ★ 在线人数 = **当前活跃 ws 连接数**（用户已定口径）。
     * 【为什么不查 members 表的 last_seen】那是累计接入人次，永不减少 ——
     *   一个人反复刷新/重连就一路累加（真机：3 人的房间显示 13 人）。
     *   ws 连接数断线即减，且 DO 的 getWebSockets() 是权威事实（休眠恢复后也在）。 */
    this.core = createRoomCore(this.storage(), {
      now: () => Date.now(),
      online: () => this.onlineCount(),
      memberCount: () => this.memberCount(),
    });
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
      async delCard(a){ sql.exec('DELETE FROM pcs WHERE anon_id = ?', a); },
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
      /* ★ 现存量 COUNT(*)，不是 room.seq —— seq 删后不回退，30 天清理后会让 .status 的
       *   「本房间共 N 条」一直虚高。idx_messages_ts 只是清理用的，COUNT 走主键全表扫，
       *   单房间最多几百条，成本可忽略。 */
      async countMsgs(){ return one('SELECT COUNT(*) AS c FROM messages').c; },
      async since(cursor, limit){
        return q('SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?', cursor, limit).map(row2msg);
      },
      /* ★ 最近 N 条（首屏用）：ORDER BY seq DESC 再反转 —— 取的是"尾巴"不是"开头" */
      async recent(limit){
        return q('SELECT * FROM messages ORDER BY seq DESC LIMIT ?', limit || 200)
          .reverse().map(row2msg);
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
      const body = await req.json();
      const {nick, pin} = body;
      const room = this.sql.exec('SELECT * FROM room WHERE id = 1').toArray()[0];
      if(!room) return Response.json({error:'no_room'}, {status:404});
      if(room.pin_hmac){
        const v = await verifyPin(String(pin || ''), room.pin_salt, room.pin_hmac, this.env.PIN_SECRET);
        if(!v.ok) return Response.json({error:'bad_pin'}, {status:401});
      }
      /* ★ 按 cid 找回老身份（真机反馈 · B 组）：关页重进本来会现发一个新的 anon_id，
       *   于是卡、昵称全丢 —— 玩家以为"绑定了却读不出来"。
       *   【PIN 房间的口径不变】cid 只在本机，PIN 校验在这之前已经过了：
       *   不知道 PIN 的人就算拿到 cid 也进不来；进得来才谈得上恢复身份。
       *   【换设备 / 换浏览器】没有 cid（或 cid 没记录过）→ 正常发新身份，符合无账号体系。 */
      let cid = typeof body.cid === 'string' ? body.cid.trim().slice(0, 64) : '';
      if(cid && !/^[A-Za-z0-9_-]{8,64}$/.test(cid)) cid = '';      // 不合法就当没有，不报错（保守）
      let anonId = null;
      /* ★ 找回身份失败**不能**让进房失败：老房间可能因为迁移没跑到而缺 cid 列，
       *   那时这条 SELECT 会抛 —— 后果是房间彻底进不去（500）。
       *   退化成"发新身份"最多是这次没找回卡，远好于进不去房间。 */
      try{
        if(cid){
          const old = this.sql.exec('SELECT anon_id FROM members WHERE cid = ?', cid).toArray()[0];
          if(old) anonId = old.anon_id;                            // ★ 同一个 cid 一定是同一个人
        }
      }catch(e){ anonId = null; }
      if(!anonId){
        anonId = crypto.randomUUID();
        this.sql.exec('INSERT OR IGNORE INTO members (anon_id, cid, nick, joined_at, last_seen, msg_count) VALUES (?, ?, ?, ?, ?, 0)',
          anonId, cid || null, String(nick || '玩家').slice(0, 16), now, now);
      }
      // 老身份回来时补写 cid（迁移前建的行没有 cid），并刷新 last_seen
      // ★ SQL 里用双引号写空串：单引号会把 JS 字符串截断（打包时才发现，代价太大）
      /* ★ 空串一律走**绑定参数**：SQLite 里 "" 是"双引号字符串"，
       *   某些构建（DQS 关闭）会把它当**标识符**解析 → "no such column" → 整条 UPDATE 抛错。
       *   写 '""' 字面量也不行：单引号会把 JS 字符串截断（这个我踩过，打包时才暴露）。 */
      try{
        if(cid) this.sql.exec('UPDATE members SET cid = ?, last_seen = ? WHERE anon_id = ? AND (cid IS NULL OR cid = ?)', cid, now, anonId, '');
        this.sql.exec('UPDATE members SET last_seen = ? WHERE anon_id = ?', now, anonId);
      }catch(e){ /* 同上：记账失败不阻断进房 */ }
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

    // ★ 兼容两种形式：`/ws`（内部直呼，便于测试）与 `/ws/123456`（Worker 透传原始 request 时的真实路径）
    if(url.pathname === '/ws' || /^\/ws\/\d{6}$/.test(url.pathname)){
      const v = await verifyToken(url.searchParams.get('token'), this.env.PIN_SECRET);
      if(!v.ok) return new Response('bad token', {status:401});
      if(v.payload.code !== this.code) return new Response('token 与房间不符', {status:401});
      /* ★★ 这一行就是"ws 关闭码 1006"的根因（2026-10-30 实测确认）★★
         `new WebSocketPair()` 返回的是**下标 0 / 1 两个槽位**的对象，
         **没有** `.server` / `.client` 这两个属性 —— 所以 `pair.server` 是 undefined，
         acceptWebSocket(undefined) 直接抛
           "parameter 1 is not of type 'WebSocket'"
         → DO 回 500 → 浏览器期待 101 却收到 500 → 关闭码 1006。
         官方写法是 Object.values() 取（两个槽位顺序不保证，不能用下标硬编码语义）。 */
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      // ★ 身份只存 attachment：DO 休眠唤醒后内存态丢失，attachment 会被恢复
      server.serializeAttachment({anon_id:v.payload.anon_id, ts:Date.now()});
      /* ★ 有人连上就把巡检闹钟排上：不排的话 alarm 永远不响，半开连接没人清理。
       *   闹钟本来也负责每日清理，这里只是把它提前到 1 分钟后 —— 人走光后会自动退回 DAY。 */
      /* ★★ 握手路径上的**附属操作一律不能抛** ★★
       *   这里一旦抛异常，DO 返回 500 而不是 101 → 浏览器拿到关闭码 1006，
       *   而用户看到的只是"连不上"，完全看不出是"服务端升级时顺手做的记录"失败了。
       *   排闹钟、更新 last_seen / last_active 都只是记账，丢一次无所谓；
       *   真正的准入校验（token / 房间号）在上面，绝不能包进 try。 */
      try{
        this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
        this.sql.exec('UPDATE members SET last_seen = ? WHERE anon_id = ?', Date.now(), v.payload.anon_id);
        this.sql.exec('UPDATE room SET last_active = ? WHERE id = 1', Date.now());
      }catch(e){ /* 记账失败不影响进房 */ }
      return new Response(null, {status:101, webSocket:client});
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
    /* ★ 任何帧都算"还活着"（心跳 ping 也是帧）—— 刷新 ts，避免被巡检误判离线 */
    ws.serializeAttachment(Object.assign({}, att, {ts:Date.now()}));

    if(f.t === IN.HELLO){
      const room = await this.storage().getRoom();
      const me = this.sql.exec('SELECT nick FROM members WHERE anon_id = ?', anonId).toArray()[0] || {};
      const mem = this.members();
      this.send(ws, {t:OUT.WELCOME, you:{anon_id:anonId, nick:f.nick || me.nick || '玩家'},
        room:{rule:room.rule, baredice:!!room.baredice, seq:room.seq, msg_count:await this.storage().countMsgs()},
        server_time:Date.now(), members:mem,
        online:this.onlineCount(), total:mem.length});
      /* ★ 首屏 vs 补齐（真机反馈 · C 组）
       *   cursor = 0（刷新 / 新进）→ 要**最近** 200 条：跑团看的是"刚才发生了什么"。
       *     走 since(0) 会拿到最早 200 条，房间一长就再也看不到新消息。
       *   cursor > 0（重连）→ 仍然只补它之后的（幂等 + 不重复），这是重连的既定语义。 */
      const fresh = !f.cursor;
      const r = fresh ? await this.core.recent(200) : await this.core.since(f.cursor, 200);
      if(r.msgs.length){
        /* ★ why 必须显式带：靠"oldest 是否小于 cursor"去猜是分不出来的 ——
         *   首屏那批本身就是 200 条连续段，oldest 当然小于末尾，会被误判成"上翻的历史"，
         *   于是首屏不推进 cursor，重连就永远补不齐（这类 bug 只能靠显式标记避免）。 */
        this.send(ws, {t:OUT.BATCH, why:'first', msgs:r.msgs, cursor:r.cursor, has_more:r.has_more,
          /* ★ 首屏多带两个字段：前端要靠它们决定"能不能往上翻"
           *   oldest = 当前这批里最小 seq（上翻的锚点）；total = 房间里总共有多少条 */
          oldest:r.msgs[0].seq, total:(typeof r.total === 'number' ? r.total : null)});
      }else{
        // 空房间也要给 total，否则前端不知道"确实没有更早的"还是"还没拿到"
        this.send(ws, {t:OUT.BATCH, why:'first', msgs:[], cursor:0, has_more:false, oldest:null,
          total:fresh ? await this.storage().countMsgs() : null});
      }
      return this.broadcast(this.presenceFrame(), ws);
    }

    if(f.t === IN.PING){ return this.send(ws, {t:OUT.PONG, ts:f.ts}); }
    if(f.t === IN.SYNC){
      const r = await this.core.since(f.cursor || 0, f.limit || 200);
      return this.send(ws, {t:OUT.BATCH, msgs:r.msgs, cursor:r.cursor, has_more:r.has_more});
    }
    if(f.t === IN.HISTORY){
      const r = await this.core.history(f.before_seq, f.limit || 200);
      /* ★ 上翻也要带 oldest / has_more：前端靠 oldest 决定下一页的锚点，
       *   靠 has_more 决定"还能不能再往上翻"（没有的话会一直发请求，翻到底也不停）。
       *   【has_more 的算法】取满一页才说明可能还有更早的；不足一页即到顶。 */
      const oldest = r.msgs.length ? r.msgs[0].seq : null;
      return this.send(ws, {t:OUT.BATCH, why:'page', msgs:r.msgs, cursor:r.cursor,
        has_more:r.msgs.length >= (f.limit || 200), oldest});
    }

    if(f.t === IN.CMD || f.t === IN.CHAT){
      const nickRow = this.sql.exec('SELECT nick FROM members WHERE anon_id = ?', anonId).toArray()[0] || {};
      const r = await this.core.apply({reqId:f.req_id, text:f.text, anonId, nick:nickRow.nick || '玩家'});
      if(r.reject) return this.send(ws, {t:OUT.REJECT, req_id:f.req_id, code:r.reject.code});
      if(r.dup)    return this.send(ws, {t:OUT.DUP, req_id:f.req_id, seq:r.seq, deleted:!!r.deleted});
      this.send(ws, {t:OUT.ACK, req_id:f.req_id, seq:r.seq});
      this.broadcast({t:OUT.BATCH, msgs:r.msgs, cursor:r.msgs.length ? r.msgs[r.msgs.length - 1].seq : 0});
      if(r.state) this.broadcast({t:OUT.STATE, room:r.state});       // ★ 前端一律以后端为准回写
      if(r.nick)  this.broadcast(this.presenceFrame());
      return;
    }
  }
  async webSocketClose(ws){
    ws.close(1000, 'bye');
    this.broadcast(this.presenceFrame());
  }
  async webSocketError(ws){ this.broadcast(this.presenceFrame()); }

  /* ★ 巡检：把"半开连接"关掉 —— 息屏 / 切后台 / 断网的对端不会发关闭帧，
   *   服务端这边 readyState 一直是 1，只能靠"多久没收到帧"来判定。
   *   【为什么不能只靠 readyState】实测：对端断开后 getWebSockets() 仍返回它且 readyState=1。 */
  sweepIdle(){
    const now = Date.now();
    const all = this.ctx.getWebSockets();
    const stale = all.filter(ws => {
      const att = ws.deserializeAttachment() || {};
      const last = att.ts || 0;
      return !!last && now - last > IDLE_MS;
    });
    stale.forEach(ws => { try{ ws.close(4000, 'idle'); }catch(e){ /* 已断 */ } });
    if(!stale.length) return 0;
    /* ★ 存活数必须**自己算**，不能靠 onlineCount()：
     *   实测（workerd 真跑）ws.close() 之后 readyState 不会立刻翻转（关闭是异步的），
     *   此时 onlineCount() 仍返回包括刚关掉那些在内的数字 —— 广播出去的人数还是虚高的。
     *   "总连接数 − 这次关掉的数" 是确定值，不依赖运行时什么时候真正关掉。 */
    const mem = this.members();
    this.broadcast({t:OUT.PRESENCE, members:mem, online:all.length - stale.length, total:mem.length});
    return stale.length;
  }

  members(){ return this.sql.exec('SELECT anon_id, nick FROM members ORDER BY joined_at').toArray(); }
  memberCount(){ return this.sql.exec('SELECT COUNT(*) AS c FROM members').toArray()[0].c; }
  /* ★ 在线 = **真正处于 OPEN 的连接数**，不是 getWebSockets().length。
   * 【为什么必须过滤】实测（workerd 真跑）：对端断开后，webSocketClose 里读到的
   *   getWebSockets() **仍包含那条已关闭的连接** —— 直接用 length 会让在线数只增不减，
   *   正是"人数虚高"的老毛病的另一种形态（这次换成了 ws 连接却还是不减）。
   *   readyState：1 = OPEN；2/3 是正在关 / 已关，都不算在场。 */
  onlineCount(){ return this.ctx.getWebSockets().filter(s => s.readyState === 1).length; }
  /** presence 帧：members（名单）+ online（ws 连接数）+ total（累计人次）—— 一个数都不要省 */
  presenceFrame(){
    const mem = this.members();
    return {t:OUT.PRESENCE, members:mem, online:this.onlineCount(), total:mem.length};
  }
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
    // ③ 顺带巡检在线连接；有人在就一分钟后继续巡，没人就退回每日清理
    this.sweepIdle();
    this.ctx.storage.setAlarm(this.onlineCount() > 0 ? now + SWEEP_MS : now + DAY);
  }

  get code(){ return this.ctx.id.name || ''; }
}

/* ============================================================================
 * schema.sql —— 房间 Durable Object 的 SQLite schema（**唯一出处**）
 * ----------------------------------------------------------------------------
 * 【怎么用】DO 构造时 ctx.storage.sql.exec(SCHEMA)（每个房间一个 DO，只管自己）
 * 【★ 三个关键决定】
 *   ① 游标用 seq（DO 单线程自增整数，严格单调且删除后不重用），
 *      ts 只用于展示与 30 天清理 —— 时钟会回拨、同一毫秒会撞，不能当游标
 *   ② 消息单表扩展，不建 rolls 副表（去重/分页/索引/导出四条链路零改动）
 *   ③ 角色卡 data 存自由 JSON，由卡自己的族解释（四套卡模型差异大，不强统一）
 * 【接口对齐】apps/worker/src/room.js 用本 schema 实现 core.js 需要的 storage 接口；
 *   tests/memory_storage.js 是同接口的内存替身（用于沙盒内验证纯逻辑）
 * ========================================================================== */

PRAGMA journal_mode = WAL;

-- ★ 旧库迁移（room.js 构造时执行，幂等）：
--   ALTER TABLE members ADD COLUMN cid TEXT;   -- 已存在的表不会被 CREATE TABLE IF NOT EXISTS 改到
--   CREATE INDEX IF NOT EXISTS idx_members_cid ON members(cid);

-- 房间元信息（单行：一个 DO = 一个房间，不需要多表 JOIN）
CREATE TABLE IF NOT EXISTS room (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  code         TEXT    NOT NULL,           -- 6 位数字房间号
  created_at   INTEGER NOT NULL,           -- 惰性撞号检测读它（不存在或已过期即占用成功）
  last_active  INTEGER NOT NULL,           -- 500M 全局清理的排序键
  rule         TEXT    NOT NULL DEFAULT 'generic',
  baredice     INTEGER NOT NULL DEFAULT 0,
  rule_set_by  TEXT,
  rule_set_at  INTEGER,
  pin_hmac     TEXT,                       -- NULL = 开放式房间；★ 只存摘要，不存明文
  pin_salt     TEXT,
  seq          INTEGER NOT NULL DEFAULT 0, -- 已分配到的最大 seq（冷启动时用 MAX(messages.seq) 校准）
  ver          INTEGER NOT NULL DEFAULT 1  -- schema 版本，便于迁移
);

-- 成员（房间内作用域；anon_id 由服务端签发）
CREATE TABLE IF NOT EXISTS members (
  anon_id     TEXT PRIMARY KEY,
  cid         TEXT,                       -- 客户端长期身份键（localStorage）；服务端按它找回同一个 anon_id
  nick        TEXT NOT NULL,
  joined_at   INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  msg_count   INTEGER NOT NULL DEFAULT 0
);

-- 消息（单表扩展）
CREATE TABLE IF NOT EXISTS messages (
  seq       INTEGER PRIMARY KEY,           -- ★ 房间内单调游标（不因删除而重用）
  id        TEXT    NOT NULL UNIQUE,       -- msg_id = 'code:seq'
  ts        INTEGER NOT NULL,              -- ★ 服务端时间（客户端时间不可信）
  kind      TEXT    NOT NULL,              -- cmd|chat|roll|html|notice|sys
  from_name TEXT    NOT NULL,              -- '骰娘' 或昵称
  actor     TEXT,                          -- 动作发起人（多人时知道这颗骰是谁掷的）
  anon_id   TEXT,                          -- NULL = 骰娘
  req_id    TEXT,                          -- 客户端幂等键
  rule_at   TEXT,                          -- ★ 事实快照：掷骰/判定当时的规则
  keep_until INTEGER,                      -- ★ 续期截止：NULL = 按 ts 走 30 天常规清理
  payload   TEXT    NOT NULL               -- JSON，只存事实（派生值一律不落库）
);
/* ★ keep_until 为什么不直接改 ts：ts 是**发生时间**，是排序键也是内容的一部分。
 *   把续期写进 ts 会让老消息假装是刚发生的 —— 排序错位（它会被排到今天的消息里），
 *   且战报里的时间全错。续期只影响"什么时候可以被清理"，就单独存一个字段。 */
CREATE INDEX IF NOT EXISTS idx_messages_keep  ON messages(keep_until);   -- 清理：ts 与 keep_until 双条件
CREATE INDEX IF NOT EXISTS idx_messages_ts    ON messages(ts);           -- 30 天清理
CREATE INDEX IF NOT EXISTS idx_messages_req    ON messages(req_id);      -- 幂等回查
-- ★ idx_sender：v1 就建。导出筛选（v2）要用，而**补索引属于 schema 迁移**，现在建边际成本≈0
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(anon_id, seq);

-- 幂等（★ 防重掷：同一条指令只执行一次）
CREATE TABLE IF NOT EXISTS idempotency (
  req_id TEXT PRIMARY KEY,
  seq    INTEGER NOT NULL,                 -- 首次产出消息的首条 seq（dup 时回这个）
  ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idem_ts ON idempotency(ts);   -- 与消息同窗口清理，避免 dup 指向已删消息

-- 角色卡（房间内作用域）
CREATE TABLE IF NOT EXISTS pcs (
  anon_id    TEXT PRIMARY KEY,
  family     TEXT NOT NULL,                -- 'dnd' | 'coc7' | 'dh' | 'fu'
  version    INTEGER NOT NULL DEFAULT 1,
  data       TEXT NOT NULL,                -- JSON，由 family 对应的规则包解释
  updated_at INTEGER NOT NULL
);

-- 说明：无 visibility 列 —— 全员同权限、无暗骰，广播/历史/导出/导入四处过滤逻辑全部消失。

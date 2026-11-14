/* ============================================================================
 * lifecycle.js —— 房间生命周期的**纯逻辑 + SQL 单一源**（零 Cloudflare 依赖）
 * ----------------------------------------------------------------------------
 * 【为什么单独抽一份】还原 / 提醒 / alarm 排程是 S2 最容易「测试全绿、线上全错」的一段：
 *   DO 里的逻辑只能部署后验，而沙盒部署不了。把决策与 SQL 放在这里，room.js 的 alarm()
 *   只剩 IO 适配，tests/test_schema.mjs 用 sql.js 真跑**同一个 runLifecycle()**。
 *   生产与测试共用一份决策、一份 SQL，不允许测试里再抄一遍顺序（坑 #18）。
 *
 * 【口径来源】v10 §0.4 跨阶段前置约束 / 附录 G·8.1–8.5 / 附录 I·0.2 L1–L7。
 *   ★ 计时主体 = messages（全 kind，含用户动作 notice 留痕）+ idempotency；
 *     单条到期 = keep_until IS NULL ? ts + 30d : keep_until（idempotency 无续期列）。
 *   ★ 辅助表（members / pcs / combat / combat_entry）**不参与计时**，只在归零那一次清。
 *   ★ reset_at = max(计时主体每条的到期时刻)，**只由用户动作刷新，alarm 绝不写**。
 *   ★ 归零 = 某次滚动 DELETE 后计时主体「由非空变空」，同一次 alarm 里静默还原。
 *   ★ last_reset_at 由 RESET_SQL 用库时间写入（零参数单一源），io.reset() 不穿过 now。
 *
 * 【★ D1 用量根治（2026-11-14）】alarm 链由「在线即 60s 自续」改为**按日 lifecycle**：
 *   半开连接巡检移到 room.js 的 ws 帧路径（webSocketMessage → sweepIdleThrottled），
 *   零 alarm / 零全表 SQL；本文件每轮只跑一次滚动清理＋归零判据，且不再写 last_active、
 *   不再算 SQL_MIN_EXPIRY 表达式全表聚合。用户动作路径判「有没有内容」改 SQL_HAS_CONTENT。
 * ========================================================================== */
import {OUT} from '../../../packages/protocol/src/frames.js';

export const DAY      = 86400000;
export const KEEP_MS  = 30 * DAY;
export const WARN_MS  = 7 * DAY;      // 到期前 7 天提醒（口径 6：提醒不能是消息）
/* ★ D1（2026-11-14 · DO rows_read 用量根治）：生命周期（提醒 / 滚动清理 / 归零）
 *   改为**按日**跑。旧形态「online>0 → now+SWEEP_MS(60s)」让挂着 ws 的房间
 *   每天自续 1440 次，每轮还跑 COUNT(*)×2 ＋ MIN(CASE…) 表达式全表聚合×2 表，
 *   ≈4~8 次表级全量遍历 / 60s，账户级 5,000,000 rows_read/日 免费额度被两个
 *   只挂着不用的房间吃光（2026-11-13 20:57 UTC 到 90%、22:57 UTC 超限）。
 *   用户口径：不升级付费；过时清理按日已足够，根本不需要高频遍历。 */
export const LIFECYCLE_MS = DAY;     // ★ 按日（用户 2026-11-14 定）
export const SWEEP_MS = 60 * 1000;   // ★ D1 起只作「ws 帧驱动巡检」的内存节流，不再用于排 alarm

export const WARN_TEXT = '本房间内容将重置，重要战报请先导出';

/* ---------- 计时主体：只读这两张表（C1） ---------- */
/** 单条消息到期时刻；idempotency 无 keep_until，恒为 ts + 30d */
export const expiryOf     = (ts, keepUntil) => keepUntil == null ? Number(ts) + KEEP_MS : Number(keepUntil);
export const idemExpiryOf = ts => Number(ts) + KEEP_MS;

/** 滚动清理：与 S1 逐字一致的 DELETE（逐条到期，**不碰任何辅助表**，C4 / L7） */
export const SQL_SWEEP_MSGS = 'DELETE FROM messages WHERE ts < ? AND (keep_until IS NULL OR keep_until <= ?)';
export const SQL_SWEEP_IDEM = 'DELETE FROM idempotency WHERE ts < ?';

/** 「是否仍有可清除信息」唯一判据：只读计时主体，不读 last_active / 辅助表（C1 / 坑 5） */
export const SQL_COUNT_CONTENT =
  'SELECT (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM idempotency) AS c';

/** ★ D1：用户动作路径判「有没有内容」——O(1) 存在性，替代 COUNT(*) 全表扫描。
 *  归零判据「由非空变空」仍用 SQL_COUNT_CONTENT，但只在每日一次 lifecycle 里跑。 */
export const SQL_HAS_CONTENT =
  'SELECT (SELECT 1 FROM messages LIMIT 1) IS NOT NULL OR (SELECT 1 FROM idempotency LIMIT 1) IS NOT NULL AS c';

/** reset_at = max(到期)；只由用户动作路径调用（发指令 / 导出 / 导入） */
export const SQL_MAX_EXPIRY =
  `SELECT MAX(e) AS e FROM (` +
  `SELECT MAX(CASE WHEN keep_until IS NULL THEN ts + ${KEEP_MS} ELSE keep_until END) AS e FROM messages ` +
  `UNION ALL SELECT MAX(ts + ${KEEP_MS}) AS e FROM idempotency)`;
/** 下一条到期时刻：alarm 排程用（同样只读计时主体） */
export const SQL_MIN_EXPIRY =
  `SELECT MIN(e) AS e FROM (` +
  `SELECT MIN(CASE WHEN keep_until IS NULL THEN ts + ${KEEP_MS} ELSE keep_until END) AS e FROM messages ` +
  `UNION ALL SELECT MIN(ts + ${KEEP_MS}) AS e FROM idempotency)`;

/* ---------- 归零：同一次 alarm 里静默清表（E5 / C2 / C3 / B1–B3） ---------- */
/** ★ 顺序是契约：先 combat_entry 后 combat，避免 cursor_entry_id 悬空（C2 / I·3.8.3）。
 *  墓碑一律不动：room 行 / code / created_at / seq / pin_hmac / pin_salt（B1 / 口径 1 / §0.5 第 13 条）。
 *  B2 写回默认、B3 清 members 即累计人次归零、锚点置空 —— 全程零消息、零 seq、零续期。 */
export const RESET_SQL = [
  'DELETE FROM combat_entry',
  'DELETE FROM combat',
  'DELETE FROM pcs',
  'DELETE FROM members',
  `UPDATE room SET rule = 'generic', baredice = 0, rule_set_by = NULL, rule_set_at = NULL, ` +
    `notified_clean = 0, reset_at = NULL, warned_for_reset_at = NULL, ` +
    `last_reset_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE id = 1`,
];

/* ---------- 纯决策 ---------- */
/** 提前 7 天提醒：按 reset_at − 7d 判，每轮（reset_at 变了）可再触发（坑 3） */
export const shouldWarn = ({now, resetAt, warnedForResetAt}) =>
  resetAt != null && Number(now) >= Number(resetAt) - WARN_MS && Number(now) < Number(resetAt) &&
  warnedForResetAt !== resetAt;

/** 归零判据：滚动 DELETE 后由非空变空（口径 5 / L2） */
export const shouldReset = ({hadContent, remaining}) => !!hadContent && Number(remaining) === 0;

/** ★ D1 唯一闹钟时刻：min(按日 lifecycle, reset_at−7d, reset_at)。
 *  · 不再吃 online / nextExpiry：半开连接巡检改由 ws 帧驱动（零 alarm / 零 SQL），
 *    过时清理按日跑已足够，不需要精确到「下一条到期」的时刻（用户 2026-11-14 定）。
 *  · 两者皆无（无内容 / reset_at 已过或空）→ null = 不排新闹钟（口径 8 / L6）。
 *  ★ 只排「还没到」的候选：过去时刻不能 clamp 成 now+1s —— 那会让已进入提醒窗口 /
 *    内容刚清完的房间每秒重排一次闹钟，空房间永远停不下来（口径 8）。 */
export function nextAlarmAt({now, resetAt, hasContent}){
  const at = [];
  if(hasContent) at.push(Number(now) + LIFECYCLE_MS);
  if(resetAt != null && Number(resetAt) > Number(now)){
    const warnAt = Number(resetAt) - WARN_MS;
    if(warnAt > Number(now)) at.push(warnAt);   // 还没进 7 天窗口才排「提醒」这一跳
    at.push(Number(resetAt));                   // 排到 reset_at 只为保证那次 DELETE 一定发生
  }
  return at.length ? Math.min(...at) : null;
}

/* ---------- 瞬时帧（不落库、不占 seq、不续活；G·8.4 ② / C3） ---------- */
/** 提前 7 天提醒：复用 STATE 帧带锚点字段，不新增帧类型 / 不新增消息 kind（E1 / E2 / I·3.9-15）。
 *  P2 起前端 setRoom 读 reset_at / warn / warn_text / last_reset_at / server_now 呈现横幅。 */
export const warnFrame = room => ({
  t:OUT.STATE,
  room:{rule:room.rule || 'generic', baredice:!!room.baredice,
    reset_at:room.reset_at ?? null, warn:true, warn_text:WARN_TEXT},
});
/** 重置那一刻：RELOAD 清列表 + STATE 刷回默认顶栏 + PRESENCE 人数归零（全是旧帧） */
export const resetFrames = ({code, online, lastResetAt}) => [
  {t:OUT.RELOAD, code, reset:true},
  /* ★ P2：带 last_reset_at / server_now，在线的人也能看到「本房间已于 X 重置」；
     横幅消失（warn:false + reset_at:null），全程瞬时帧、零落库消息。 */
  {t:OUT.STATE, room:{rule:'generic', baredice:false, reset_at:null,
    last_reset_at:lastResetAt ?? null, warn:false, server_now:Date.now()}},
  {t:OUT.PRESENCE, members:[], online:Number(online) || 0, total:0},
];

/* ---------------------------------------------------------------------------
 * runLifecycle —— alarm 的**唯一决策入口**（生产与真跑测试共用一个函数）
 *   db: {q(sql, ...args) → 行对象数组, run(sql, ...args) → void}
 *   io: {broadcast(frame), reset(), rearm(at)}
 *     · reset() 由 room.js 的 resetRoom() 提供：执行 RESET_SQL + 发 resetFrames
 *     · rearm(at) 由 room.js 提供：getAlarm() 判重、只在需要提前时覆盖（L6）
 *     · ★ D1：sweepIdle / onlineCount 仍可在替身里给，但 alarm 链**不再调用**
 *       （巡检由 ws 帧驱动；在线数只在 presenceFrame / resetRoom 里直接读）
 *   ★ 重置分支直接 return：不排下一轮闹钟、不写 last_active（L3 / 口径 8）。
 * ------------------------------------------------------------------------- */
export async function runLifecycle(db, io, now){
  const q = db.q, run = db.run;
  const room = q('SELECT * FROM room WHERE id = 1')[0];
  if(!room) return {skipped:'no_room'};

  const hadContent = Number(q(SQL_COUNT_CONTENT)[0].c) > 0;

  /* ① 提前 7 天提醒：瞬时帧、零消息、零 seq（口径 6 / 坑 2 / C3） */
  const warned = shouldWarn({now, resetAt:room.reset_at, warnedForResetAt:room.warned_for_reset_at});
  if(warned){
    io.broadcast(warnFrame(room));
    run('UPDATE room SET warned_for_reset_at = ? WHERE id = 1', room.reset_at);
  }

  /* ② 逐条滚动 DELETE：只动计时主体两表（C4 / L7） */
  const cut = Number(now) - KEEP_MS;
  run(SQL_SWEEP_MSGS, cut, now);
  run(SQL_SWEEP_IDEM, cut);

  /* ③ 由非空变空 → 同一次 alarm 里静默还原（口径 5 / 9 / L2 / C1） */
  const remaining = Number(q(SQL_COUNT_CONTENT)[0].c);
  if(shouldReset({hadContent, remaining})){
    await io.reset();
    return {reset:true, warned, armAt:null};
  }

  /* ④ 常规：按日续排（空容器自然不排，口径 8）。
     ★ D1：巡检由 ws 帧驱动（webSocketMessage → sweepIdleThrottled），alarm 链不再
       调 io.sweepIdle()；不再每轮写 last_active（坑 5 同型）；不再算 SQL_MIN_EXPIRY
       表达式全表聚合（按日清理已足够）。这一轮只剩 1 次 rearm。 */
  const armAt = nextAlarmAt({now, resetAt:room.reset_at, hasContent:remaining > 0});
  await io.rearm(armAt);
  return {reset:false, warned, armAt};
}

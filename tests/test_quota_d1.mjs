/* ============================================================================
 * test_quota_d1.mjs —— S2-BC 模块 C 后 · D1 用量根治验收（2026-11-14）
 * ----------------------------------------------------------------------------
 * 【事件】Cloudflare DO 免费套餐 5,000,000 rows_read/日 在「无任何用户主动使用」
 *   下 21h 到 90%、23h 超限。根因：前端 20s 心跳 → onlineCount()>0 →
 *   nextAlarmAt() 每 60s 排一次 → rearm() 自续；每轮 runLifecycle() 无条件跑
 *   COUNT(*)×2、MIN(CASE…) 表达式全表聚合×2 表、滚动 DELETE×2、写 last_active。
 *   ≈4~8 次表级全量遍历 / 60s / 房间，账户级额度被两个挂着的房间吃光。
 *
 * 【D1 口径（用户 2026-11-14 定）】
 *   · 不升级付费方案（项目前提是免费方案）；
 *   · 过时消息清理**按日**跑已足够，根本不需要高频遍历；
 *   · 巡检周期显著不合理 → 半开连接巡检改由 **ws 帧驱动**（零 alarm / 零 SQL），
 *     lifecycle 链只按日跑；
 *   · 用户动作路径的「有没有内容」改用 O(1) 存在性查询，不再 COUNT(*) 全表。
 *
 * 【本文件守什么】静态锁（旧形态回退即红）＋ 纯决策 ＋ sql.js 真跑，
 *   全部读生产同一份 lifecycle.js / room.js，不抄一份决策顺序（坑 #18）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {
  LIFECYCLE_MS, SWEEP_MS, KEEP_MS, WARN_MS, DAY,
  SQL_HAS_CONTENT, SQL_COUNT_CONTENT, SQL_MIN_EXPIRY, SQL_MAX_EXPIRY,
  SQL_SWEEP_MSGS, SQL_SWEEP_IDEM, nextAlarmAt, runLifecycle, RESET_SQL,
} from '../apps/worker/src/lifecycle.js';
const initSqlJs = createRequire(import.meta.url)('sql.js');   // sql.js 只有 CJS 入口

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const life = read('apps/worker/src/lifecycle.js');
const room = read('apps/worker/src/room.js');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const lifeCode = strip(life);
const roomCode = strip(room);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if(cond){ pass++; }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
};
const eq = (name, got, want) => ok(name, Object.is(got, want), 'got=' + String(got) + ' want=' + String(want));

const now = 1772000000000;
const body = (src, brace) => {
  let d = 0, j = brace;
  for(; j < src.length; j++){ if(src[j] === '{') d++; else if(src[j] === '}'){ d--; if(!d){ j++; break; } } }
  return src.slice(brace, j);
};
const block = (src, name) => {
  const m = new RegExp('(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'g').exec(src);
  if(!m) return '';
  /* ★ 解构参数里也有 '{'（如 ({now, online})），不能从 m.index 往后找第一个 '{'：
     正则匹配的最后一个字符就是函数体 '{'，直接取末尾才不会切错。 */
  return body(src, m.index + m[0].length - 1);
};
/* ★ 静态锁一律扫「剥离注释后」的源码：D1 的说明注释里会提到旧形态符号
   （io.sweepIdle / SQL_MIN_EXPIRY / online 等），不剥离会把注释判成违规。 */
const nextBody = block(lifeCode, 'nextAlarmAt');
const runBody  = block(lifeCode, 'runLifecycle');
const armBody  = (() => {
  const m = /async armFromUserAction\(\)\s*\{/.exec(roomCode);
  return m ? body(roomCode, m.index + m[0].length - 1) : '';
})();

console.log('== D1 · ① 周期常量（按日 / 不再 60s 排 alarm）==');
{
  eq('★ D1 LIFECYCLE_MS = 1 天（过时清理按日足够）', LIFECYCLE_MS, DAY);
  eq('★ D1 DAY = 86400000', DAY, 86400000);
  ok('★ D1 周期比旧巡检间隔放大 ≥1440 倍（1440 次/天 → 1 次/天）',
    LIFECYCLE_MS / SWEEP_MS >= 1440, String(LIFECYCLE_MS / SWEEP_MS));
  ok('★ D1 lifecycle.js 定义 LIFECYCLE_MS 且注释说明按日',
    /export const LIFECYCLE_MS\s*=\s*DAY/.test(lifeCode));
  ok('★ D1 SWEEP_MS 保留但只作 ws 帧驱动巡检的内存节流（不再排 alarm）',
    /export const SWEEP_MS/.test(lifeCode) && !/\+ SWEEP_MS/.test(nextBody));
  ok('★ D1 探针：把 60s 巡检候选放回 nextAlarmAt 即被抓（自证）',
    /\+ SWEEP_MS/.test('export function nextAlarmAt({now,online}){ return Number(now) + SWEEP_MS; }'));
}

console.log('== D1 · ② nextAlarmAt 不再吃 online / nextExpiry（在线不排短周期）==');
{
  eq('★ D1 空容器不排（at=null → rearm 停排）',
    nextAlarmAt({now, resetAt:null, hasContent:false}), null);
  eq('★ D1 在线但无内容 → 仍然不排（旧形态这里会排 now+60s）',
    nextAlarmAt({now, online:3, resetAt:null, hasContent:false}), null);
  eq('★ D1 在线且有内容 → 按日，不吃 online',
    nextAlarmAt({now, online:3, resetAt:null, hasContent:true}), now + LIFECYCLE_MS);
  eq('★ D1 无在线但有内容 → 同样按日',
    nextAlarmAt({now, online:0, resetAt:null, hasContent:true}), now + LIFECYCLE_MS);
  eq('★ D1 已有 nextExpiry 传进来也不改变按日结论（按日足够）',
    nextAlarmAt({now, online:1, nextExpiry:now + 10 * DAY, resetAt:null, hasContent:true}), now + LIFECYCLE_MS);
  eq('★ D1 提醒窗口未到且无内容 → 排 warnAt（精确时刻零成本保留）',
    nextAlarmAt({now, resetAt:now + 10 * DAY, hasContent:false}), now + 10 * DAY - WARN_MS);
  eq('★ D1 提醒窗口已过 → 排 resetAt 那一跳保证 DELETE 发生',
    nextAlarmAt({now, resetAt:now + 3 * DAY, hasContent:false}), now + 3 * DAY);
  eq('★ D1 有内容＋提醒未到 → 取 min(按日链, warnAt)',
    nextAlarmAt({now, resetAt:now + 10 * DAY, hasContent:true}), now + LIFECYCLE_MS);
  ok('★ D1 nextAlarmAt 源码不含 online / nextExpiry 形参（在线不再驱动排程）',
    !/\bonline\b/.test(nextBody) && !/\bnextExpiry\b/.test(nextBody));
  /* ★ 回退矩阵 R2 补强：只扫函数体会漏掉「把 online 形参放回来」这种留口子回退，
     签名也必须锁死（函数体 + 签名两层，别让旧形态从形参悄悄回来）。 */
  const nextSig = (lifeCode.match(/export function nextAlarmAt\s*\([^)]*\)/) || [''])[0];
  ok('★ D1 nextAlarmAt 签名不含 online / nextExpiry（不给旧形态留形参口子）',
    nextSig.length > 0 && !/\bonline\b|\bnextExpiry\b/.test(nextSig));
  ok('★ D1 nextAlarmAt 源码含 Number(now) + LIFECYCLE_MS',
    /Number\(now\)\s*\+\s*LIFECYCLE_MS/.test(nextBody));
  ok('★ D1 探针：旧「online>0 → now+SWEEP_MS」片段即被抓（自证）',
    /Number\(online\)\s*>\s*0[\s\S]{0,80}SWEEP_MS/.test(
      'export function nextAlarmAt({now,online}){ if(Number(online) > 0) at.push(Number(now) + SWEEP_MS); }'));
  ok('★ D1 空容器仍走「at.length ? min : null」（口径 8 / L6 不回归）',
    /at\.length\s*\?\s*Math\.min\(\.\.\.at\)\s*:\s*null/.test(nextBody));
}

console.log('== D1 · ③ runLifecycle 不再跑巡检 / 全表 MIN / 每轮写 last_active ==');
{
  ok('★ D1 alarm 链不调 io.sweepIdle()（巡检改由 ws 帧驱动）',
    !/io\.sweepIdle\s*\(/.test(runBody));
  ok('★ D1 alarm 链不调 SQL_MIN_EXPIRY（按日足够，不需要精确下一条到期）',
    !/SQL_MIN_EXPIRY/.test(runBody));
  ok('★ D1 alarm 链不写 last_active（坑 5 同型：alarm 自己续写污染语义）',
    !/UPDATE\s+room\s+SET\s+last_active/.test(runBody));
  ok('★ D1 alarm 链仍保留滚动 DELETE 两条（清理语义不回归）',
    /SQL_SWEEP_MSGS/.test(runBody) && /SQL_SWEEP_IDEM/.test(runBody));
  ok('★ D1 alarm 链仍保留 COUNT_CONTENT 归零判据（每日 1 次，量级可忽略）',
    /SQL_COUNT_CONTENT/.test(runBody) && /shouldReset/.test(runBody));
  ok('★ D1 alarm 链仍保留提醒瞬时帧与静默还原（口径 6 / L2 不回归）',
    /shouldWarn/.test(runBody) && /await io\.reset\(\)/.test(runBody));
  ok('★ D1 rearm 仍只由 runLifecycle 一处续排（单实例不回归）',
    (runBody.match(/io\.rearm\s*\(/g) || []).length === 1);
  ok('★ D1 探针：把 io.sweepIdle() 放回 alarm 链即被抓（自证）',
    /io\.sweepIdle\s*\(/.test('export async function runLifecycle(db,io,now){ io.sweepIdle(); }'));
  ok('★ D1 探针：把表达式 MIN 放回 alarm 链即被抓（自证）',
    /SQL_MIN_EXPIRY/.test('export async function runLifecycle(db,io,now){ const e = q(SQL_MIN_EXPIRY)[0].e; }'));
}

console.log('== D1 · ④ 巡检改由 ws 帧驱动（零 alarm / 零全表 SQL）==');
{
  ok('★ D1 webSocketMessage 收到任意帧后调 sweepIdleThrottled()',
    /serializeAttachment\(Object\.assign\(\{\}, att, \{ts:Date\.now\(\)\}\)\)[\s\S]{0,220}sweepIdleThrottled\(\)/.test(roomCode));
  const throttle = (() => {
    const m = /sweepIdleThrottled\(\)\s*\{/.exec(roomCode);
    return m ? body(roomCode, m.index + m[0].length - 1) : '';
  })();
  ok('★ D1 节流方法存在且用 SWEEP_MS 内存时间戳（DO 休眠重建无所谓）',
    throttle.length > 0 && /_lastSweep/.test(throttle) && /SWEEP_MS/.test(throttle));
  ok('★ D1 节流方法最终调 sweepIdle()（半开连接仍被清，IDLE_MS 语义不回归）',
    /this\.sweepIdle\(\)/.test(throttle));
  ok('★ D1 sweepIdle() 本体仍按 IDLE_MS 判超时并主动 close（B 组真机结论不回归）',
    /now - last > IDLE_MS/.test(roomCode) && /ws\.close\(4000/.test(roomCode));
  ok('★ D1 探针：没有任何帧驱动调用即被抓（自证）',
    !/sweepIdleThrottled\(\)/.test('async webSocketMessage(ws,data){ ws.serializeAttachment({ts:1}); }'));
}

console.log('== D1 · ⑤ 用户动作路径改 O(1) 存在性查询 ==');
{
  ok('★ D1 armFromUserAction 用 SQL_HAS_CONTENT（不再 COUNT(*) 全表）',
    /SQL_HAS_CONTENT/.test(armBody) && !/SQL_COUNT_CONTENT/.test(armBody));
  ok('★ D1 armFromUserAction 不再算 SQL_MIN_EXPIRY',
    !/SQL_MIN_EXPIRY/.test(armBody));
  ok('★ D1 armFromUserAction 仍调 nextAlarmAt + rearm（明确用户路径 L6 不回归）',
    /nextAlarmAt\(/.test(armBody) && /rearm\(/.test(armBody));
  ok('★ D1 SQL_HAS_CONTENT 是 LIMIT 1 存在性判据，不含 COUNT(*)',
    /LIMIT 1/.test(SQL_HAS_CONTENT) && !/COUNT\(\*\)/.test(SQL_HAS_CONTENT));
  ok('★ D1 SQL_HAS_CONTENT 只查计时主体两表（C1 不读辅助表）',
    /FROM messages/.test(SQL_HAS_CONTENT) && /FROM idempotency/.test(SQL_HAS_CONTENT) &&
    !/FROM combat|FROM pcs|FROM members/.test(SQL_HAS_CONTENT));
  ok('★ D1 SQL_COUNT_CONTENT / SQL_MIN_EXPIRY 常量仍保留（口径留痕，alarm 链不调用）',
    /COUNT\(\*\)/.test(SQL_COUNT_CONTENT) && /MIN\(/.test(SQL_MIN_EXPIRY));
  ok('★ D1 探针：arm 路径放回 COUNT(*) 即被抓（自证）',
    /SQL_COUNT_CONTENT/.test('async armFromUserAction(){ const c = q(SQL_COUNT_CONTENT)[0].c; }'));
  /* ★ 评估后登记、本包不实施：refreshAnchor 每条指令仍跑 SQL_MAX_EXPIRY 表达式全表聚合。
     频率 = 指令数（按需，非定时自续），量级远低于旧 alarm 链；留 S2-D / 封板评估。 */
  ok('★ D1 登记：refreshAnchor 仍用 SQL_MAX_EXPIRY（按需，本包不扩张）',
    /async refreshAnchor\(\)[\s\S]{0,300}SQL_MAX_EXPIRY/.test(roomCode));
}

console.log('== D1 · ⑥ 真跑：sql.js 建库 → 同一份 runLifecycle（不抄决策顺序）==');
{
  const SQL = await initSqlJs();
  const ddl = read('apps/worker/src/schema.sql')
    .split(';').map(s => s.trim()).filter(s => s && !/^PRAGMA/i.test(s));
  const mk = () => {
    const db = new SQL.Database();
    ddl.forEach(s => db.run(s));
    db.run(`INSERT INTO room (id, code, created_at, last_active, rule, baredice, seq)
      VALUES (1,'123456',?,?,'generic',0,1)`, [now - 40 * DAY, now]);
    return db;
  };
  const driver = db => ({
    q: (s, ...p) => {
      const r = db.exec(s, p.length ? p : undefined);
      return r.length ? r[0].values.map(row => Object.fromEntries(r[0].columns.map((c, i) => [c, row[i]]))) : [];
    },
    run: (s, ...p) => { db.run(s, p.length ? p : undefined); },
  });
  const has = db => driver(db).q(SQL_HAS_CONTENT)[0].c;

  const empty = mk();
  eq('★ D1 真跑：空库 SQL_HAS_CONTENT = 0', has(empty), 0);
  empty.run(`INSERT INTO messages (seq,id,ts,kind,from_name,payload) VALUES (1,'123456:1',?,'chat','老王','{}')`, [now]);
  eq('★ D1 真跑：有 1 条消息 SQL_HAS_CONTENT = 1', has(empty), 1);
  empty.run(`DELETE FROM messages`);
  empty.run(`INSERT INTO idempotency (req_id, seq, ts) VALUES ('r',1,?)`, [now]);
  eq('★ D1 真跑：只有幂等键也算有内容（计时主体两表都算）', has(empty), 1);

  /* 在线但无用户动作：模拟挂着一屋子 ws，验 rearm 拿到的是「按日」而不是 60s */
  const d = mk();
  d.run(`INSERT INTO messages (seq,id,ts,kind,from_name,payload)
    VALUES (1,'123456:1',?,'chat','老王','{}')`, [now]);
  d.run(`INSERT INTO idempotency (req_id, seq, ts) VALUES ('r1',1,?)`, [now]);
  let sweeps = 0, arms = [], frames = [];
  const io = {
    broadcast: f => frames.push(f),
    reset: () => { RESET_SQL.forEach(s => d.run(s)); return true; },
    sweepIdle: () => { sweeps++; },
    onlineCount: () => 3,                       // ★ 挂着 3 条 ws，旧形态会排 now+60s
    rearm: at => { arms.push(at); },
  };
  const r1 = await runLifecycle(driver(d), io, now);
  eq('★ D1 真跑：有在线＋有内容，armAt 仍是 now + 1 天（不是 60 秒）', r1.armAt, now + LIFECYCLE_MS);
  eq('★ D1 真跑：runLifecycle 调 sweepIdle 次数 = 0（巡检不进 alarm 链）', sweeps, 0);
  eq('★ D1 真跑：rearm 只被调 1 次（单实例）', arms.length, 1);
  eq('★ D1 真跑：不到 30 天的消息不被误删（清理语义不回归）',
    d.exec('SELECT COUNT(*) AS c FROM messages')[0].values[0][0], 1);

  /* 连跑 30 次日链：每次都按日续排，且总量只 30 轮（旧形态同窗口是 43200 轮） */
  let t = now;
  for(let i = 0; i < 30; i++){
    const r = await runLifecycle(driver(d), io, t);
    if(r.armAt != null) t = r.armAt;
  }
  eq('★ D1 真跑：连跑 30 轮每日链，仍未归零（消息 30 天后才到期）',
    d.exec('SELECT COUNT(*) AS c FROM messages')[0].values[0][0], 1);
  ok('★ D1 真跑：30 轮里 armAt 始终按日，不出现 60s 短跳',
    arms.every(a => a == null || a >= now + LIFECYCLE_MS - 1));

  /* 到期 → 归零还原仍成立（L2 / C1 不回归） */
  d.run('UPDATE messages SET ts = ?', [now - 31 * DAY]);
  d.run('UPDATE idempotency SET ts = ?', [now - 31 * DAY]);
  const rEnd = await runLifecycle(driver(d), io, now + 31 * DAY);
  eq('★ D1 真跑：到期后由非空变空仍静默归零', rEnd.reset, true);
  eq('★ D1 真跑：归零后不排下一轮闹钟', rEnd.armAt, null);
  eq('★ D1 真跑：归零后计时主体清空',
    d.exec('SELECT COUNT(*) AS c FROM messages')[0].values[0][0] +
    d.exec('SELECT COUNT(*) AS c FROM idempotency')[0].values[0][0], 0);
  ok('★ D1 真跑：归零那轮 sweepIdle 仍 0 次', sweeps === 0);
}

console.log('---------------------------');
console.log('D1 用量根治：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

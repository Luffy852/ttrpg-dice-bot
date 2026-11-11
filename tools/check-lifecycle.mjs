/* ============================================================================
 * check-lifecycle.mjs —— 房间生命周期「四条守恒断言」（T6b · H·7.2 ⑤⑥⑦⑧）
 * ----------------------------------------------------------------------------
 * 【只锁约束、不实现】档案 §0.4 / 附录 G 的九条口径、B1–B3、alarm 形态、五个实现坑
 *   是**功能开发轮的设计前提**。优化补完轮不实现重置 / 提醒改造 / alarm 重构、
 *   不加 `reset_at` 列（§0.5 第 11 条）。所以本脚本验的不是「现状已经符合规格」，
 *   而是「现状没有提前违反，且将来谁实现时一违反就红」—— 每条都有违规探针自证，
 *   不因为「功能还不存在」就变成摆设断言。
 *
 * 【★ 已知现状登记（不是合规，别误读）】
 *   room.js 的 alarm() 提醒段当前确实 `allocSeq + insertMsgs` 落了一条 kind:'sys' 的
 *   messages 行（附录 G·8.5 坑 2）；导入完成 notice 同理，但那是口径 4 的用户动作留痕。
 *   两者都是 S1 现状，改造排期在功能开发轮。本轮**不动 room.js**，故 ⑥ 的扫描对象是
 *   「新增的还原 / 重置路径」，不把上面两段判红；脚本会把现状显式打印出来。
 *
 * 【怎么用】 node tools/check-lifecycle.mjs （已挂进 npm run check）
 * 【改口径时】先改档案 §0.4 / 附录 G，再改下面的 CONTRACT —— 它是口径的可执行副本。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };

const roomRaw   = read('apps/worker/src/room.js');
const schemaRaw = read('apps/worker/src/schema.sql');
const stripJs  = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
const stripSql = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const room = stripJs(roomRaw), schema = stripSql(schemaRaw);

/* ---------------------------------------------------------------------------
 * CONTRACT：§0.4 / 附录 G 已定口径的**可执行副本**（改口径先改档案再改这里）
 * ------------------------------------------------------------------------- */
const CONTRACT = {
  /* ⑤ 墓碑永不清：room 行 + seq + PIN（口径 1 / B1 / §0.5 第 13 条） */
  tombstoneCols: ['code', 'created_at', 'pin_hmac', 'pin_salt', 'seq'],
  forbidInCleanup: [
    {re:/DELETE\s+FROM\s+room\b/i,                     why:'删 room 行'},
    {re:/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?room\b/i,   why:'重建 / 删 room 表'},
    {re:/UPDATE\s+room\s+SET\s+seq\s*=\s*(?:0|1)\b/i, why:'把 seq 压回初始（会撞已导出战报 id）'},
    {re:/(?:pin_hmac|pin_salt)\s*=\s*(?:NULL|''|"")/i, why:'清空 PIN（B1 防护降级）'},
    {re:/\.deleteAll\s*\(/,                            why:'deleteAll 释放号码（坑 4 / 口径 1）'},
  ],
  /* ⑥ 提醒非消息 / B2 零消息：新增的还原路径不得落消息、不得续期、不得占 seq */
  noMessageCalls: ['insertMsgs', 'allocSeq', 'keep_until'],
  /* ⑦ 锚点隔离（坑 5）：last_active 由 alarm 自己每次续写，不能当存活/重置判据 */
  lastActiveAllowed: [
    /^\s*last_active\s+INTEGER/,                          // 表定义
    /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+room\s*\([^)]*\blast_active\b/i,  // 建房时写初始值的列清单
    /UPDATE\s+room\s+SET\s+last_active\s*=\s*\?/,         // 记账写入
  ],
  /* ⑧ 还原规格（B1–B3 / §8.6 / E5） */
  forbiddenCols:   ['total_joins', 'reset_at'],           // B3 不加列；reset_at 属功能开发轮
  forbiddenTables: ['combat', 'combat_entry'],            // §8.6 优化补完轮不预建
  futureClearTables: ['combat', 'combat_entry'],          // E5：两表都必须进清空辅助表清单
  resetDefaults: {
    rule: "'generic'", baredice: '0',
    clearFields: ['rule_set_by', 'rule_set_at'],
    clearTable: 'members', noMessage: true,
  },
  knownDebt: 'room.js 的 alarm 提醒段当前 allocSeq + insertMsgs 落 sys 消息（坑 2 / 口径 6），属 S1 现状；功能开发轮改造，优化补完轮不动 room.js，本脚本不把它判红',
};

/** 找出「还原 / 重置」函数（将来功能开发轮新增的路径），花括号配平取整个函数体 */
function resetBlocks(src){
  const out = [];
  const re = /(?:^|\n)\s*(?:async\s+)?(?:function\s+)?(\w*(?:reset|restore|还原)\w*)\s*\([^)]*\)\s*\{/gi;
  let m;
  while((m = re.exec(src))){
    const brace = re.lastIndex - 1;
    let depth = 0, j = brace;
    for(; j < src.length; j++){
      if(src[j] === '{') depth++;
      else if(src[j] === '}'){ depth--; if(depth === 0){ j++; break; } }
    }
    out.push({name:m[1], body:src.slice(brace, j)});
  }
  return out;
}
const hitCalls = body => CONTRACT.noMessageCalls.filter(k => new RegExp('\\b' + k + '\\b').test(body));

console.log('== ⑤ 墓碑守恒（口径 1 / B1 / §0.5 第 13 条）==');
{
  const hits = CONTRACT.forbidInCleanup.filter(p => p.re.test(room));
  ok('★ 清理 / 还原路径不碰墓碑（' + CONTRACT.forbidInCleanup.length + ' 条禁止模式）',
    hits.length === 0, hits.map(h => h.why).join(' / '));
  const roomTable = (schema.match(/CREATE TABLE IF NOT EXISTS room\s*\(([\s\S]*?)\);/) || [,''])[1];
  const missing = CONTRACT.tombstoneCols.filter(c => !new RegExp('\\b' + c + '\\b').test(roomTable));
  ok('★ room 表含全部墓碑字段（' + CONTRACT.tombstoneCols.join('/') + '）',
    missing.length === 0, '缺：' + missing.join(','));
  const bad = 'this.sql.exec("DELETE FROM room WHERE id = 1");\n' +
              'this.sql.exec("UPDATE room SET seq = 0");\n' +
              'this.sql.exec("UPDATE room SET pin_hmac = NULL");\n' +
              'this.ctx.storage.deleteAll();';
  const caught = CONTRACT.forbidInCleanup.filter(p => p.re.test(bad));
  ok('★ 探针：墓碑禁止模式能抓到违规样本（自证 ' + caught.length + '/' + CONTRACT.forbidInCleanup.length + '）',
    caught.length >= 4);
}

console.log('== ⑥ 提醒非消息（口径 6 / 坑 2 · 只守新增的还原 / 重置路径）==');
{
  const blocks = resetBlocks(room);
  const bad = blocks.filter(b => hitCalls(b.body).length > 0);
  ok('★ 新增的还原 / 重置路径不得落消息（当前 ' + blocks.length + ' 个还原路径）',
    bad.length === 0, bad.map(b => b.name + ' → ' + hitCalls(b.body).join(',')).join(' / '));
  const probe = 'async resetRoom(){\n' +
                '  const s = await this.storage().allocSeq(1);\n' +
                '  await this.storage().insertMsgs([{seq:s, keep_until:null}]);\n}';
  const pb = resetBlocks(probe);
  ok('★ 探针：还原路径落消息 / 占 seq / 写 keep_until 即被抓到（自证）',
    pb.length === 1 && hitCalls(pb[0].body).length === CONTRACT.noMessageCalls.length);
  ok('★ 规格显式登记 S1 现状，不把「全绿」误读成「现状合规」',
    /insertMsgs/.test(CONTRACT.knownDebt) && /功能开发轮/.test(CONTRACT.knownDebt) && /不把它判红/.test(CONTRACT.knownDebt));
  console.log('  ⚠️ 现状登记（不判红）：' + CONTRACT.knownDebt);
}

console.log('== ⑦ 锚点隔离（坑 5：last_active 不能当存活 / 重置锚点）==');
{
  const isAllowed = l => CONTRACT.lastActiveAllowed.some(p => p.test(l));
  const lines = room.split('\n').filter(l => /\blast_active\b/.test(l));
  const bad = lines.filter(l => !isAllowed(l));
  ok('★ last_active 只出现在表定义与记账写入（共 ' + lines.length + ' 处）',
    bad.length === 0, bad.map(l => l.trim().slice(0, 80)).join(' / '));
  const probe = 'if(now - room.last_active > DAY) return;\n' +
                'const r = this.sql.exec("SELECT last_active FROM room WHERE last_active < ?", now);';
  const pl = probe.split('\n').filter(l => /\blast_active\b/.test(l));
  ok('★ 探针：拿 last_active 作判定 / 读列即被抓到（自证）',
    pl.length >= 2 && pl.every(l => !isAllowed(l)));
}

console.log('== ⑧ 还原规格守恒（B1–B3 / §8.6 / E5）==');
{
  const ddl = schema + '\n' + room;   // 两份 DDL 都扫（schema.sql 是唯一出处，room.js 是运行时副本）
  const colHits = CONTRACT.forbiddenCols.filter(c => new RegExp('\\b' + c + '\\b').test(ddl));
  ok('★ schema 不含 total_joins / reset_at 列（B3 不加列 / §0.5 第 11 条）',
    colHits.length === 0, colHits.join(','));
  const tblHits = CONTRACT.forbiddenTables.filter(t => new RegExp('CREATE\\s+TABLE[^;]*\\b' + t + '\\b', 'i').test(ddl));
  ok('★ 不预建 combat / combat_entry 表（§8.6）', tblHits.length === 0, tblHits.join(','));
  const d = CONTRACT.resetDefaults;
  ok('★ 规格常量含 B2 / B3 还原项（rule 回默认 / baredice=0 / 清设定者 / 清 members / 零消息）',
    d.rule === "'generic'" && d.baredice === '0' && d.clearFields.length === 2 &&
    d.clearTable === 'members' && d.noMessage === true);
  ok('★ 规格常量登记「两张表都必须进清空辅助表清单」（E5）',
    CONTRACT.futureClearTables.length === 2 &&
    CONTRACT.futureClearTables.includes('combat') && CONTRACT.futureClearTables.includes('combat_entry'));
  /* 正向要求：还原路径（若存在）必须写回默认 + 清 members，且不得落消息（B2 零消息） */
  const must = [/rule\s*=\s*'generic'/i, /baredice\s*=\s*0/i, /rule_set_by/i, /rule_set_at/i, /DELETE\s+FROM\s+members/i];
  const blocks = resetBlocks(room);
  const missingAll = blocks.flatMap(b => must.filter(p => !p.test(b.body)).map(p => b.name + ' 缺 ' + p));
  ok('★ 还原路径（若存在）必须写回默认并清 members（当前 ' + blocks.length + ' 个）',
    missingAll.length === 0, missingAll.join(' / '));
  ok('★ 还原路径零消息（B2）', blocks.every(b => !/insertMsgs|allocSeq/.test(b.body)));
  const good = "async resetRoom(){ this.sql.exec(\"UPDATE room SET rule = 'generic', baredice = 0, rule_set_by = NULL, rule_set_at = NULL\"); this.sql.exec('DELETE FROM members'); }";
  const short = "async resetRoom(){ this.sql.exec(\"UPDATE room SET rule = 'generic'\"); this.sql.exec('DELETE FROM members'); }";
  const gb = resetBlocks(good), sb = resetBlocks(short);
  ok('★ 探针：合规还原路径通过 / 缺项还原路径被抓（自证）',
    gb.length === 1 && must.every(p => p.test(gb[0].body)) &&
    sb.length === 1 && must.some(p => !p.test(sb[0].body)));
}

console.log('---------------------------');
console.log('生命周期守恒：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

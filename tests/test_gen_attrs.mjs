/* ============================================================================
 * test_gen_attrs.mjs —— S2 模块 A · A1「纯生成器层」真跑验收
 * ----------------------------------------------------------------------------
 * 对应 v11 附录 I·2（模块 A）的 I·2.2 / I·2.3 / I·2.4 / I·2.5 / I·2.7。
 * 本包**不接运行时**（不动 card.js / cmd.js / help.js）：这里直接对生成器入口
 * 与产出的 html.defs 做断言，验证公式、值域、格式、体积、Markdown 与零协议改动。
 * A2 接线后，I·2.7 的「六规则下可执行 / 消息流 / 真机」由端到端链路补齐。
 *
 * 随机源一律走 Engine.RNG.die（可注入固定序列）；测试用 try/finally 恢复原实现。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as Engine from '../packages/engine/src/index.js';
import { GEN_SPEC, GEN_BAD_COUNT, parseGenCount, genAttrs, genCocGroup, rollDndGroup } from '../packages/engine/src/gen_attrs.js';
import { COC_ATTRS } from '../packages/engine/src/coc.js';
import { DND_STANDARD_ARRAY } from '../packages/engine/src/dnd.js';
import { checkPayload, KIND, LIMITS } from '../packages/protocol/src/payload.js';
import { renderBattleMd } from '../packages/engine/src/render-md.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'packages', 'engine', 'src', 'gen_attrs.js'), 'utf8');
/* ★ 与 tools/check-engine-split.js 同款口径：源码级断言必须**先剥注释**再扫代码。
 *   注释里如实写着「不绑 room.rule」「不进 parseExpr」「不用 Math.random」这些说明，
 *   直接扫 SRC 会把说明文字误判成代码引用（首轮就这样假红了 4 项）。 */
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
const CODE = strip(SRC);

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };
const eq = (n, a, b) => ok(n, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));

const ORIG = Engine.RNG.die;
/** 注入固定骰序列；序列耗尽后恒定返回 1（用于 20 组这类长跑） */
function dice(seq, fn){
  let i = 0;
  Engine.RNG.die = () => { const v = seq[i++]; return v === undefined ? 1 : v; };
  try{ return fn(); } finally{ Engine.RNG.die = ORIG; }
}
const diceAll = (v, fn) => dice(new Array(600).fill(v), fn);

/* 一组 COC（24 次 die(6)）／一组 DND（24 次 die(6)）的确定性序列 */
const COC_SEQ = [1,2,3, 4,5,6, 1,1, 2,3,4, 5,6,1, 2,2, 3,4,5, 6,6, 1,2,3];
const DND_SEQ = [1,2,3,4, 6,6,6,6, 1,1,1,1, 2,3,4,5, 6,5,4,3, 1,2,3,4];
const cocRows = n => dice(COC_SEQ, () => genAttrs('coc', String(n)).defs.rows);
const dndRows = n => dice(DND_SEQ, () => genAttrs('dnd', String(n)).defs.rows);

console.log('== A1·验收 1 · 共用入口与接口形状（I·2.1 / I·2.7 第 1 条） ==');
{
  eq('GEN_SPEC 恰有 coc / dnd 两键', Object.keys(GEN_SPEC).sort().join(','), 'coc,dnd');
  ok('每个 spec 都有 title 与 build(n)', ['coc','dnd'].every(k =>
    typeof GEN_SPEC[k].title === 'string' && typeof GEN_SPEC[k].build === 'function'));
  eq('★ 共用入口签名只有 verb/rest 两个参数（不接 room / rule）', genAttrs.length, 2);
  ok('★ 生成器不引用 room.rule / RULE_META / rulePack',
    !/room\.rule|RULE_META|rulePack/.test(CODE));
  ok('★ 不写分规则 if 分支（一次 GEN_SPEC 查表）', !/verb\s*===\s*'coc'|verb\s*===\s*'dnd'/.test(CODE));
  eq('标题与示例一致', GEN_SPEC.coc.title, '🎲 COC 7th 随机属性');
  eq('标题与示例一致', GEN_SPEC.dnd.title, '🎲 DND 随机属性');
}

console.log('== A1·验收 2 · 组数 N = 1–20 与非法值显式提示（I·2.2 / I·2.7 第 6 条） ==');
{
  eq('提示文案原文', GEN_BAD_COUNT, '组数 1–20');
  eq('裸命令 = 1 组', parseGenCount(''), 1);
  eq('N=1', parseGenCount('1'), 1);
  eq('N=20', parseGenCount('20'), 20);
  eq('前后空白 tolerated', parseGenCount('  3  '), 3);
  for(const bad of ['0','21','25','abc','1.5','3 4','-1','1e2','２０']){
    eq('★ 非法「' + bad + '」→ null（不静默、不兜底成 1）', parseGenCount(bad), null);
    const g = genAttrs('coc', bad);
    eq('★ 非法「' + bad + '」显式提示', g.notice, GEN_BAD_COUNT);
    eq('★ 非法「' + bad + '」不产出 defs', g.defs, undefined);
  }
  eq('.coc 1 产出 1 组（2 行 rows）', cocRows(1).length, 2);
  eq('.coc 20 产出 20 组（40 行 rows）', cocRows(20).length, 40);
  eq('.dnd 1 = 标准数组 1 行 + 1 组随机', dndRows(1).length, 2);
  eq('.dnd 20 = 1 行标准数组 + 20 组随机', dndRows(20).length, 21);
  eq('★ .coc 裸命令 = 1 组（与 .coc 1 逐字节相同）',
    JSON.stringify(dice(COC_SEQ, () => genAttrs('coc', '').defs.rows)), JSON.stringify(cocRows(1)));
  eq('★ .dnd 裸命令 = 标准数组 + 1 组随机（与 .dnd 1 逐字节相同）',
    JSON.stringify(dice(DND_SEQ, () => genAttrs('dnd', '').defs.rows)), JSON.stringify(dndRows(1)));
}

console.log('== A1·验收 3 · COC 属性顺序 / 公式值域 / 两总和（I·2.3 / I·2.7 第 3 条） ==');
{
  eq('COC_ATTRS 是九项且第九项为幸运', COC_ATTRS.length + '/' + COC_ATTRS[8], '9/幸运');
  const shown = cocRows(1)[0].v;
  const copy  = cocRows(1)[1].v;
  eq('★ 展示行与固定序列逐字符一致', shown,
    '力量:30 体质:75 体型:40 敏捷:45 外貌:60 智力:50 意志:60 教育:90 | 幸运:30 ➔ 总和 480 / 不含幸运 450');
  eq('★ 可复制行与固定序列逐字符一致', copy,
    '复制写卡：.st set 力量 30 体质 75 体型 40 敏捷 45 外貌 60 智力 50 意志 60 教育 90 幸运 30');
  eq('复制行 k 为空（展示行/可复制行分离）', cocRows(1)[1].k, '');

  /* 属性名顺序：展示行「| 幸运」之前 = COC_ATTRS.slice(0,8)；可复制行九项 = COC_ATTRS 全序 */
  const namesShown = [...shown.split(' | ')[0].matchAll(/([一-鿿]{2}):\d+/g)].map(m => m[1]);
  const namesCopy  = [...copy.matchAll(/([一-鿿]{2})\s+\d+/g)].map(m => m[1]);
  eq('★ 展示行属性名顺序与 COC_ATTRS 前八项逐项一致',
    namesShown.join(','), COC_ATTRS.slice(0, 8).join(','));
  eq('★ 可复制行属性名顺序与 COC_ATTRS 全序逐项一致',
    namesCopy.join(','), COC_ATTRS.join(','));

  /* 值域：3d6×5 ∈[15,90]；(2d6+6)×5 ∈[40,90]；都是 5 的倍数 */
  const VALID = {'力量':[15,90],'体质':[15,90],'体型':[40,90],'敏捷':[15,90],
                 '外貌':[15,90],'智力':[40,90],'意志':[15,90],'教育':[40,90],'幸运':[15,90]};
  for(const v of [1, 6]){
    const g = diceAll(v, () => genCocGroup());
    ok('全 ' + v + ' 时九项都在各自公式值域内且是 5 的倍数',
      COC_ATTRS.every(k => {
        const [lo, hi] = VALID[k];
        return Number.isInteger(g[k]) && g[k] >= lo && g[k] <= hi && g[k] % 5 === 0;
      }), JSON.stringify(g));
  }
  eq('全 1：3d6×5 = 15', diceAll(1, () => genCocGroup())['力量'], 15);
  eq('全 1：(2d6+6)×5 = 40', diceAll(1, () => genCocGroup())['体型'], 40);
  eq('全 6：3d6×5 = 90', diceAll(6, () => genCocGroup())['力量'], 90);
  eq('全 6：(2d6+6)×5 = 90', diceAll(6, () => genCocGroup())['体型'], 90);

  /* 两总和自洽（20 组逐组验） */
  const rows = cocRows(20);
  let sumsOk = true;
  for(let i = 0; i < 20; i++){
    const line = rows[i * 2].v;
    const nums = [...line.matchAll(/:(\d+)/g)].map(m => Number(m[1]));
    const m = line.match(/➔ 总和 (\d+) \/ 不含幸运 (\d+)/);
    if(!m || nums.length !== 9) { sumsOk = false; break; }
    const all = nums.reduce((a, b) => a + b, 0);
    const base = nums.slice(0, 8).reduce((a, b) => a + b, 0);
    if(Number(m[1]) !== all || Number(m[2]) !== base || all !== base + nums[8]) { sumsOk = false; break; }
  }
  ok('★ 20 组：含幸运总和＝九项之和 / 不含幸运＝八项之和 / 两数相差幸运', sumsOk);
}

console.log('== A1·验收 4 · 可复制行原样写卡（I·2.3 / I·2.7 第 4 条） ==');
{
  const copy = cocRows(1)[1].v.replace(/^复制写卡：\.st set\s+/, '');
  const parsed = Engine.COC_PACK.parseCard(copy);
  eq('★ 贴入 .st set 解析无错误', parsed.errs.length, 0);
  eq('★ 解析出 9 个属性键', parsed.count, 9);
  eq('力量值 = 生成值', parsed.data['力量'], 30);
  eq('幸运值 = 生成值', parsed.data['幸运'], 30);
  /* 同族合并（cmd.js .st set 的既有语义 Object.assign({}, base, r.data)）：
     只覆盖同名属性、保留技能与背景 */
  const base = {侦查:60, 图书馆:50, 力量:10, 背景:'考古学家'};
  const merged = Object.assign({}, base, parsed.data);
  eq('★ 同名属性被覆盖', merged['力量'], 30);
  eq('★ 已有技能不丢：侦查', merged['侦查'], 60);
  eq('★ 已有技能不丢：图书馆', merged['图书馆'], 50);
  eq('★ 背景字段不丢', merged['背景'], '考古学家');
  ok('★ 合并后未凭空新增派生值字段', ['hp','mp','san','db','体格'].every(k => !(k in merged)));
  ok('★ 可复制行只含「名字 空格 数值」，无冒号 / 竖线', !/[:|]/.test(copy), copy);
}

console.log('== A1·验收 5 · DND 降序 / 补零 / 首行恒标准数组（I·2.4 / I·2.7 第 5 条） ==');
{
  eq('★ 标准数组常量只此一份且为 [15,14,13,12,10,8]', DND_STANDARD_ARRAY.join(','), '15,14,13,12,10,8');
  eq('★ 首行标准数组与示例逐字符一致', dndRows(1)[0].v,
    '[总分: 72] ➔ 15, 14, 13, 12, 10, 08');
  eq('首行 k 与示例一致', dndRows(1)[0].k, '📋 标准数组');
  eq('★ 20 组时首行仍恒为标准数组', dndRows(20)[0].v,
    '[总分: 72] ➔ 15, 14, 13, 12, 10, 08');

  eq('★ 固定序列第一组逐字符一致', dndRows(1)[1].v,
    '[总分: 66] ➔ 18, 15, 12, 09, 09, 03');
  const g = dice(DND_SEQ, () => rollDndGroup());
  eq('★ rollDndGroup 产出 6 值降序', g.join(','), '18,15,12,9,9,3');
  ok('★ 6 值都在 3–18（4d6 弃最低的值域）', g.every(v => Number.isInteger(v) && v >= 3 && v <= 18));
  eq('全 1：每组 3', diceAll(1, () => rollDndGroup()).join(','), '3,3,3,3,3,3');
  eq('全 6：每组 18', diceAll(6, () => rollDndGroup()).join(','), '18,18,18,18,18,18');

  /* 20 组逐组：降序、补零两位、合计自洽 */
  const rows = dndRows(20);
  let dndOk = true;
  for(let i = 1; i <= 20; i++){
    const line = rows[i].v;
    const m = line.match(/^\[总分: (\d+)\] ➔ (.+)$/);
    if(!m){ dndOk = false; break; }
    const parts = m[2].split(', ');
    if(parts.length !== 6 || parts.some(p => !/^\d{2}$/.test(p))){ dndOk = false; break; }
    const nums = parts.map(Number);
    if(nums.some((v, j) => j > 0 && v > nums[j - 1])){ dndOk = false; break; }
    if(Number(m[1]) !== nums.reduce((a, b) => a + b, 0)){ dndOk = false; break; }
  }
  ok('★ 20 组：6 值降序 / 两位补零 / 合计自洽', dndOk);

  const dndText = JSON.stringify(dndRows(3));
  ok('★ 不披露计算原则（无 4d6 / 弃最低 / 27 点 / 购点）',
    !/4d6|弃最低|27\s*点|购点/.test(dndText), dndText.slice(0, 120));
  ok('★ 不出现 DND 属性名与 .st set',
    !/力量|敏捷|体质|智力|感知|魅力|\.st set/.test(dndText), dndText.slice(0, 120));
  ok('★ 组标记 1–20 互不相同且每组都有',
    new Set(dndRows(20).slice(1).map(r => r.k)).size === 20);
}

console.log('== A1·验收 5b · 组标记字体族（A3 真机反馈：第 10 条不能用彩色 emoji） ==');
{
  /* ★ 只有真浏览器渲染才看得见：🔟 是 U+1F51F 彩色 emoji，Chrome 会走 emoji 字体回退、
   *   无视 .hk 的 monospace / color CSS，渲染成蓝底白字方块；其余 19 条是普通文本字符。
   *   沙盒只能锁「码点」，故把「同族、非 emoji」写成可执行断言，防回退。 */
  const marks = dndRows(20).slice(1).map(r => r.k);
  eq('★ 第 10 条标记 = ⑩（U+2469），不是 🔟（U+1F51F）', marks[9], '⑩');
  ok('★ 20 个标记都不含 emoji 码点（U+1F000 以上）',
    marks.every(m => Array.from(m).every(ch => ch.codePointAt(0) < 0x1F000)),
    JSON.stringify(marks));
  ok('★ 10–20 落在 U+2469..U+2473 连续码点（与 11–20 同族同字体）',
    marks.slice(9).every((m, j) => m.codePointAt(0) === 0x2469 + j),
    JSON.stringify(marks.slice(9)));
  eq('★ COC 与 DND 的 20 个组标记逐项相同（共用 groupMark）',
    cocRows(20).filter(r => r.k).map(r => r.k).join(','), marks.join(','));
  ok('★ 源码不再出现 🔟 的码点写法 1F51F', !/1F51F/i.test(CODE));
}

console.log('== A1·验收 6 · 不输出逐骰明细 / COC 派生值 / 体格表（I·2.3 / I·2.5 / I·2.7 第 8 条） ==');
{
  const text = JSON.stringify(cocRows(2)) + JSON.stringify(dndRows(2));
  ok('★ 无逐骰明细字样', !/逐骰|骰面|tries|kept|明细/.test(text));
  ok('★ 无 COC 派生值（HP / MP / SAN / DB / 体格 / 派生值 / 伤害加值）',
    !/HP|MP|SAN|DB|体格|派生值|伤害加值/.test(text), text.slice(0, 160));
  ok('★ 无年龄 / 年代 / 6 版 / 经典变体字样',
    !/年龄|年代修正|6 版|经典变体/.test(text));
}

console.log('== A1·验收 7 · 体积 / 白名单 / Markdown 战报（I·2.5 / I·2.7 第 9 条） ==');
{
  for(const [verb, label] of [['coc','COC'], ['dnd','DND']]){
    const defs = dice(new Array(600).fill(3), () => genAttrs(verb, '20').defs);
    const size = JSON.stringify({defs}).length;
    ok('★ 20 组 ' + label + ' 单条 payload < 8KB（' + size + ' B < ' + LIMITS.PAYLOAD + ' B）',
      size < LIMITS.PAYLOAD, String(size));
    eq('★ 20 组 ' + label + ' 通过 checkPayload(KIND.HTML) 白名单',
      checkPayload(KIND.HTML, {defs}), null);
    ok('★ 20 组 ' + label + ' 仍是单条消息（rows 完整、未拆条）',
      Array.isArray(defs.rows) && defs.rows.length === (verb === 'coc' ? 40 : 21));
  }
  const defs = dice(COC_SEQ, () => genAttrs('coc', '1').defs);
  const msg = {id:'123456:1', ts:1772000000000, kind:KIND.HTML, from:'骰娘', actor:'老王', payload:{defs}};
  const md = renderBattleMd([msg], {code:'123456', rule:'coc7', exportedAt:'2026-11-13'});
  ok('★ 导出 Markdown 战报可读（标题 / 属性 / 复制写卡都在）',
    md.includes('🎲 COC 7th 随机属性') && md.includes('力量:30') && md.includes('复制写卡') && md.includes('.st set'),
    md.slice(0, 200));
  ok('★ Markdown 不是「结构化说明」占位句', !/结构化说明 · 导出用 NDJSON/.test(md));
}

console.log('== A1·验收 8 · 零协议改动 / 无别名冲突 / 通用语法未泄漏（I·2.5 / I·2.7 第 2、7 条） ==');
{
  ok('★ 不 import 任何 protocol / worker / web / schema / storage 模块',
    !/from\s+['"][^'"]*(protocol|worker|web|schema|storage|frames|payload)/.test(CODE));
  ok('★ 不 import parseExpr（弃最低不向通用语法泄漏）', !/parseExpr/.test(CODE));
  ok('★ 不注册别名（无中文别名、不进 verb 域）', !/registerAliases/.test(CODE));
  ok('★ 不用 Math.random（随机源只用 crypto 经 RNG.die）', !/Math\.random/.test(CODE));
  ok('★ 只用 RNG.die', /RNG\.die/.test(CODE));
  eq('★ .r 4d6k3 仍被拒绝', Engine.parseExpr('4d6k3').ok, false);
  eq('★ .r 4d6kh3 仍被拒绝', Engine.parseExpr('4d6kh3').ok, false);
  eq('★ 别名域零冲突', Engine.ALIAS.conflicts.length, 0);
  eq('★ verb 域尚未被 coc/dnd 占用（为 A2 预留）',
    Engine.detectConflicts('verb', [{key:'coc', aliases:['coc']}, {key:'dnd', aliases:['dnd']}]).length, 0);
  eq('★ .set rule coc 与 .coc 并存不撞（coc 是 rule 域，不是 verb 域）',
    Engine.normalizeRule('coc'), 'coc7');
  eq('★ 六规则仍是 6 个（生成器不进规则注册点）', Object.keys(Engine.RULE_PACKS).length, 6);

  /* 同一固定 RNG 序列循环 6 次，产出逐字节相同 —— 输出与 room.rule 无关 */
  const shots = [];
  for(let i = 0; i < 6; i++) shots.push(JSON.stringify(dice(COC_SEQ, () => genAttrs('coc', '2').defs)));
  ok('★ 六次（对应六规则）产出完全相同：输出不随 room.rule 变化',
    shots.every(s => s === shots[0]));
}

console.log('\n模块 A · A1 纯生成器层：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

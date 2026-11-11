/* ============================================================================
 * load-engine.js —— 把 packages/engine 拼成单一作用域，喂给 test_engine.js
 * ----------------------------------------------------------------------------
 * 【为什么还要拼】ESM 是真实形态（浏览器/Worker 都跑 ESM），但 676 项断言是在
 *   "所有顶层声明同处一个作用域"的前提下写的（M1/M2 是单文件）。
 *   拼接路 = 让断言主体**一行不用改**就能继续跑 —— 保底。
 *   真 ESM 路由 tests/test_engine_esm.mjs 承担（能抓 TDZ / 循环 / 漏 import）。
 *   ★ 两路跑的是**同一份断言**，不是两套测试。
 *
 * 【怎么拼】严格按 index.js 的 export 顺序读取 src/*.js，剥掉 import/export 行。
 *   顺序 = 别名注册顺序，不能乱（见 index.js 头注释）。
 * 【怎么用】 const {Engine, HTML_SRC} = require('./load-engine.js')();
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'packages', 'engine', 'src');

/* ★ T2（2026-11-11）：生成物出库后（T3），任何「文件不存在 → 静默返回空串」
 *   都会让源码级断言扫到空气 = 假绿。必读文件一律显式抛错，并指明重建命令。
 *   `check` 已前置 build:web；这里守的是「有人单独跑 npm test」的路径。 */
function readRequired(file, desc){
  if(!fs.existsSync(file)){
    throw new Error('[load-engine] 缺少' + desc + '：' + file +
      '\n  → 生成物已从 Git 出库时，先跑 `npm run build:web`（或 `npm run check`，它会自动重建）；' +
      '\n  → legacy 是构建输入 + 呈现类断言夹具，必须保留原文件名，不要删。');
  }
  return fs.readFileSync(file, 'utf8');
}

/** ★ T2：生成物出库后的显式闸门 —— 缺一件都不许静默跑断言 */
function assertGeneratedAssets(){
  const shell = path.join(ROOT, 'apps', 'web', 'index.html');
  if(!fs.existsSync(shell)){
    throw new Error('[load-engine] 生成物 apps/web/index.html 不存在：T3 出库后它不再在 Git 里，先跑 `npm run build:web` 重建');
  }
  for(const d of ['engine', 'protocol']){
    const v = path.join(ROOT, 'apps', 'web', 'vendor', d);
    if(!fs.existsSync(v)){
      throw new Error('[load-engine] 生成物 apps/web/vendor/' + d + ' 不存在：先跑 `npm run build:web` 重建');
    }
  }
}

const INDEX = path.join(SRC, 'index.js');
const EXPORTS = readRequired(INDEX, '引擎入口 index.js').match(/export \* from '\.\/(\w+)\.js';/g);
if(!EXPORTS || !EXPORTS.length){
  throw new Error('[load-engine] ' + INDEX + ' 里找不到 `export * from ...` 行（拼接顺序靠它）');
}
const ORDER = EXPORTS.map(s => s.match(/'.\/(\w+)\.js'/)[1]);

// ★ 允许 import 行尾带注释（`/^…;\s*$/` 会把 `import {X} from './y.js'; // 说明` 漏过去 ——
//   那样拼接路会把 ESM 语法留在代码里，直接 "Cannot use import statement outside a module"）
const IMPORT_RE = /^\s*import\s[^;]*;.*$/;
const EXPORT_BLOCK_RE = /^\s*export\s*\{[^}]*\}\s*;.*$/;
const EXPORT_DECL_RE = /^(\s*)export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/;

/** 剥掉 ESM 语法，返回可拼进同一作用域的源码
 *  ★ 注意 `export function f(){}` 不能整行删（会丢函数），只去掉 export 前缀 */
function stripModule(src){
  return src.split('\n').map(l => {
    if(IMPORT_RE.test(l)) return null;
    if(EXPORT_BLOCK_RE.test(l)) return null;
    return l.replace(EXPORT_DECL_RE, '$1');
  }).filter(l => l !== null).join('\n');
}

/** 拼好的引擎源码（含 index.js 里没出现的顺序信息） */
function buildEngineSource(){
  return ORDER.map(n => '\n/* ==== ' + n + '.js ==== */\n' +
    stripModule(readRequired(path.join(SRC, n + '.js'), '引擎模块 ' + n + '.js'))).join('\n');
}

/**
 * 求值出引擎对象。exports 列表与 test_engine.js 原本从 HTML 里抠出的一致。
 */
function loadEngine(){
  assertGeneratedAssets();
  const code = buildEngineSource();
  const Engine = new Function(code + '\n; return {RNG, normalizeRule, ruleFamily, parseExpr, rollGroups, ' +
  'sumKept, buildTotal, natOf, judgeDnd, natNoteOf, abilityMod, profFromLv, lookupSkillOrAbility, ' +
  'DND_SKILLS, parseCardSet, cardMod, handleCommand, makeRoom, renderRoll, esc, parseCommand, ' +
  'isCommandText, defsHtml, renderDefs, renderCardHtml, renderHtml, critOf, ' +
  'ALIAS, detectConflicts, suggestAlias, lookupCheckTarget, normalizeCardKey, natMarkOf, NAT_MARK, ' +
  'hasNatSemantics, cardRuleName, cardMismatchNote, rulePack, RULE_PACKS, lookupAlias, ' +
  'IMPLEMENTED, RULE_META, RULE_TOKEN, ruleToken, LIMITS, HELP_BODY, helpTop, helpCoc, helpDnd, helpFu, ' +
  'hhmm, ymd, ' +
  'rollPercent, judgeCoc, judgeDh, judgeFu, parseTier, lookupCocSkill, FAMILY_PACKS, ' +
  'packOfFamily, verbOwner, CHECK_DOMAIN, CARD_DOMAIN, checkDomainOf, cardDomainOf, ' +
  'COC_SKILLS, COC_MEMO, COC_ATTRS, COC_ATTR_SET, COC_ATTR_ABBR, cocDerived, dbBuildOf, ' +
  'DH_TRAITS, FU_ATTRS, FU_TIERS, ' +
  'GENERIC_PACK, DND_PACK, COC_PACK, DH_PACK, FU_PACK, renderMsg, fmtMod, sumArr, ' +
  'FU_MEMO, FU_MEMO_KEYS, takeOverR:null};')();
  // ★ 源码级断言（§10/§14/§22）扫的就是这段：架构类断言扫引擎源码，呈现类（CSS）扫 legacy HTML
  const legacy = path.join(ROOT, 'legacy', 'M2_骰娘单机可摸版.html');
  const html = readRequired(legacy, 'legacy HTML（构建输入 / 呈现类断言夹具）');
  return {Engine, HTML_SRC: code + '\n' + html, ENGINE_SRC: code, ORDER, SRC};
}

module.exports = {loadEngine, buildEngineSource, ORDER, SRC};

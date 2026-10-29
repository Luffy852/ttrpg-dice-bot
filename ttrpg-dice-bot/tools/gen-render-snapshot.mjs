/* ============================================================================
 * gen-render-snapshot.mjs —— 给 renderRoll() 的 HTML 产物拍快照
 * ----------------------------------------------------------------------------
 * 【为什么要有这个】
 *   M3 要把 render.js 里的「逐骰明细」抽成纯数据层 detailLines(view)，
 *   好让聊天流（HTML）、详情面板、Markdown 战报三处共用（原则 4：同一份渲染不写两遍）。
 *   重构最容易出的错是"功能没错、版面变了"—— 断言查的是"有没有十位两个字"，
 *   查不出缩进少了一个空格。所以：重构**前**先拍快照，重构**后**逐字节比对。
 *
 * 【怎么用】
 *   node tools/gen-render-snapshot.mjs            # 写 tests/snapshots/render_snapshot.json
 *   node tools/gen-render-snapshot.mjs --check    # 与已有快照比对（重构后跑这个）
 *
 * 【★ 可复现的前提】RNG 注入固定序列 —— 否则每次骰点不同，快照永远对不上。
 * ========================================================================== */
import * as Engine from '../packages/engine/src/index.js';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(__dirname, '..', 'tests', 'snapshots', 'render_snapshot.json');
const CHECK = process.argv.includes('--check');

const ORIG_DIE = Engine.RNG.die;
/** 用固定序列跑一条指令，取最后一条 roll 消息的渲染产物 */
function shot(name, rule, text, seq, card, prep){
  let i = 0;
  Engine.RNG.die = () => (seq[i++] !== undefined ? seq[i - 1] : 1);
  try{
    const ctx = {me:'老王', room:Engine.makeRoom(), card:card || null, history:[]};
    ctx.room.rule = rule;
    (prep || []).forEach(t => Engine.handleCommand(t, ctx));
    const msgs = Engine.handleCommand(text, ctx).msgs;
    const roll = msgs.filter(m => m.kind === 'roll').pop();
    if(!roll) return null;
    return {name, html:Engine.renderRoll(Object.assign({id:1, ts:0}, roll))};
  }finally{ Engine.RNG.die = ORIG_DIE; }
}

const DND = {family:'dnd', data:{str:16, dex:14, con:15, int:10, wis:12, cha:8, lv:5}};
const COC = {family:'coc7', data:{侦查:60, 图书馆:50, hp:12, san:70}};
const DH  = {family:'dh',  data:{敏捷:2, 力量:2, 灵巧:1, 本能:0, 风度:1, 知识:-1}};
const FU  = {family:'fu',  data:{dex:8, ins:10, mig:8, wlp:6, 物语点:3, 物资点:2}};

const CASES = [
  ['通用 2d6+3',          'generic', '.r 2d6+3',        [3, 5, 4], null],
  ['通用 复合骰组',        'generic', '.r 4d8+1d4+2',    [8, 2, 5, 1, 4], null],
  ['通用 优势（整条两次）','generic', '.r 1d20+5 优势',   [12, 3, 18, 7], null],
  ['D&D 技能检定带熟练',   'dnd5e',   '.rc 巧手 p',       [11], DND, ['.st set str 16 dex 14 con 15 int 10 wis 12 cha 8 lv 5']],
  ['D&D vs DC20 失败',    'dnd5e',   '.rc 隐匿 20 p',    [3],  DND],
  ['D&D 5e nat20 不自动成功','dnd5e', '.rc 隐匿 30 p',   [20], DND],
  ['D&D 5.5e nat20 即成功','dnd5r',  '.rc 隐匿 30 p',    [20], DND],
  ['D&D 5.5e nat1 即失败','dnd5r',   '.rc 隐匿 1 p',     [1],  DND],
  ['COC 百分骰成功',       'coc7',    '.rc 侦查',         [2, 3], COC],
  ['COC 奖励骰（十位取低）','coc7',   '.rc 侦查 +1',      [7, 1, 3], COC],
  ['COC 惩罚骰（十位取高）','coc7',   '.rc 侦查 -2',      [1, 8, 6, 2], COC],
  ['COC 掷 100 大失败',   'coc7',    '.rc 图书馆',       [0, 0], COC],
  ['匕首心 希望成功',      'dh',      '.dh 敏捷 15',      [9, 4], DH],
  ['匕首心 关键成功（同点）','dh',    '.dh 15',           [6, 6], null],
  ['匕首心 优势 +1d6',     'dh',      '.dh 敏捷 15 优势', [8, 3, 5], DH],
  ['物语 双骰检定',        'fu',      '.fu dex ins 10',   [7, 4], FU],
  ['物语 暴击（同点≥6）',  'fu',      '.fu dex ins 13',   [8, 8], FU],
  ['物语 失手（双 1）',    'fu',      '.fu dex ins 10',   [1, 1], FU],
  ['物语 带调整值',        'fu',      '.fu dex ins 13 +2',[5, 6], FU],
];

const shots = CASES.map(c => shot(c[0], c[1], c[2], c[3], c[4], c[5])).filter(Boolean);

if(!CHECK){
  fs.mkdirSync(path.dirname(SNAP), {recursive:true});
  fs.writeFileSync(SNAP, JSON.stringify(shots, null, 1));
  console.log('✅ 快照已写入：' + SNAP + '（' + shots.length + ' 条）');
  process.exit(0);
}

const old = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
let diff = 0;
old.forEach(o => {
  const n = shots.find(s => s.name === o.name);
  if(!n){ console.log('  ❌ 缺失：' + o.name); diff++; return; }
  if(n.html !== o.html){
    diff++;
    console.log('  ❌ 版面变了：' + o.name);
    for(let i = 0; i < Math.max(o.html.length, n.html.length); i++){
      if(o.html[i] !== n.html[i]){
        console.log('     位置 ' + i + '\n     旧 …' + o.html.slice(Math.max(0, i - 40), i + 40) +
                    '\n     新 …' + n.html.slice(Math.max(0, i - 40), i + 40));
        break;
      }
    }
  }
});
console.log(diff ? ('\n❌ ' + diff + ' / ' + old.length + ' 条版面不一致 —— 重构改动了呈现，要么改回去，要么确认后重拍快照')
                 : ('\n✅ ' + old.length + ' 条渲染产物逐字节一致 —— 重构没动版面'));
process.exit(diff ? 1 : 0);

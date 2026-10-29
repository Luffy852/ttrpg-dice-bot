/* ============================================================================
 * build-web-shell.mjs —— 由 legacy/M2_骰娘单机可摸版.html 生成 apps/web/index.html
 * ----------------------------------------------------------------------------
 * 【为什么用脚本生成而不是手抄】
 *   M2 的 CSS 与 DOM 是**真机验证过的呈现**（Chrome + 手机端 UI 无问题），
 *   手抄一遍必然走样。这里只做机械改造：
 *     ① 删掉整个 <script>（引擎 + 单机前端）→ 换成 <script type="module" src="./src/main.js">
 *     ② 顶栏补「房间号 / 成员 / 导出」
 *     ③ 追加进房页 #gate（M2 没有：单机版不需要进房）
 *   结构与样式一字不改，呈现基线就还在。
 *
 * 【怎么用】 node tools/build-web-shell.mjs
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LEGACY = path.join(ROOT, 'legacy', 'M2_骰娘单机可摸版.html');
const OUT = path.join(ROOT, 'apps', 'web', 'index.html');

let html = fs.readFileSync(LEGACY, 'utf8');

/* ① 删掉引擎 + 单机前端的整段 script */
const s0 = html.indexOf('<script>');
const s1 = html.indexOf('</script>', s0);
if(s0 < 0 || s1 < 0) throw new Error('legacy 里找不到 <script> 块');
html = html.slice(0, s0) +
  '<script type="module" src="./src/main.js"></script>' +
  html.slice(s1 + '</script>'.length);

/* ② 顶栏：房间信息 + 导出 */
html = html.replace('<span class="pill" id="p-cnt">0 条</span>',
  '<span class="pill" id="p-room">房间 —</span>\n      <span class="pill" id="p-cnt">0 条</span>');
html = html.replace('<button class="quick" data-cmd=".set baredice on">.set baredice on</button>',
  '<button class="quick" data-cmd=".set baredice on">.set baredice on</button>\n      <button class="quick" id="btn-export">导出战报</button>');

/* ③ 进房页：加在 #app 之前（默认显示，进房成功后隐藏） */
const GATE = `
<div id="gate">
  <div class="gcard">
    <h1>🎲 骰娘 · 在线多房间</h1>
    <p class="gsub">几个人进同一个房间，发指令掷骰 —— 服务端权威掷骰，全房间看到同一份明细。</p>
    <div class="tabs">
      <button class="tab on" data-tab="join">加入房间</button>
      <button class="tab" data-tab="new">创建房间</button>
    </div>

    <div id="g-join">
      <label>房间号 <input id="g-code" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="6 位数字"></label>
      <label>昵称 <input id="g-nick" autocomplete="off" maxlength="16" placeholder="老王"></label>
      <label>房间口令（开放式房间不用填） <input id="g-pin" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="4 位数字"></label>
      <button class="go" id="g-join-btn">进入房间</button>
    </div>

    <div id="g-new" hidden>
      <label>昵称 <input id="g-nick2" autocomplete="off" maxlength="16" placeholder="老王"></label>
      <label class="chk"><input type="checkbox" id="g-usepin"> 给房间加口令（4 位数字）</label>
      <div id="g-newpin" hidden>
        <label>口令 <input id="g-pin1" inputmode="numeric" autocomplete="off" maxlength="4"></label>
        <label>再输一次 <input id="g-pin2" inputmode="numeric" autocomplete="off" maxlength="4"></label>
        <p class="warn">⚠️ 口令<b>不可修改、不可找回</b>。忘了 = 整个群组永久进不去，请先想好再创建。</p>
      </div>
      <button class="go" id="g-new-btn">创建房间</button>
    </div>

    <div id="g-created" hidden>
      <div class="pinbox">
        <div class="prow">房间号 <b id="c-code">—</b></div>
        <div class="prow">口　令 <b id="c-pin">—</b></div>
      </div>
      <p class="warn">⚠️ 这是口令<b>唯一一次</b>展示 —— 不可修改、不可找回，请现在截图保存。<br>
        房间号与口令<b>分开显示</b>就是为了让你两个都截到（只截一个等于没截）。</p>
      <button class="go" id="c-go">进入房间</button>
    </div>

    <div class="gerr" id="g-err"></div>
    <p class="gfoot">消息只保留 30 天 · 重要战报记得导出 · 四套规则：通用 / D&amp;D / COC / 匕首心 / 最终物语</p>
  </div>
</div>
`;
html = html.replace('<div id="app">', GATE + '\n<div id="app" hidden>');

/* ④ 进房页样式（追加到 </style> 前；不与 M2 的既有类重名） */
const CSS = `
/* ---------- 进房页 #gate（M3 新增） ---------- */
#gate{position:fixed;inset:0;z-index:20;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}
#gate[hidden]{display:none}
.gcard{width:100%;max-width:420px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 18px 14px}
.gcard h1{margin:0 0 4px;font-size:18px}
.gsub{margin:0 0 12px;font-size:12.5px;color:var(--tx2);line-height:1.5}
.tabs{display:flex;gap:6px;margin-bottom:12px}
.tab{flex:1 1 0;font:inherit;font-size:13px;padding:7px 0;border:1px solid var(--line);background:#fff;border-radius:9px;color:var(--tx2);cursor:pointer}
.tab.on{background:#eef2ff;border-color:#dfe3ff;color:#4338ca;font-weight:700}
.gcard label{display:block;font-size:12px;color:var(--tx2);margin:9px 0 4px}
.gcard label.chk{display:flex;gap:7px;align-items:center;color:var(--tx);font-size:13px;margin:12px 0}
.gcard input[type=text],.gcard input:not([type]){width:100%;font:inherit;font-size:16px;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--tx)}
.gcard input[maxlength="6"],.gcard input[maxlength="4"]{letter-spacing:.12em}
.go{width:100%;margin-top:14px;font:inherit;font-size:14px;font-weight:600;padding:10px 0;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
.go:active{opacity:.85}
.warn{font-size:12px;color:var(--warn);background:var(--warnbg);border:1px solid var(--warnline);border-radius:8px;padding:7px 9px;margin:10px 0 0;line-height:1.55}
.pinbox{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:#f8f9fb}
.prow{display:flex;align-items:baseline;gap:10px;font-size:13px;padding:3px 0}
.prow b{font-size:22px;letter-spacing:.14em;font-variant-numeric:tabular-nums}
.gerr{min-height:18px;font-size:12.5px;color:var(--no);margin-top:8px}
.gfoot{margin:12px 0 0;font-size:11.5px;color:var(--tx3);line-height:1.5}
/* 发送中的气泡：等 ack 时先占位，收到服务端消息后由真实消息替换（不重复） */
.msg.pending{opacity:.55}
.msg.pending .bubble::after{content:'发送中…';font-size:11px;color:var(--tx3);margin-left:6px}
`;
html = html.replace('</style>', CSS + '</style>');

fs.mkdirSync(path.dirname(OUT), {recursive:true});
fs.writeFileSync(OUT, html);
console.log('✅ 已生成 ' + OUT + '（' + html.length + ' 字节）');

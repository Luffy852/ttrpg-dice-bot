/* ============================================================================
 * ui.js —— 聊天流呈现（★ 呈现一版不动：从 M2 搬来，只换数据来源）
 * ----------------------------------------------------------------------------
 * 【搬了什么】M2 真机验证过的：左右分列、折叠式骰点气泡、快捷按钮只填不执行、
 *   键盘适配三件套（interactive-widget / visualViewport / 聚焦多次重排）。
 * 【换了什么】消息不再由本地引擎产出，而是服务端广播的 payload ——
 *   渲染仍然走 engine.renderMsg()，与单机版**同一个函数**（原则 4）。
 *
 * 【★ 去重在这里】按 msg_id 去重（重连补齐可能重复投递）；服务端那边按 req_id 幂等。
 *   两边都要有 —— 只靠服务端，补齐帧在网络层重复仍会渲染两遍。
 * ========================================================================== */
import * as Engine from '../vendor/engine/index.js';
import {toRenderable} from '../vendor/engine/render-md.js';

/* ★ 气泡时间戳与服务端用**同一个** hhmm（UTC+8），不再各按各的时区渲染。
 * 【之前】这里按浏览器本地时区、服务端（Worker 跑在 UTC）按 UTC —— 同一个房间同一条消息，
 *   .status 里写 08:12、气泡右上角显示 16:12，差 8 小时（真机反馈 · A 组第 1 条）。
 * 【为什么直接 import 而不是照抄】抄一份迟早再次漂移（原则 4）。 */
const hhmm = Engine.hhmm;

export function createUI({code, onSubmit, onExport, onImport}){
  const $ = id => document.getElementById(id);
  const $stream = $('stream'), $input = $('input'), $send = $('send');
  const seen = new Set();
  const pending = new Map();               // req_id → 占位气泡元素
  const st = {rule:'generic', baredice:false, me:'玩家', members:[], code,
    online:0, total:0, msgTotal:null, seqAtWelcome:0};

  /* ---------- 渲染：与单机版同一个 renderMsg ---------- */
  /** 骰娘回复的「回应谁」标记。actor 由服务端写好（core.js），这里只负责显示 */
  function replyTag(m){
    if((m.from || '') !== '骰娘') return '';      // 玩家消息：who 行已是本人昵称，不重复
    const a = m.actor;
    if(!a || a === '骰娘') return '';
    return '<span class="re' + (a === st.me ? ' me' : '') + '">→ ' + Engine.esc(a) + '</span>';
  }
  /* ★ 渲染一条消息，返回 HTML（append 与 prepend 共用，不写两遍 —— 原则 4） */
  function htmlOf(m){
    if(m.kind === 'sys' || m.kind === 'notice') return Engine.renderMsg(toRenderable(m));
    const mine = (m.from && m.from !== '骰娘' && m.from === st.me);
    return '<div class="msg' + (mine ? ' me' : '') + '">' +
      '<div class="av">' + Engine.esc((m.from || '?').slice(0, 1)) + '</div>' +
      '<div class="body"><div class="who">' + Engine.esc(m.from || '?') + replyTag(m) +
      '<span class="ts">' + hhmm(m.ts) + '</span></div>' +
      Engine.renderMsg(toRenderable(m)) + '</div></div>';
  }

  function append(m){
    if(seen.has(m.id)) return false;       // ★ msg_id 去重
    seen.add(m.id);
    /* 新消息使总数 +1；补齐的历史（seq ≤ 进房时的游标）已在 msgTotal 里，不加 */
    if(st.msgTotal != null && m.seq > st.seqAtWelcome) st.msgTotal++;
    if(m.req_id && pending.has(m.req_id)){ pending.get(m.req_id).remove(); pending.delete(m.req_id); }
    $stream.insertAdjacentHTML('beforeend', htmlOf(m));   // ★ 与 prepend 同一份渲染（原则 4）
    toBottom();
    refreshTop();
    return true;
  }

  /** 发送中占位：等 ack/dup 到达后被服务端那条真实消息替换（不会变成两条） */
  function appendPending(reqId, text){
    const wrap = document.createElement('div');
    wrap.className = 'msg me pending';
    wrap.innerHTML = '<div class="av">' + Engine.esc((st.me || '?').slice(0, 1)) + '</div>' +
      '<div class="body"><div class="who">' + Engine.esc(st.me) + '<span class="ts">发送中</span></div>' +
      '<div class="bubble cmd">' + Engine.esc(text) + '</div></div>';
    $stream.appendChild(wrap);
    pending.set(reqId, wrap);
    toBottom();
  }
  function failPending(reqId, why){
    const el = pending.get(reqId);
    if(el){ el.classList.remove('pending'); el.querySelector('.ts').textContent = (why || '未送达'); }
  }
  /** 连接彻底放弃时：把所有还挂着的占位气泡标为未送达，别让用户一直盯着"发送中" */
  function failAll(why){
    pending.forEach((el, id) => {
      el.classList.remove('pending');
      const ts = el.querySelector('.ts');
      if(ts) ts.textContent = (why || '未送达');
    });
  }

  /** ★ 把更早的一页插到**顶部**（真机反馈 · C 组）
   * 【为什么必须保持滚动位置】往上插内容会把可视区往下顶，用户正看着的那条会瞬间跳走 ——
   *   手机上尤其明显。做法：先记插入前的 scrollHeight，插完把差值补回 scrollTop。
   * 【为什么不去重 seen】历史页的消息客户端没渲染过，seen 里没有；插完要登记，
   *   否则之后 ws 又广播同一条（幂等回放）会重复渲染。 */
  function prepend(msgs){
    const before = $stream.scrollHeight, top = $stream.scrollTop;
    /* ★ 必须**整批一次**插入：逐条 afterbegin 会把后一条顶到最前面，
     *   一页 200 条的顺序会整个反过来（真机冒烟抓到的）—— 历史倒着看更让人懵。 */
    let html = '', n = 0;
    msgs.forEach(m => {
      if(seen.has(m.id)) return;
      seen.add(m.id); n++; html += htmlOf(m);
    });
    if(n) $stream.insertAdjacentHTML('afterbegin', html);
    if(n) $stream.scrollTop = top + ($stream.scrollHeight - before);   // ★ 位置保持
    refreshLoadBtn();
    refreshTop();
    return n;
  }

  function toBottom(){ $stream.scrollTop = $stream.scrollHeight; }

  /* ★ 滚到顶自动加载更早的消息（用户已定方案）
   *  【阈值为什么是 60px】手指"滚到底"不会精确到 0；太小会漏触发，太大会在正常阅读时误触发。
   *  【loading 锁】一次只发一个请求，回来前不重复发 —— 否则一屏能连发十几页。 */
  const LOAD_TOP = 60;
  let oldestSeq = null, hasMoreOlder = false, loading = false;
  function onLoadOlder(fn){ loadOlder = fn; }
  let loadOlder = null;
  /* ★ 整个分页状态**一次传对象**，不逐字段传参（真机事故 · D 组第 4 条）
   * 【原写法】ui.setPaging(info.oldest, info.hasMore, info.total) —— 三个位置参数，
   *   而 net.js 里那个字段叫 hasMoreOlder。首屏分支写成了 info.hasMore（undefined），
   *   于是 hasMoreOlder 一直是 false：**入口不出现、滚到顶也不触发**，
   *   而服务端分页完全正常，协议层测试也全绿 —— 因为测试直接调 setPaging，绕开了这层接线。
   * 【为什么改成对象】位置参数 + 两边各起一个名字 = 迟早再错一次。
   *   传对象后，拼错字段名只会变成 undefined（且下面有兜底），不会再"静默什么都不做"。 */
  function setPaging(info){
    const o = info || {};
    if(o.oldest != null) oldestSeq = (oldestSeq == null ? o.oldest : Math.min(oldestSeq, o.oldest));
    if(o.total != null) st.msgTotal = o.total;
    /* ★ 兜底：就算服务端没给 has_more，只要"总数 > 我已渲染的条数"也说明还有更早的。
   *   宁可多给一次入口，也不能让用户面对"明明有 429 条却只能看 204 条"而无路可走。 */
    const more = (o.hasMoreOlder != null) ? !!o.hasMoreOlder
      : (st.msgTotal != null && st.msgTotal > seen.size);
    hasMoreOlder = more;
    refreshLoadBtn();
    refreshTop();
  }
  function maybeLoadOlder(force){
    if(loading || !hasMoreOlder || oldestSeq == null || !loadOlder) return;
    /* ★ force = 点了顶部那个按钮：不能再卡 scrollTop —— 按钮本身就在顶部，
     *   但容器可能还没滚到位，那时会被"不在顶部"拦掉 → 点了没反应
     *   （与"拉到头没反应"是同一类：看不到任何反馈，只会以为功能不存在）。 */
    if(!force && $stream.scrollTop > LOAD_TOP) return;
    loading = true;
    /* ★ 超时解锁：服务端没回声时 loading 会永远卡住，此后再滚到顶也没反应 ——
     *   真机上这表现为"上翻只工作一次然后彻底失灵"，很难联想到是没解锁。 */
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => { if(loading) doneLoadingOlder(true); }, 8000);
    loadOlder(oldestSeq);
  }
  let loadTimer = null;
  function doneLoadingOlder(more){
    loading = false;
    clearTimeout(loadTimer);
    hasMoreOlder = !!more;
    refreshLoadBtn();
    refreshTop();
  }
  /* ★ 顶部可见入口（不替代自动加载，是它的兜底）
   *   滚到顶自动加载在某些浏览器 / 手势下不一定触发，而那时用户**没有任何办法**
   *   拿到更早的历史 —— 只能以为消息丢了。给一个能点的入口，功能就永远有下限。 */
  function refreshLoadBtn(){
    if(!hasMoreOlder || oldestSeq == null){ if($loadBtn){ $loadBtn.remove(); $loadBtn = null; } return; }
    if(!$loadBtn){
      $loadBtn = document.createElement('div');
      $loadBtn.className = 'notice loadbtn';
      $loadBtn.addEventListener('click', () => maybeLoadOlder(true));
      $stream.insertBefore($loadBtn, $stream.firstChild);
    }
    /* ★ 按钮必须始终在最顶：上翻用 afterbegin 插入，会把按钮顶到历史消息下面去 */
    if($stream.firstChild !== $loadBtn) $stream.insertBefore($loadBtn, $stream.firstChild);
    $loadBtn.textContent = loading ? '正在加载更早的消息…' : ('↑ 加载更早的消息（还有 ' + Math.max(0, (st.msgTotal || 0) - seen.size) + ' 条）');
  }
  let $loadBtn = null;
  $stream.addEventListener('scroll', () => { maybeLoadOlder(); }, {passive:true});

  function refreshTop(){
    const rm = Engine.RULE_META[st.rule] || Engine.RULE_META.generic;
    $('p-rule').textContent = rm.short;
    $('p-me').textContent = st.me;
    const bd = $('p-bd');
    bd.textContent = '裸骰 ' + (st.baredice ? '开' : '关');
    bd.classList.toggle('on', st.baredice);
    /* ★「已加载 / 总数」两个都要（用户已定）：只显示已加载条数，房间超过首屏 200 条时
     *   会让人以为历史就这么点；只显示总数，又会与聊天流里的实际条数对不上（A8 那条）。 */
    $('p-cnt').textContent = (st.msgTotal == null || st.msgTotal === seen.size)
      ? (seen.size + ' 条')
      : (seen.size + ' / ' + st.msgTotal + ' 条');
    $('p-room').textContent = '房间 ' + st.code + ' · ' + st.online + ' 人在线' +
      (st.total > st.online ? ('（累计 ' + st.total + '）') : '');
  }

  /* ---------- 事件（一律委托，不逐条挂监听 —— 重连时不会成倍泄漏） ---------- */
  $stream.addEventListener('click', e => {
    const b = e.target.closest('.bubble.dice');
    if(b) b.classList.toggle('open');
  });

  function submit(text){
    text = String(text || '').trim();
    if(!text) return;
    onSubmit && onSubmit(text);
  }
  $send.addEventListener('click', () => { submit($input.value); $input.value = ''; toBottom(); });
  $input.addEventListener('keydown', e => { if(e.key === 'Enter'){ submit($input.value); $input.value = ''; toBottom(); } });
  // 快捷按钮：把指令填进输入框，不直接执行（与单机版一致 —— 保持一致比自作聪明重要）
  document.querySelectorAll('.quick[data-cmd]').forEach(b => {
    b.addEventListener('click', () => { $input.value = b.dataset.cmd; $input.focus(); });
  });
  const $exp = $('btn-export');
  if($exp) $exp.addEventListener('click', () => onExport && onExport());
  /* ★ 导入：按钮 → 触发隐藏的 file 控件 → 选完把**文本**交给上层（不是 File 对象）。
   *   UI 层不认识后端协议，它只负责"把用户选的文件内容拿到手"。 */
  const $imp = $('btn-import'), $file = $('file-import');
  if($imp && $file){
    $imp.addEventListener('click', () => $file.click());
    $file.addEventListener('change', async () => {
      const f = $file.files && $file.files[0];
      if(!f) return;
      try{
        const text = await f.text();
        onImport && onImport(text, f.name);
      }catch(e){ note('读文件失败：' + (e && e.message || e)); }
      /* ★ 清空 value：否则连续导入同一个文件不会再触发 change（第二次像没反应） */
      $file.value = '';
    });
  }

  /* ---------- 键盘适配（M2 真机验证三件套，原样搬） ---------- */
  const vv = window.visualViewport;
  function fit(){
    if(!vv) return;
    document.documentElement.style.setProperty('--app-h', Math.round(vv.height) + 'px');
    document.documentElement.style.setProperty('--vv-top', Math.round(vv.offsetTop) + 'px');
    if(document.activeElement === $input) toBottom();
  }
  if(vv){ vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
  window.addEventListener('resize', fit);
  fit();
  $input.addEventListener('focus', () => {
    [0, 120, 320, 600].forEach(ms => setTimeout(() => { fit(); toBottom(); }, ms));
  });
  $input.addEventListener('blur', fit);

  return {
    append, prepend, appendPending, failPending, failAll, refreshTop, toBottom,
    setPaging, doneLoadingOlder, onLoadOlder,
    setRoom(r){
      if(r.rule) st.rule = r.rule;
      if(r.baredice != null) st.baredice = !!r.baredice;
      if(r.msg_count != null) st.msgTotal = r.msg_count;
      /* ★ 记住"进房时已分配到哪"，用来区分「补齐的历史」与「之后的新消息」：
       *   seq ≤ 它的都已算进 msgTotal（补齐不该重复加），seq > 它的才是新到的，要 +1。 */
      if(r.seq != null) st.seqAtWelcome = r.seq;
      refreshTop();
    },
    setMe(me){ st.me = me; refreshTop(); },
    me(){ return st.me; },      // ★ 供上层比对"顶栏现在显示的昵称是不是最新的我"
    /* ★ 在线人数与累计人次**分开收**：从前只收 members（累计人次）当在线数显示，
     *   一个人反复刷新就一路累加 —— 现在 online 由服务端按 ws 连接数给出。 */
    setMembers(list, online, total){
      st.members = list || [];
      if(online != null) st.online = online;
      if(total != null) st.total = total;
      else st.total = st.members.length;
      refreshTop();
    },
    note(html){ $stream.insertAdjacentHTML('beforeend', '<div class="notice">ⓘ ' + html + '</div>'); toBottom(); },
    clear(){ seen.clear(); $stream.innerHTML = ''; },
    get count(){ return seen.size; },
  };
}

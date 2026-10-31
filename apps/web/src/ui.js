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

export function createUI({code, onSubmit, onExport}){
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
  function append(m){
    if(seen.has(m.id)) return false;       // ★ msg_id 去重
    seen.add(m.id);
    /* 新消息使总数 +1；补齐的历史（seq ≤ 进房时的游标）已在 msgTotal 里，不加 */
    if(st.msgTotal != null && m.seq > st.seqAtWelcome) st.msgTotal++;
    if(m.req_id && pending.has(m.req_id)){ pending.get(m.req_id).remove(); pending.delete(m.req_id); }
    const mine = (m.from && m.from !== '骰娘' && m.from === st.me);
    if(m.kind === 'sys' || m.kind === 'notice'){
      $stream.insertAdjacentHTML('beforeend', Engine.renderMsg(toRenderable(m)));
    }else{
      const wrap = document.createElement('div');
      wrap.className = 'msg' + (mine ? ' me' : '');
      wrap.innerHTML =
        '<div class="av">' + Engine.esc((m.from || '?').slice(0, 1)) + '</div>' +
        '<div class="body"><div class="who">' + Engine.esc(m.from || '?') +
        /* ★ 骰娘的回复必须写明「回应谁」—— 多人房间里一串「骰娘」气泡分不清是谁的指令
         *   换来的结果（真机反馈：UncleMush 未绑卡时的 .st 回复、普通 .r 都一样）。
         *   actor 是服务端落库时就写好的发起人（core.js：actor = m.actor || nick），
         *   广播与补齐两条链路都带它 —— 这里只是把它显示出来，不加任何新字段。 */
        replyTag(m) +
        '<span class="ts">' + hhmm(m.ts) + '</span></div>' +
        Engine.renderMsg(toRenderable(m)) + '</div>';
      $stream.appendChild(wrap);
    }
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

  function toBottom(){ $stream.scrollTop = $stream.scrollHeight; }

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
    append, appendPending, failPending, failAll, refreshTop, toBottom,
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

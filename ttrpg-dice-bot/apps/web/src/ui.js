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
import * as Engine from '../../../packages/engine/src/index.js';
import {toRenderable} from '../../../packages/engine/src/render-md.js';

function hhmm(ts){
  const d = new Date(ts);
  const p = n => (n < 10 ? '0' + n : String(n));
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

export function createUI({code, onSubmit, onExport}){
  const $ = id => document.getElementById(id);
  const $stream = $('stream'), $input = $('input'), $send = $('send');
  const seen = new Set();
  const pending = new Map();               // req_id → 占位气泡元素
  const st = {rule:'generic', baredice:false, me:'玩家', members:[], code};

  /* ---------- 渲染：与单机版同一个 renderMsg ---------- */
  function append(m){
    if(seen.has(m.id)) return false;       // ★ msg_id 去重
    seen.add(m.id);
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

  function toBottom(){ $stream.scrollTop = $stream.scrollHeight; }

  function refreshTop(){
    const rm = Engine.RULE_META[st.rule] || Engine.RULE_META.generic;
    $('p-rule').textContent = rm.short;
    $('p-me').textContent = st.me;
    const bd = $('p-bd');
    bd.textContent = '裸骰 ' + (st.baredice ? '开' : '关');
    bd.classList.toggle('on', st.baredice);
    $('p-cnt').textContent = seen.size + ' 条';
    $('p-room').textContent = '房间 ' + st.code + (st.members.length ? (' · ' + st.members.length + ' 人') : '');
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
    append, appendPending, failPending, refreshTop, toBottom,
    setRoom(r){ if(r.rule) st.rule = r.rule; if(r.baredice != null) st.baredice = !!r.baredice; refreshTop(); },
    setMe(me){ st.me = me; refreshTop(); },
    setMembers(list){ st.members = list || []; refreshTop(); },
    note(html){ $stream.insertAdjacentHTML('beforeend', '<div class="notice">ⓘ ' + html + '</div>'); toBottom(); },
    clear(){ seen.clear(); $stream.innerHTML = ''; },
    get count(){ return seen.size; },
  };
}

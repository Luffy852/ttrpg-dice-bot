/* ============================================================================
 * main.js —— 前端入口：进房 → 连 ws → 收消息
 * ----------------------------------------------------------------------------
 * 【进房三步】创建/拿号 → join 拿 token → 连 ws（token 只在 ws 握手时校验一次）
 * 【★ token 存 sessionStorage】标签页级：刷新不重输、关页即失效、换设备仍需 PIN ——
 *   这是已定决策（PIN 固化后，token 的生命周期决定了"要不要再输一次 PIN"）。
 * 【★ PIN 是唯一一次展示】创建成功页把房间号与口令**分开**显示 —— 截图时极易只截到一个，
 *   漏看即永久锁死（无账号体系，无法验证创建人身份）。
 * ========================================================================== */
import {createNet} from './net.js';
import {createUI} from './ui.js';

const $ = id => document.getElementById(id);
const store = {
  get(k){ try{ return sessionStorage.getItem(k); }catch(e){ return null; } },
  set(k, v){ try{ sessionStorage.setItem(k, v); }catch(e){} },
  del(k){ try{ sessionStorage.removeItem(k); }catch(e){} },
};
const api = async (path, body) => {
  const r = await fetch(path, body ? {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)} : undefined);
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
};

let net = null, ui = null, room = null;    // room = {code, token, nick}

function showApp(){
  $('gate').hidden = true;
  $('app').hidden = false;
}
function showGate(err){
  if(net){ net.close(); net = null; }
  $('gate').hidden = false;
  $('app').hidden = true;
  if(err) $('g-err').textContent = err;
}

/** 连房间：UI 与 net 在这里组装 */
function enter(r){
  room = r;
  showApp();
  try{ history.replaceState(null, '', '?code=' + r.code); }catch(e){}
  ui = createUI({
    code:r.code,
    onSubmit(text){
      const reqId = net.send(text);
      ui.appendPending(reqId, text);
    },
    onExport(){
      location.href = '/api/room/' + room.code + '/export?format=md&token=' + encodeURIComponent(room.token);
    },
  });
  ui.setMe(r.nick);
  net = createNet({
    code:r.code, token:r.token, nick:r.nick,
    on:{
      open(){ ui.note('已连接 · 房间 <b>' + r.code + '</b>'); },
      close(){ ui.note('连接断开，正在重连…（已发的指令不会重复掷）'); },
      welcome(f){ ui.setRoom(f.room); ui.setMe(f.you.nick); ui.setMembers(f.members); },
      batch(msgs){ msgs.forEach(m => ui.append(m)); },
      state(s){ ui.setRoom(s); },                    // ★ 以后端为准回写，不乐观更新
      presence(list){ ui.setMembers(list); },
      ack(){ /* 真实消息由 batch 到达；占位气泡到那时才移除 */ },
      dup(reqId){ /* 重试命中幂等：不发第二颗骰，占位气泡等 batch 里那条 */ },
      reject(reqId, code){
        ui.failPending(reqId, code === 'rate_limited' ? '太密了，慢一点' :
          (code === 'too_long' ? '指令太长（≤400 字）' : '未送达'));
      },
      error(code){
        if(code === 'bad_token' || code === 'expired'){
          store.del('db:room:' + r.code);
          showGate('登录已失效，请重新进入房间');
        }
      },
    },
  });
  net.connect();
}

async function doJoin(code, nick, pin){
  const j = await api('/api/room/' + code + '/join', {nick, pin:pin || undefined});
  store.set('db:room:' + code, JSON.stringify({token:j.token, nick}));
  enter({code, token:j.token, nick});
}

/* ---------- 进房页交互 ---------- */
function bindGate(){
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
      t.classList.add('on');
      const isNew = t.dataset.tab === 'new';
      $('g-new').hidden = !isNew;
      $('g-join').hidden = isNew;
      $('g-err').textContent = '';
    });
  });
  $('g-usepin').addEventListener('change', e => { $('g-newpin').hidden = !e.target.checked; });

  $('g-join-btn').addEventListener('click', async () => {
    const code = ($('g-code').value || '').trim();
    const nick = ($('g-nick').value || '').trim() || '玩家';
    if(!/^\d{6}$/.test(code)) return ($('g-err').textContent = '房间号是 6 位数字');
    try{ await doJoin(code, nick, $('g-pin').value); }
    catch(e){ $('g-err').textContent = (e.message === 'bad_pin' ? '口令不对' : (e.message === 'no_room' ? '房间不存在或已过期' : ('进不去：' + e.message))); }
  });

  $('g-new-btn').addEventListener('click', async () => {
    const nick = ($('g-nick2').value || '').trim() || '玩家';
    if($('g-usepin').checked){
      const p1 = ($('g-pin1').value || '').trim(), p2 = ($('g-pin2').value || '').trim();
      if(!/^\d{4}$/.test(p1)) return ($('g-err').textContent = '口令是 4 位数字');
      if(p1 !== p2) return ($('g-err').textContent = '两次输入的口令不一致');
      try{
        const j = await api('/api/room', {pin:p1});
        $('c-code').textContent = j.code;
        $('c-pin').textContent = p1;
        $('g-created').hidden = false;
        $('g-new').hidden = true;
        $('created-code') && 0;
        window.__pending = {code:j.code, nick, pin:p1};
      }catch(e){ $('g-err').textContent = '创建失败：' + e.message; }
    }else{
      try{
        const j = await api('/api/room', {});
        window.__pending = {code:j.code, nick, pin:null};
        await doJoin(j.code, nick, null);
      }catch(e){ $('g-err').textContent = '创建失败：' + e.message; }
    }
  });

  $('c-go').addEventListener('click', async () => {
    const p = window.__pending || {};
    try{ await doJoin(p.code, p.nick, p.pin); }
    catch(e){ $('g-err').textContent = '进不去：' + e.message; }
  });
}

export function boot(){
  bindGate();
  const code = (new URLSearchParams(location.search).get('code') || '').trim();
  if(!code || !/^\d{6}$/.test(code)) return showGate();
  const saved = store.get('db:room:' + code);
  if(!saved) return showGate();
  let s = null; try{ s = JSON.parse(saved); }catch(e){}
  if(!s || !s.token) return showGate();
  enter({code, token:s.token, nick:s.nick || '玩家'});
}

if(typeof document !== 'undefined'){
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

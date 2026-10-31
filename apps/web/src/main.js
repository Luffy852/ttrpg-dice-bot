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
/* ★ 长期身份键（真机反馈 · B 组）★
 * 【问题】关掉页面再进来，服务端现发一个新的 anon_id —— 角色卡、昵称全丢，
 *   玩家以为"绑了却读不出来"。而跑团一次 2–4 小时，中途切出去再回来很常见。
 * 【做法】本机 localStorage 存一个 cid，每次 /join 带上；服务端按它找回同一个 anon_id。
 * 【为什么是 localStorage 而不是 sessionStorage】sessionStorage 关标签页就清，
 *   解决不了"关页重进"。cid 只在本机、不含任何个人信息，换设备仍然是新身份。
 * 【与 PIN 的关系】PIN 校验在服务端先过，不知道 PIN 的人拿不到 token，
 *   也就无从用 cid 恢复身份 —— 防误入口径没有变松。 */
/* ★ 键名叫 db:me 不叫 db:cid：net.js 里还有一个 clientId（req_id 的前缀），
 *   那个**必须**每次刷新都变（否则重连补历史时 req_id 会撞车），
 *   两者概念相反却都叫 cid —— 迟早有人把这一个也做成"每次刷新重新生成"。 */
const CID_KEY = 'db:me';
const NICK_KEY = 'db:nick';      // ★ 记住上次用过的昵称，关页重进不用重填（否则会以"玩家"身份进房）
function myCid(){
  try{
    let c = localStorage.getItem(CID_KEY);
    if(!c){
      c = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2))
        .replace(/[^A-Za-z0-9_-]/g, '');
      localStorage.setItem(CID_KEY, c);
    }
    return c;
  }catch(e){ return ''; }      // 隐私模式下 localStorage 可能不可写 → 退化为"每次新身份"，不报错
}
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
  /* ★ 上翻加载：UI 滚到顶时回调这里，向服务端要这一页更早的消息。
   *   锚点是"当前已渲染的最小 seq"（不是 cursor —— cursor 是最新水位）。 */
  ui.onLoadOlder(oldestSeq => { net.history(oldestSeq); });
  net = createNet({
    code:r.code, token:r.token, nick:r.nick,
    on:{
      open(){ ui.note('已连接 · 房间 <b>' + r.code + '</b>'); },
      close(wait, n, why){
        // ★ 把关闭码显示出来：排查"连不上"时，这一个数字能区分
        //   "握手根本没建立"（1006）与"连上后又被服务端踢掉"（1008/1011）
        const tag = (why && why.code != null) ? ('（关闭码 ' + why.code + (why.reason ? ' · ' + why.reason : '') + '）') : '';
        ui.note('连接断开，正在重连…（第 ' + n + ' 次' + tag + '）已发的指令不会重复掷');
      },
      giveup(){
        ui.note('<b>连不上房间了</b>：请刷新页面重试。若反复如此，房间可能已过期（消息只保留 30 天）。');
        ui.failAll && ui.failAll('未送达');
      },
      welcome(f){ ui.setRoom(f.room); ui.setMe(f.you.nick); ui.setMembers(f.members, f.online, f.total); },
      /* ★ 三种 batch 走三条路：
       *   first = 首屏（最近 200 条）→ 记下分页锚点；page = 上翻 → 插到顶部；live = 广播 → 追加到底。
       *   不分清的话，上翻拿到的历史会被当成新消息追加到**底部** —— 顺序全乱。 */
      batch(msgs, cursor, hasMore, info){
        const w = (info && info.why) || 'live';
        if(w === 'page'){
          ui.prepend(msgs);
          ui.doneLoadingOlder(!!(info && info.hasMoreOlder));
          ui.setPaging(info && info.oldest, info && info.hasMoreOlder, null);
        }else{
          msgs.forEach(m => ui.append(m));
          if(w === 'first') ui.setPaging(info && info.oldest, info && info.hasMore, info && info.total);
        }
      },
      state(s){ ui.setRoom(s); },                    // ★ 以后端为准回写，不乐观更新
      presence(list, online, total){ ui.setMembers(list, online, total); },
      ack(){ /* 真实消息由 batch 到达；占位气泡到那时才移除 */ },
      /* ★ dup 帧**不带 batch**，所以绝对不能"什么都不做"地干等 ——
         占位气泡会永远停在"发送中"。正常路径下 batch 会先到、pending 那时已被移除，
         能走到这里说明前端确实没渲染过这条（典型：刷新后 req_id 与历史撞车）。
         明确告知，让用户知道发生了什么，而不是对着"发送中"干等。 */
      dup(reqId, seq, deleted){
        ui.failPending(reqId, deleted ? '这条已被清理' : '已掷过（重复请求）');
      },
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
  /* ★ nick 为空就传 null：服务端据此判断"这次没填昵称" ——
   *   否则前端的默认"玩家"会把你**真正的昵称覆盖掉**（关页重进一次就变回"玩家"）。 */
  const j = await api('/api/room/' + code + '/join', {nick:nick || null, pin:pin || undefined, cid:myCid()});
  /* ★ 用服务端返回的 nick：找回老身份时它可能与我在表单里填的不同，
   *   而它才是房间里公认的那个我（与 .status / 成员列表同源）。 */
  const myNick = j.nick || nick || '玩家';
  try{ localStorage.setItem(NICK_KEY, myNick); }catch(e){}
  store.set('db:room:' + code, JSON.stringify({token:j.token, nick:myNick}));
  enter({code, token:j.token, nick:myNick});
}

/* ---------- 进房页交互 ---------- */
function bindGate(){
  /* ★ 预填上次用过的昵称：不预填的话用户偷懒直接输房间号就进了，
   *   于是本地是"玩家"、服务端记得你是"战斗菇" —— 自己的消息会显示在左边。 */
  try{ if(!$('g-nick').value && localStorage.getItem(NICK_KEY)) $('g-nick').value = localStorage.getItem(NICK_KEY); }catch(e){}
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

/* ============================================================================
 * auth.js —— 房间 PIN 与进房 token（Web Crypto，Worker 与 node 都能跑）
 * ----------------------------------------------------------------------------
 * 【★ 三条硬规矩（都是档案里已定的，别自己发挥）】
 *   ① **PIN 只存 HMAC 摘要，不存明文** —— 静态资源与 DO 状态都可能暴露
 *   ② **PIN 创建即固化**，不可修改、不可找回 —— 所以创建页必须显著展示（room.js 负责展示，
 *      这里只保证：校验是常数时间比较，不泄露"第几位错了"）
 *   ③ **4 位 PIN 只有 10⁴ 组合，是防误入不是防攻击** —— 所以校验失败必须限流
 *      （限流由 core.js 的令牌桶 / DO 侧计数器做，这里只提供校验）
 *
 * 【token】进房校验通过后签发，含 code / anon_id / exp，HMAC 签名。
 *   存 sessionStorage（标签页级）：刷新不重输、关页即失效、换设备仍需 PIN。
 * ========================================================================== */

const enc = new TextEncoder();
const b64u = ab => btoa(String.fromCharCode(...new Uint8Array(ab)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function key(secret){
  return crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
}
async function hmac(secret, msg){
  return b64u(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(msg)));
}
/** 常数时间比较（防计时侧信道；PIN 只有 10⁴ 组合，值得做） */
function safeEq(a, b){
  const A = String(a), B = String(b);
  let d = A.length ^ B.length;
  for(let i = 0; i < Math.max(A.length, B.length); i++) d |= (A.charCodeAt(i) || 0) ^ (B.charCodeAt(i) || 0);
  return d === 0;
}

/** PIN 摘要：room 级 salt + 全局 secret，存 pin_hmac / pin_salt 两列 */
export async function hashPin(pin, salt, secret){
  return hmac(secret, 'pin:' + salt + ':' + pin);
}
export async function verifyPin(pin, salt, expect, secret){
  if(!expect) return {ok:false, why:'no_pin'};
  const got = await hashPin(pin, salt, secret);
  return {ok:safeEq(got, expect)};
}
export const newSalt = () => b64u(crypto.getRandomValues(new Uint8Array(12)));

/** token：base64url(payload).sig —— 不加密，只签名（内容无秘密，防的是伪造） */
export async function signToken(payload, secret){
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return body + '.' + (await hmac(secret, body));
}
export async function verifyToken(token, secret){
  if(typeof token !== 'string' || token.indexOf('.') < 0) return {ok:false, why:'bad_token'};
  const i = token.indexOf('.');
  const body = token.slice(0, i), sig = token.slice(i + 1);
  if(!safeEq(sig, await hmac(secret, body))) return {ok:false, why:'bad_token'};
  let p;
  try{ p = JSON.parse(new TextDecoder().decode(fromB64u(body))); }
  catch(e){ return {ok:false, why:'bad_token'}; }
  if(!p.exp || p.exp < Date.now() / 1000) return {ok:false, why:'expired'};
  return {ok:true, payload:p};
}
export const TOKEN_TTL = 12 * 3600;    // 12 小时：一场跑团 2–4 小时，留足余量

/** 6 位数字房间号：★ 必然可枚举（10⁶），开放房间靠"号码不公开"这一层，不是靠不可枚举 */
export function newCode(){
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
}
export const isCode = s => /^\d{6}$/.test(String(s || ''));
export const isPin  = s => /^\d{4}$/.test(String(s || ''));

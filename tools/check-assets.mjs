/* ============================================================================
 * check-assets.mjs —— 前端静态资源可达性自检（★ 部署踩坑后新增）
 * ----------------------------------------------------------------------------
 * 【为什么要有这个 —— 这次是真的栽过】
 *   首轮部署后"页面能打开，但点创建房间没反应"。根因：前端用
 *   `../../../packages/engine/src/index.js` 引用引擎，而 Cloudflare 的
 *   Static Assets **只托管 apps/web 一个目录** —— 浏览器去请求 `/packages/...`
 *   拿到 404（SPA 模式下还返回 HTML，MIME 也不对），整个 ES 模块图加载失败，
 *   main.js 一行都没执行，于是所有按钮都没绑上事件。
 *
 *   **为什么沙盒没抓到**：dom_smoke.js 用 Node 按**文件系统路径** import，
 *   `../../../packages/...` 在磁盘上真实存在，所以那条路全绿 ——
 *   沙盒验的是"代码对不对"，验不了"浏览器能不能取到这个文件"。
 *   本脚本补的就是这一层：**把前端当作 HTTP 目录，逐条 import 解析成 URL 再查存在性**。
 *
 * 【怎么用】 node tools/check-assets.mjs
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps', 'web');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if(c) pass++; else { fail++; console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } };

/* 相对 apps/web 的"文件 → URL"映射：目录里每个 .js/.html 都可被请求 */
function toUrl(file){ return '/' + path.relative(WEB, file).split(path.sep).join('/'); }

/** 把 import 的裸路径按浏览器规则解析成 URL */
function resolveUrl(fromFile, spec){
  if(spec.startsWith('/')) return spec;                 // 绝对路径
  if(!spec.startsWith('.')) return null;               // 裸模块名（本项目不用）
  const dir = path.dirname(fromFile);
  return toUrl(path.resolve(dir, spec));
}

function walk(dir, out = []){
  for(const e of fs.readdirSync(dir, {withFileTypes:true})){
    const p = path.join(dir, e.name);
    if(e.isDirectory()){ if(e.name === 'node_modules') continue; walk(p, out); }
    else if(/\.(js|mjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

console.log('== ① 前端引用的每个模块，浏览器都能取到 ==');
{
  if(!fs.existsSync(path.join(WEB, 'index.html'))){
    ok('apps/web/index.html 存在', false); process.exit(1);
  }
  const files = walk(WEB);
  let checked = 0;
  for(const f of files){
    const src = fs.readFileSync(f, 'utf8');
    const specs = [];
    // <script type="module" src="…">
    for(const m of src.matchAll(/<script[^>]*\ssrc\s*=\s*"([^"]+)"/g)) specs.push({spec:m[1], kind:'script'});
    // import … from '…'
    for(const m of src.matchAll(/(?:^|[\s;])import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) specs.push({spec:m[1], kind:'import'});
    for(const m of src.matchAll(/import\s*['"]([^'"]+)['"]/g)) specs.push({spec:m[1], kind:'import'});
    for(const m of src.matchAll(/export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g)) specs.push({spec:m[1], kind:'re-export'});

    for(const {spec, kind} of specs){
      const url = resolveUrl(f, spec);
      if(url === null) continue;                        // 裸模块名，不适用
      // ★ 关键：不许引用 assets 目录之外（那样浏览器一定取不到）
      const escaped = path.resolve(path.dirname(f), spec);
      const inside = escaped.startsWith(WEB + path.sep) || escaped === WEB;
      ok('★ ' + path.relative(ROOT, f) + ' 的 ' + kind + ' 没有越出 apps/web（' + spec + '）', inside,
        '解析到 ' + escaped + ' —— 浏览器会请求 ' + url + '，而 assets 只托管 apps/web');
      if(inside){
        ok('★ ' + kind + ' 目标文件存在（' + url + '）', fs.existsSync(escaped), spec);
      }
      checked++;
    }
  }
  ok('确实扫到了引用（不是空跑）', checked > 10, 'checked=' + checked);
  console.log('（共校验 ' + checked + ' 条引用）');
}

console.log('== ② vendor 与 packages 一致（防漂移）==');
{
  const pairs = [
    [path.join(ROOT, 'packages', 'engine', 'src'), path.join(WEB, 'vendor', 'engine')],
    [path.join(ROOT, 'packages', 'protocol', 'src'), path.join(WEB, 'vendor', 'protocol')],
  ];
  for(const [from, to] of pairs){
    const a = fs.readdirSync(from).filter(f => f.endsWith('.js')).sort();
    if(!fs.existsSync(to)){ ok('vendor 已生成：' + path.basename(to), false); continue; }
    const b = fs.readdirSync(to).filter(f => f.endsWith('.js')).sort();
    ok('★ vendor/' + path.basename(to) + ' 文件齐全', JSON.stringify(a) === JSON.stringify(b),
      '源 ' + a.length + ' 个 / vendor ' + b.length + ' 个');
    const diff = a.filter(f => {
      const x = fs.readFileSync(path.join(from, f), 'utf8');
      const y = fs.existsSync(path.join(to, f)) ? fs.readFileSync(path.join(to, f), 'utf8') : '';
      return x !== y;
    });
    ok('★ vendor/' + path.basename(to) + ' 内容与源逐字节一致', diff.length === 0,
      '不一致：' + diff.join(',') + ' —— 请跑 npm run build:web 重新同步');
  }
}

console.log('== ③ 前端不引用后端源码、不含密钥 ==');
{
  const files = walk(WEB);
  const bad = files.filter(f => /from\s+['"][^'"]*worker\/src/.test(fs.readFileSync(f, 'utf8')));
  ok('★ 前端不引用 apps/worker 下的后端源码', bad.length === 0, bad.map(f => path.relative(ROOT, f)).join(','));
  const secret = files.filter(f => /PIN_SECRET/.test(fs.readFileSync(f, 'utf8')));
  ok('★ 前端不含 PIN_SECRET', secret.length === 0, secret.map(f => path.relative(ROOT, f)).join(','));
}

console.log('---------------------------');
console.log('静态资源自检：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail === 0) console.log('（前端在浏览器里取得到它引用的每一个模块 —— 这是"点按钮没反应"那类坑的唯一防线）');
process.exit(fail ? 1 : 0);

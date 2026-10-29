/* index.js — 引擎唯一入口（浏览器与 Worker 共用这一份）。
 * ★ export 顺序 = 别名注册顺序，不可随意调整：ESM 下模块求值顺序 = import 顺序，
 *   而 registerAliases() 是「先到先得」——顺序变了会让某个别名被别的包静默抢走。
 *   tools/check-engine-split.js 第 5 项守着这条。
 */
export * from './util.js';
export * from './rng.js';
export * from './alias.js';
export * from './rules.js';
export * from './domains.js';
export * from './parse.js';
export * from './roll.js';
export * from './dnd.js';
export * from './coc.js';
export * from './dh.js';
export * from './fu.js';
export * from './pack_generic.js';
export * from './pack_dnd.js';
export * from './pack_coc.js';
export * from './pack_dh.js';
export * from './pack_fu.js';
export * from './packs.js';
export * from './view.js';
export * from './render.js';
export * from './help.js';
export * from './card.js';
export * from './cmd.js';
export * from './replay.js';
export * from './render-md.js';

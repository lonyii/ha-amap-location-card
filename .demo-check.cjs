/* demo.html 静态自检：解析 HTML，确保内联脚本里引用的每个 DOM id 都真实存在，
 * 并确认卡片脚本路径正确。不执行模块（jsdom 不支持 type=module）。
 * 运行： node .demo-check.cjs */
const fs = require('fs');
const path = require('path');
process.env.NODE_PATH = 'C:/Users/lonyi/.workbuddy/binaries/node/workspace/node_modules';
require('module').Module._initPaths();
const { JSDOM } = require('jsdom');

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'demo.html'), 'utf8');
const dom = new JSDOM(html);
const doc = dom.window.document;

let pass = 0, fail = 0;
const out = [];
const ok = (n, c, e) => { c ? (pass++, out.push(`  PASS  ${n}`)) : (fail++, out.push(`  FAIL  ${n}${e !== undefined ? '  → ' + JSON.stringify(e) : ''}`)); };

/* 1. 所有 getElementById 引用的 id 必须存在 */
const ids = new Set(Array.from(doc.querySelectorAll('[id]')).map((e) => e.id));
const script = Array.from(doc.querySelectorAll('script')).map((s) => s.textContent).join('\n');
const refs = [...new Set([...script.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]))];
ok(`内联脚本引用了 ${refs.length} 个 DOM id`, refs.length > 20, refs.length);
const missing = refs.filter((id) => !ids.has(id));
ok('所有引用的 id 都存在', missing.length === 0, missing);

/* 2. 卡片模块路径可解析 */
const importMatch = script.match(/import\(['"](.+?)['"]\)/);
ok('存在动态 import 卡片模块', !!importMatch, importMatch && importMatch[1]);
if (importMatch) {
  const p = path.resolve(dir, importMatch[1]);
  ok('卡片模块文件存在', fs.existsSync(p), p);
}

/* 3. 关键控件齐全 */
['mockOn', 'amapKey', 'securityCode', 'realMap', 'viewMode', 'coordSys', 'mapHeight', 'height', 'radius', 'radiusMode',
 'basemap', 'forceWebgl', 'fallbackTiles', 'theme', 'haDark',
 'radiusBasis', 'radiusPad', 'effRadius', 'showCharging',
 'showToilet', 'coordTtl', 'poiTtl', 'refreshInterval',
 'mockEmpty', 'mockError', 'mockSlow', 'mockConvertFail', 'mockConvertLimit', 'mockConvertBad', 'noCoords',
 'apply', 'move', 'cruise', 'clearLog', 'card-host', 'log',
 'sReq', 'sHit', 'sErr', 'sMove'].forEach((id) => {
  ok(`控件 #${id} 存在`, ids.has(id));
});

/* 3a-2. buildConfig 必须把坐标系开关传给卡片 */
ok('demo 把 coord_sys 传给卡片', /coord_sys:\s*document\.getElementById\('coordSys'\)\.value/.test(script));

/* 3a-3. 夜间主题：配置要传下去，且能只靠 hass 实时切换（不重建卡片） */
ok('demo 把 theme 传给卡片', /theme:\s*document\.getElementById\('theme'\)\.value/.test(script));
ok('demo 的 hass 带 themes.darkMode（模拟 HA 深色）', /themes:\s*\{\s*darkMode:/.test(script));
ok('勾选 HA 深色只推 hass、不重建卡片',
  /hass\.themes\.darkMode = e\.target\.checked;[\s\S]{0,160}card\.hass = hass/.test(script));

/* 3b. 测试页默认已经填好用户的 Key，开箱即可用 */
const keyInput = doc.getElementById('amapKey');
ok('高德 Key 输入框已预填', !!keyInput && /^[0-9a-f]{32}$/.test(keyInput.getAttribute('value') || ''),
  keyInput && keyInput.getAttribute('value'));

/* 3c. 测试坐标位于南昌市青山湖区（WGS-84 约 115.98, 28.64） */
const startMatch = script.match(/const start = \{ lat: ([\d.]+), lon: ([\d.]+) \}/);
ok('能解析出测试实体坐标', !!startMatch);
if (startMatch) {
  const lat = Number(startMatch[1]);
  const lon = Number(startMatch[2]);
  ok('测试坐标落在南昌青山湖区范围内', lat > 28.55 && lat < 28.80 && lon > 115.85 && lon < 116.05, [lat, lon]);
}
ok('Mock POI 名称已本地化到南昌青山湖', html.includes('南昌市青山湖区') && html.includes('青山湖'));

/* 4. 页面里没有遗留的 TODO / 占位符 */
ok('无 TODO 占位', !/\bTODO\b|\bFIXME\b|xxx-xxx/.test(html));

/* 5. 关键行为字符串存在 */
ok('设置了 Mock 钩子', html.includes('__ALC_MOCK__'));
ok('拦截了 restapi.amap.com', html.includes('restapi.amap.com'));
ok('拦截了 window.open', /window\.open\s*=/.test(html));

/* 6. script 上必须带 type=module（动态 import 才合法） */
const modScript = Array.from(doc.querySelectorAll('script[type="module"]'));
ok('存在 type=module 的内联脚本', modScript.length === 1, modScript.length);

/* 7. demo 里 buildConfig() 产出的每个 key 都必须是卡片认识的配置项 */
const cardSrc = fs.readFileSync(path.join(dir, 'amap-location-card.js'), 'utf8');
const defaultsBlock = cardSrc.match(/const ALC_DEFAULTS = \{([\s\S]*?)\n\};/);
ok('能解析出卡片默认配置', !!defaultsBlock);
const knownKeys = new Set(
  (defaultsBlock ? defaultsBlock[1] : '')
    .split('\n')
    .map((l) => (l.match(/^\s{2}([a-z_0-9]+)\s*:/) || [])[1])
    .filter(Boolean)
);
ok(`卡片共有 ${knownKeys.size} 个配置项`, knownKeys.size > 30, knownKeys.size);

const fnBody = (script.match(/function buildConfig\(\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
ok('能解析出 demo 的 buildConfig()', fnBody.length > 0);
const demoKeys = [...new Set([...fnBody.matchAll(/^\s{4}([a-z_0-9]+)\s*:/gm)].map((m) => m[1]))];
ok(`demo 配置了 ${demoKeys.length} 个字段`, demoKeys.length > 15, demoKeys.length);
const unknown = demoKeys.filter((k) => k !== 'type' && !knownKeys.has(k));
ok('demo 没有拼错的配置项', unknown.length === 0, unknown);

/* 8. demo 覆盖了需求里的关键开关 */
['show_charging', 'show_toilet', 'radius_mode', 'radius', 'auto_radius_pad',
 'auto_radius_basis', 'coord_cache_ttl', 'refresh_interval']
  .forEach((k) => ok(`demo 暴露开关 ${k}`, demoKeys.indexOf(k) >= 0 || fnBody.indexOf(k) >= 0));
ok('demo 不再暴露电价 / 可用桩数开关',
  demoKeys.indexOf('show_charging_price') < 0 && demoKeys.indexOf('show_charging_available') < 0
  && !/showPrice|showAvail/.test(html));

/* 8b. demo 必须能让验收者亲眼看到「结果有没有跑到图外」 */
ok('demo 实时显示落在图外的结果条数', /条在框外/.test(script) && /_pinInView/.test(script));
ok('demo 说明了内切 / 外接两种取法的差别', /内切半径/.test(html) && /外接半径/.test(html));

/* 8c. heading 朝向箭头的验收入口 */
ok('demo 提供朝向 heading 输入框', /id="heading"/.test(html) && /syncHeading/.test(script));
ok('朝向改的是实体属性并实时推送 hass（不重建卡片）', /addEventListener\('input'/.test(script) && /card\.hass = hass/.test(script));

/* 9. 坐标转换在 Mock 模式下应透传真实高德，保证与真实底图对齐 */
ok('坐标转换支持透传真实接口', /透传真实高德/.test(script));
ok('周边检索仍走 Mock 拦截', /buildChargingPois/.test(script) && /buildToiletPois/.test(script));

/* 10. 双击（file://）打开时浏览器会拦截 ES module 导入 → 卡片必须能当普通脚本加载。
 *     前提是卡片本体里没有顶层 import / export 语句。 */
ok('卡片不含顶层 import/export（保证可退化为普通脚本）',
  !/^\s*(import|export)\b/m.test(cardSrc));
ok('demo 提供了普通脚本加载回退', /改用普通脚本加载/.test(script));

/* 11. jsdom 不会执行 type=module 的内联脚本，所以这里单独做一次语法解析，
 *     避免 demo 页交付出「一打开就 SyntaxError」的脚本。 */
const modSrc = (modScript[0] && modScript[0].textContent) || '';
let syntaxErr = null;
try { new Function(modSrc); } catch (e) { syntaxErr = e.message; }
ok('内联模块脚本语法合法', !syntaxErr, syntaxErr);
ok('内联模块脚本非空', modSrc.length > 3000, modSrc.length);

/* 12. 底图加载失败的可排查性：脚本加载失败必须被捕获并写进右侧日志，
 *     且启动时要探一次底图域名（区分「网络不通」与「脚本被拦截」）。 */
ok('demo 捕获底图脚本加载失败并写日志', /高德 JS API 脚本加载失败/.test(script));
ok('脚本失败日志里会对 Key 打码', /replace\(\/key=/.test(script));
ok('demo 启动时探测底图域名可达性', /webapi\.amap\.com 可达/.test(script) && /不可达/.test(script));
ok('探测使用 no-cors（与 script 不受 CORS 约束的语义一致）', /mode: 'no-cors'/.test(script));
ok('资源错误监听挂在 capture 阶段（否则拿不到 target.src）', /\}, true\);/.test(script));

console.log('\n=== demo.html 静态自检 ===');
console.log(out.join('\n'));
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

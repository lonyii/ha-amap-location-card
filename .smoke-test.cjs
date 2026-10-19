/* 冒烟测试：在 Node 中桩掉浏览器全局，加载卡片源码并验证核心数据管道。
 * 运行： node .smoke-test.cjs
 * 仅用于开发验证，不随卡片发布。 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/* ---------------- 浏览器环境桩 ---------------- */
const noop = () => {};
const fakeEl = () => ({
  style: {}, dataset: {}, classList: { add: noop, remove: noop },
  children: [], innerHTML: '', textContent: '', hidden: false,
  appendChild: noop, removeChild: noop, setAttribute: noop, removeAttribute: noop,
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  getContext: () => null,
  setPointerCapture: noop,
  closer: null,
});
global.HTMLElement = class {
  attachShadow() {
    return {
      innerHTML: '', addEventListener: noop, removeEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [], appendChild: noop,
    };
  }
  addEventListener() {} removeEventListener() {}
};
global.window = { devicePixelRatio: 1, addEventListener: noop };
global.document = {
  createElement: fakeEl,
  head: { appendChild: noop },
  addEventListener: noop,
};
global.customElements = { get: () => undefined, define: noop, whenDefined: () => Promise.resolve() };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.ResizeObserver = class { observe() {} disconnect() {} };

/* ---------------- 加载被测源码 ---------------- */
const SRC = path.join(__dirname, 'amap-location-card.js');
const code = fs.readFileSync(SRC, 'utf8') + `
globalThis.__T = {
  toNum, clamp, escapeHtml, haversine, formatDistance, metersPerPixel,
  lonToWorldX, latToWorldY, worldXToLon, worldYToLat,
  TtlCache, RateLimiter, AmapWebApi, AmapError, friendlyAmapInfo, amapLoader,
  normalizePoi, buildPoiView, parseLngLat,
  readEntityLocation, iconHtml,
  buildMarkerUrl, buildNavigationUrl, convertToGcj02, ALC_DEFAULTS,
  getSharedApi, ALC_API_REGISTRY,
  parseConvertedLocation, isValidLngLat, ALC_AMAP_INFOCODE, ALC_GCJ_MAX_SHIFT, inChinaBbox,
  ALC_CHINA_BBOX,
  probeAmapHost, diagnoseJsApiFailure, AMAP_JS_API_HOST, ALC_EDITOR_SECTIONS,
  parseMapHeight, cssHeightToPx, isWebGLError,
  normalizeHeading, headingChanged, AmapLocationCard,
  resolveDarkTheme, effectiveMapStyle, ALC_NIGHT_MAP_STYLE,
};
`;
const tmp = path.join(os.tmpdir(), `alc-smoke-${Date.now()}.cjs`);
fs.writeFileSync(tmp, code);
require(tmp);
const T = globalThis.__T;

/* ---------------- 极简断言 ---------------- */
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`); }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================= */
(async function main() {
  console.log('\n=== 1. 实体坐标读取与校验 ===');
  const hass = {
    states: {
      'device_tracker.phone': { state: 'home', attributes: { friendly_name: '我的手机', latitude: 39.90923, longitude: 116.397428, gps_accuracy: 12 } },
      'device_tracker.lat_lon': { state: 'home', attributes: { lat: 31.2304, lon: 121.4737 } },
      'device_tracker.no_coords': { state: 'home', attributes: { friendly_name: 'x' } },
      'device_tracker.origin': { state: 'home', attributes: { latitude: 0, longitude: 0 } },
      'device_tracker.bad': { state: 'home', attributes: { latitude: 999, longitude: 116 } },
      'device_tracker.text': { state: 'home', attributes: { latitude: '39.9', longitude: '116.4' } },
    },
  };
  let r = T.readEntityLocation(hass, 'device_tracker.phone');
  ok('正常实体解析', r.ok && r.lat === 39.90923 && r.lon === 116.397428, r);
  ok('gps_accuracy 透传', r.accuracy === 12, r);
  r = T.readEntityLocation(hass, 'device_tracker.lat_lon');
  ok('兼容 lat/lon 写法', r.ok && r.lat === 31.2304 && r.lon === 121.4737, r);
  r = T.readEntityLocation(hass, 'device_tracker.text');
  ok('字符串经纬度可解析', r.ok && r.lat === 39.9, r);
  eq('缺失实体 → ENTITY_MISSING', T.readEntityLocation(hass, 'nope').reason, 'ENTITY_MISSING');
  eq('无经纬度属性 → NO_COORDS', T.readEntityLocation(hass, 'device_tracker.no_coords').reason, 'NO_COORDS');
  eq('(0,0) → ZERO_COORDS', T.readEntityLocation(hass, 'device_tracker.origin').reason, 'ZERO_COORDS');
  eq('越界 → BAD_COORDS', T.readEntityLocation(hass, 'device_tracker.bad').reason, 'BAD_COORDS');
  ok('失败时给出中文 message', /没有|不存在|超出|疑似/.test(T.readEntityLocation(hass, 'nope').message));

  console.log('\n=== 2. 距离与格式化 ===');
  const d = T.haversine(39.90923, 116.397428, 39.91423, 116.397428);
  ok('南北 555m 误差 < 2%', Math.abs(d - 555.9) / 555.9 < 0.02, d);
  eq('距离格式化 m', T.formatDistance(432.6), '433 m');
  eq('距离格式化 km', T.formatDistance(2400), '2.4 km');
  eq('距离未知', T.formatDistance(null), '—');

  console.log('\n=== 3. TTL 缓存 ===');
  const cache = new T.TtlCache(3);
  cache.set('a', 1, 60);
  eq('取回值', cache.get('a'), 1);
  cache.set('b', 2, 0.05);
  await sleep(90);
  eq('过期后失效', cache.get('b'), undefined);
  cache.set('zero', 9, 0);
  eq('ttl=0 不写入缓存', cache.get('zero'), undefined);
  cache.set('c', 3, 60); cache.set('d', 4, 60); cache.set('e', 5, 60);
  ok('超出容量后淘汰最旧', cache.get('a') === undefined && cache.size <= 3, cache.size);

  console.log('\n=== 4. 节流器 ===');
  const rl = new T.RateLimiter(120);
  const stamps = [];
  const t0 = Date.now();
  await Promise.all([1, 2, 3, 4].map((i) => rl.schedule(async () => { stamps.push(Date.now() - t0); return i; })));
  ok('4 个任务串行且满足最小间隔', stamps.length === 4 && stamps[3] >= 340, stamps);
  ok('间隔递增有序', stamps.every((v, i) => i === 0 || v >= stamps[i - 1] + 100), stamps);
  let failed = 0;
  await rl.schedule(() => Promise.reject(new Error('boom'))).catch(() => { failed++; });
  const after = await rl.schedule(() => 'ok');
  ok('任务失败不阻塞后续队列', failed === 1 && after === 'ok', { failed, after });

  console.log('\n=== 5. POI 解析与距离（从实体起算） ===');
  const samplePoi = {
    id: 'B123', name: '特来电充电站(望京SOHO)', type: '汽车服务;充电站', location: '116.480000,39.996000',
    distance: '830', address: '望京街10号', tel: '400-000-0000',
    biz_ext: { rating: '', cost: '', unknown: 'x' },
  };
  const normalized = T.normalizePoi(samplePoi);
  ok('POI 归一化', normalized.lng === 116.48 && normalized.lat === 39.996 && normalized.distance === 830, normalized);
  ok('缺失 biz_ext 不报错', T.normalizePoi({ name: 'n', location: '1,2' }).bizExt && true);
  ok('非法 location 被识别', T.normalizePoi({ name: 'n', location: 'abc' }).lng === null);

  // 距离必须从实体坐标算：高德的 distance 是相对「检索中心」（auto 模式 = 视野中心），
  // 用户拖走地图后与实体不是同一个点，直接用会显示成「旁边却 1.8 公里」。
  const origin = { lng: 116.397, lat: 39.909 };
  const view = T.buildPoiView(normalized, { kind: 'charging', icon: 'mdi:ev-station', origin });
  const wantDist = T.haversine(origin.lat, origin.lng, normalized.lat, normalized.lng);
  ok('距离从实体坐标起算', Math.abs(view.distance - wantDist) < 1e-6,
    { got: view.distance, want: wantDist, amapDistance: normalized.distance });
  ok('没有沿用高德返回的 distance（830）', Math.abs(view.distance - 830) > 1000, view.distance);
  ok('无 origin 时才退回高德 distance',
    T.buildPoiView(normalized, { kind: 'charging', icon: 'mdi:ev-station' }).distance === 830);
  ok('充电桩视图不再含电价 / 可用桩 / 总桩字段',
    !('price' in view) && !('available' in view) && !('total' in view), Object.keys(view));
  ok('默认配置已移除电价 / 桩数开关与字段映射',
    !('show_charging_price' in T.ALC_DEFAULTS) && !('show_charging_available' in T.ALC_DEFAULTS)
    && !('price_fields' in T.ALC_DEFAULTS) && !('available_fields' in T.ALC_DEFAULTS)
    && !('total_fields' in T.ALC_DEFAULTS), Object.keys(T.ALC_DEFAULTS));

  console.log('\n=== 6. 图标与链接构造 ===');
  ok('mdi 图标渲染为 ha-icon', T.iconHtml('mdi:ev-station', 34).includes('<ha-icon') && T.iconHtml('mdi:ev-station', 34).includes('--mdc-icon-size'));
  ok('图片 URL 渲染为 img', T.iconHtml('https://x/y.png', 30).includes('<img'));
  ok('/local 路径识别为图片', T.iconHtml('/local/a.png', 30).includes('<img'));
  ok('emoji 渲染为 span', T.iconHtml('🔌', 30).includes('<span'));
  ok('XSS 注入被转义', !T.iconHtml('"><script>x</script>', 30).includes('<script>'));
  ok('escapeHtml 处理引号', T.escapeHtml(`a"b'c<d>&`) === 'a&quot;b&#39;c&lt;d&gt;&amp;');

  const navUrl = T.buildNavigationUrl({ fromLng: 116.4, fromLat: 39.9, fromName: '起点', toLng: 116.48, toLat: 39.996, toName: '望京SOHO' });
  ok('导航链接含 callnative', navUrl.includes('callnative=1') && navUrl.startsWith('https://uri.amap.com/navigation'));
  ok('导航链接含 from/to', navUrl.includes('&from=116.400000,39.900000') && navUrl.includes('to=116.480000,39.996000'));
  ok('无起点时不含 from', !T.buildNavigationUrl({ toLng: 1, toLat: 2, toName: 'x' }).includes('&from='));
  const mUrl = T.buildMarkerUrl({ lng: 116.48, lat: 39.996, name: '充电站A' });
  ok('标注链接编码中文名', mUrl.includes('uri.amap.com/marker') && mUrl.includes(encodeURIComponent('充电站A')));

  console.log('\n=== 7. 坐标解析 ===');
  eq('标准解析', T.parseLngLat('116.397428,39.90923'), [116.397428, 39.90923]);
  eq('带空格解析', T.parseLngLat(' 116.39 , 39.90 '), [116.39, 39.9]);
  eq('非法输入返回 null', T.parseLngLat('abc'), null);
  eq('单值返回 null', T.parseLngLat('116.4'), null);
  eq('纬度越界返回 null', T.parseLngLat('116.4, 999'), null);

  console.log('\n=== 8. 高德 Web 服务：缓存 + 节流 + 错误映射 ===');
  let fetchCalls = [];
  global.fetch = async (url) => {
    fetchCalls.push(url);
    const u = new URL(url);
    if (u.pathname.includes('coordinate/convert')) {
      return { ok: true, json: async () => ({ status: '1', info: 'OK', locations: '116.403846,39.910912' }) };
    }
    if (u.searchParams.get('types') === '011100') {
      return {
        ok: true, json: async () => ({
          status: '1', info: 'OK', count: '2',
          pois: [
            { id: 'P1', name: '充电站甲', location: '116.410000,39.912000', distance: '540', address: 'A路1号', biz_ext: {} },
            { id: 'P2', name: '充电站乙', location: '116.420000,39.915000', distance: '1980', address: 'B路2号', biz_ext: {} },
          ],
        }),
      };
    }
    if (u.searchParams.get('types') === '999999') {
      return { ok: true, json: async () => ({ status: '1', info: 'OK', pois: [] }) };
    }
    return { ok: true, json: async () => ({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }) };
  };

  const api = T.getSharedApi('TEST_KEY_1', { minInterval: 0, coordTtl: 300, poiTtl: 300, debug: false });
  fetchCalls = [];
  const c1 = await api.convertFromGps(116.397428, 39.90923);
  eq('坐标转换结果解析', [c1.lng, c1.lat], [116.403846, 39.910912]);
  eq('转换请求参数正确', new URL(fetchCalls[0]).searchParams.get('coordsys'), 'gps');
  eq('转换请求显式带 output=json', new URL(fetchCalls[0]).searchParams.get('output'), 'json');
  ok('locations 参数为 经度,纬度', new URL(fetchCalls[0]).searchParams.get('locations') === '116.397428,39.909230');
  fetchCalls = [];
  await api.convertFromGps(116.397428, 39.90923);
  eq('同坐标 5 分钟内不重复请求（缓存命中）', fetchCalls.length, 0);
  fetchCalls = [];
  await api.convertFromGps(116.397428, 39.90923, true);
  eq('force 时穿透缓存', fetchCalls.length, 1);

  fetchCalls = [];
  const pois = await api.placeAround({ lng: 116.403846, lat: 39.910912, types: '011100', radius: 2000, offset: 20 });
  eq('POI 数量', pois.length, 2);
  ok('POI 按 distance 字段解析', pois[0].distance === 540);
  ok('extensions=all 已带', new URL(fetchCalls[0]).searchParams.get('extensions') === 'all');
  ok('sortrule=distance 已带', new URL(fetchCalls[0]).searchParams.get('sortrule') === 'distance');
  ok('周边检索显式带 output=json', new URL(fetchCalls[0]).searchParams.get('output') === 'json');
  eq('radius 参数正确', new URL(fetchCalls[0]).searchParams.get('radius'), '2000');
  fetchCalls = [];
  await api.placeAround({ lng: 116.403846, lat: 39.910912, types: '011100', radius: 2000, offset: 20 });
  eq('POI 结果走缓存', fetchCalls.length, 0);
  const emptyToilet = await api.placeAround({ lng: 116.403846, lat: 39.910912, types: '999999', radius: 2000, offset: 20 });
  eq('空结果不报错', emptyToilet.length, 0);

  // 自动半径换了 → 只清周边检索缓存，坐标转换缓存必须保住（否则每次缩放都要重新纠偏）
  fetchCalls = [];
  await api.placeAround({ lng: 116.403846, lat: 39.910912, types: '011100', radius: 2000, offset: 20 });
  eq('半径未变时 POI 命中缓存', fetchCalls.length, 0);
  api.clearPoiCache();
  await api.placeAround({ lng: 116.403846, lat: 39.910912, types: '011100', radius: 2000, offset: 20 });
  eq('clearPoiCache 后重新请求周边检索', fetchCalls.length, 1);
  fetchCalls = [];
  await api.convertFromGps(116.397428, 39.90923);
  eq('clearPoiCache 不影响坐标转换缓存', fetchCalls.length, 0);

  // 不同半径必须落到不同缓存槽（否则缩放后拿到的还是旧范围的结果）
  fetchCalls = [];
  await api.placeAround({ lng: 116.700000, lat: 39.700000, types: '011100', radius: 600, offset: 20 });
  await api.placeAround({ lng: 116.700000, lat: 39.700000, types: '011100', radius: 1800, offset: 20 });
  eq('不同 radius 不共用缓存', fetchCalls.length, 2);
  eq('radius 按传入值下发', new URL(fetchCalls[1]).searchParams.get('radius'), '1800');

  api.poiTtl = 0;
  fetchCalls = [];
  await api.placeAround({ lng: 116.500000, lat: 39.900000, types: '011100', radius: 2000, offset: 20 });
  await api.placeAround({ lng: 116.500000, lat: 39.900000, types: '011100', radius: 2000, offset: 20 });
  eq('poi_cache_ttl=0 时关闭缓存，每次真实请求', fetchCalls.length, 2);
  api.poiTtl = 300;
  const pendingA = api.placeAround({ lng: 116.600000, lat: 39.900000, types: '011100', radius: 2000, offset: 20 });
  const pendingB = api.placeAround({ lng: 116.600000, lat: 39.900000, types: '011100', radius: 2000, offset: 20 });
  fetchCalls = [];
  await Promise.all([pendingA, pendingB]);
  eq('并发同参数请求被合并为一次', fetchCalls.length, 1);

  fetchCalls = [];
  global.fetch = async () => ({ ok: true, json: async () => ({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003' }) });
  let caught = null;
  try { await api.placeAround({ lng: 8, lat: 8, types: '999', radius: 100 }); } catch (e) { caught = e; }
  ok('配额超限抛出 AmapError', caught instanceof T.AmapError, caught && caught.code);
  ok('超限映射为中文提示', caught && /上限|配额/.test(caught.message), caught && caught.message);
  eq('friendlyAmapInfo 处理 Key 错误', T.friendlyAmapInfo('INVALID_USER_KEY').includes('Key'), true);
  eq('friendlyAmapInfo 处理未知码', T.friendlyAmapInfo('SOMETHING_WEIRD').includes('SOMETHING_WEIRD'), true);

  /* -------- 8c. 转换接口响应侧校验 + infocode 识别 -------- */
  /* 依据：实测高德对越界坐标不报错，会 status=1 / infocode=10000 原样回显，必须自己拦 */
  console.log('\n=== 8c. 转换接口响应侧校验 / infocode 映射 ===');
  T.ALC_API_REGISTRY.clear();
  const apiC = T.getSharedApi('TEST_KEY_8C', { minInterval: 0, coordTtl: 300, poiTtl: 300 });

  // ① 输入本身越界 → 本地直接拦下，连请求都不发（省配额）
  fetchCalls = [];
  global.fetch = async (url) => { fetchCalls.push(url); return { ok: true, json: async () => ({ status: '1', info: 'OK', infocode: '10000', locations: '999,999' }) }; };
  caught = null;
  try { await apiC.convertFromGps(999, 999); } catch (e) { caught = e; }
  ok('越界输入本地拦下', caught instanceof T.AmapError && caught.code === 'BAD_COORDS', caught && caught.code);
  eq('越界输入不发网络请求', fetchCalls.length, 0);

  // ② 输入合法但接口回显越界坐标
  fetchCalls = [];
  caught = null;
  try { await apiC.convertFromGps(116.397428, 39.90923); } catch (e) { caught = e; }
  ok('回显越界坐标被判为失败', caught && caught.code === 'BAD_LOCATION', caught && caught.code);
  ok('失败提示说明是越界', caught && /越界/.test(caught.message), caught && caught.message);
  fetchCalls = [];
  try { await apiC.convertFromGps(116.397428, 39.90923); } catch (e) { /* ignore */ }
  eq('坏结果不写入缓存（下次仍重新请求）', fetchCalls.length, 1);

  // ③ 返回结果与输入偏差过大（> 0.05°）
  global.fetch = async () => ({ ok: true, json: async () => ({ status: '1', info: 'OK', infocode: '10000', locations: '117.500000,41.000000' }) });
  caught = null;
  try { await apiC.convertFromGps(116.397428, 39.90923); } catch (e) { caught = e; }
  ok('偏差过大被拦下', caught && caught.code === 'BAD_LOCATION', caught && caught.code);
  ok('偏差提示带具体数值', caught && /偏差过大/.test(caught.message), caught && caught.message);

  // ④ 合法偏移量（南昌实测值）必须放行
  global.fetch = async () => ({ ok: true, json: async () => ({ status: '1', info: 'OK', infocode: '10000', locations: '116.402322,39.905933' }) });
  const okShift = await apiC.convertFromGps(116.397428, 39.90923);
  eq('正常 GCJ-02 偏移量放行', [okShift.lng, okShift.lat], [116.402322, 39.905933]);

  // ⑤ locations 为空 / 非法
  global.fetch = async () => ({ ok: true, json: async () => ({ status: '1', info: 'OK', infocode: '10000', locations: '' }) });
  caught = null;
  try { await apiC.convertFromGps(116.500000, 39.900000); } catch (e) { caught = e; }
  ok('locations 为空判为异常', caught && caught.code === 'BAD_LOCATION', caught && caught.code);
  global.fetch = async () => ({ ok: true, json: async () => ({ status: '1', info: 'OK', infocode: '10000', locations: 'abc,def' }) });
  caught = null;
  try { await apiC.convertFromGps(116.600000, 39.900000); } catch (e) { caught = e; }
  ok('locations 非数字判为异常', caught && caught.code === 'BAD_LOCATION', caught && caught.code);

  // ⑥ 境外坐标：高德原样返回（偏移 0），属正常结果，不能误伤
  global.fetch = async (url) => {
    const loc = new URL(url).searchParams.get('locations');
    return { ok: true, json: async () => ({ status: '1', info: 'OK', infocode: '10000', locations: loc }) };
  };
  T.ALC_API_REGISTRY.clear();
  const apiOs = T.getSharedApi('TEST_KEY_OS', { minInterval: 0, coordTtl: 300 });
  const osRes = await apiOs.convertFromGps(139.6917, 35.6895);
  eq('境外坐标原样返回不报错', [osRes.lng, osRes.lat], [139.6917, 35.6895]);
  ok('isValidLngLat 判定正确', T.isValidLngLat(116.4, 39.9) && !T.isValidLngLat(999, 999) && !T.isValidLngLat(116, 91));

  // ⑦ infocode 映射
  ok('infocode 10004 → 限流提示', /频繁|限流/.test(T.friendlyAmapInfo('ACCESS_TOO_FREQUENT', '10004')), T.friendlyAmapInfo('ACCESS_TOO_FREQUENT', '10004'));
  ok('infocode 10009 → 提示需 Web 服务 Key', /Web 服务/.test(T.friendlyAmapInfo('USERKEY_PLAT_NOMATCH', '10009')), T.friendlyAmapInfo('USERKEY_PLAT_NOMATCH', '10009'));
  ok('infocode 10003 → 配额提示', /配额|上限/.test(T.friendlyAmapInfo('DAILY_QUERY_OVER_LIMIT', '10003')));
  ok('infocode 20000 → 参数非法', /参数/.test(T.friendlyAmapInfo('INVALID_PARAMS', '20000')));
  ok('infocode 20001 → 缺参提示', /缺少/.test(T.friendlyAmapInfo('MISSING_REQUIRED_PARAMS', '20001')));
  ok('仅给 infocode 也能映射', /过期/.test(T.friendlyAmapInfo('', '10041')), T.friendlyAmapInfo('', '10041'));
  ok('未收录的 infocode 会原样带出', /99999/.test(T.friendlyAmapInfo('WEIRD', '99999')));
  ok('空 info 有空兜底文案', T.friendlyAmapInfo('').length > 0);
  ok('infocode 表覆盖关键限流码', !!(T.ALC_AMAP_INFOCODE[10003] && T.ALC_AMAP_INFOCODE[10004] && T.ALC_AMAP_INFOCODE[10009]));
  ok('最大容许偏移常量为 0.05°', T.ALC_GCJ_MAX_SHIFT === 0.05);

  // ⑧ 错误对象上要能拿到 infocode，便于排查
  global.fetch = async () => ({ ok: true, json: async () => ({ status: '0', info: 'ACCESS_TOO_FREQUENT', infocode: '10004' }) });
  caught = null;
  try { await apiOs.convertFromGps(116.397428, 39.90923); } catch (e) { caught = e; }
  eq('错误对象保留 infocode', caught && caught.infocode, '10004');
  eq('错误对象保留 info', caught && caught.info, 'ACCESS_TOO_FREQUENT');
  ok('限流错误提示为中文', caught && /频繁|限流/.test(caught.message), caught && caught.message);

  // ⑨ HTTP 非 2xx 与坏 JSON
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  caught = null;
  try { await apiOs.convertFromGps(116.700000, 39.700000); } catch (e) { caught = e; }
  ok('HTTP 500 抛 AmapError', caught instanceof T.AmapError, caught && caught.code);
  global.fetch = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  caught = null;
  try { await apiOs.convertFromGps(116.800000, 39.800000); } catch (e) { caught = e; }
  eq('坏 JSON 给出可读错误', caught && caught.code, 'BAD_JSON');

  // ⑩ parseConvertedLocation 支持多坐标串（取第一个）
  const multi = T.parseConvertedLocation({ locations: '116.403846,39.910912;120,30' }, 116.397428, 39.90923);
  eq('多坐标串取第一个', [multi.lng, multi.lat], [116.403846, 39.910912]);
  ok('多坐标串不误报 noopShift', multi.noopShift === false, multi);

  /* -------- 8d. 底图脚本加载失败的诊断 -------- */
  console.log('\n=== 8d. 底图加载失败的诊断（域名探测） ===');
  const savedFetch = global.fetch;
  const savedWarn = console.warn;
  console.warn = () => {};   // 诊断函数会往控制台打详情，测试期间静音

  global.fetch = async (url, opts) => {
    if (opts && opts.mode === 'no-cors') return { ok: true, type: 'opaque' };
    return { ok: true, json: async () => ({ status: '1', info: 'OK', locations: '' }) };
  };
  eq('域名可达 → reachable', await T.probeAmapHost(), 'reachable');

  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  eq('域名不可达 → unreachable', await T.probeAmapHost(), 'unreachable');

  let diag = await T.diagnoseJsApiFailure({ code: 'JS_API_ERROR', message: '高德 JS API 脚本加载失败' });
  ok('网络不通时提示检查网络/CSP/扩展', /无法访问|网络|代理|防火墙|CSP/.test(diag), diag);

  global.fetch = async () => ({ ok: true, type: 'opaque' });
  diag = await T.diagnoseJsApiFailure({ code: 'JS_API_ERROR', message: '高德 JS API 脚本加载失败', safeUrl: 'https://webapi.amap.com/maps?v=2.0&key=***' });
  ok('域名可达时提示「脚本被拦截」', /拦截/.test(diag), diag);
  ok('提示里解释了常见拦截来源（扩展/CSP/沙箱）', /扩展|CSP|沙箱/.test(diag), diag);

  // 探测失败也不能抛异常（否则会把降级链本身搞崩）
  global.fetch = async () => { throw new Error('boom'); };
  let diagOk = true;
  try { await T.diagnoseJsApiFailure(null); } catch (e) { diagOk = false; }
  ok('诊断函数自身不抛异常（err 为 null 也安全）', diagOk);

  console.warn = savedWarn;
  global.fetch = savedFetch;

  /* -------- 8b. 搜索范围（自动 / 固定）配置默认值 -------- */
  console.log('\n=== 8b. 搜索范围配置 ===');
  eq('默认半径模式', T.ALC_DEFAULTS.radius_mode, 'auto');
  eq('固定模式回退半径', T.ALC_DEFAULTS.radius, 2000);
  eq('自动范围系数默认 1.0', T.ALC_DEFAULTS.auto_radius_pad, 1);
  eq('自动范围上限默认 5000', T.ALC_DEFAULTS.auto_radius_max, 5000);
  ok('搜索半径圈默认关闭', T.ALC_DEFAULTS.show_radius_circle === false);
  ok('半径模式只有 auto / fixed 两种取值', typeof T.ALC_DEFAULTS.radius_mode === 'string');
  eq('自动半径取法默认 cover（按整张视图检索）', T.ALC_DEFAULTS.auto_radius_basis, 'cover');
  ok('自动半径取法只有 visible / cover 两种',
    ['visible', 'cover'].indexOf(T.ALC_DEFAULTS.auto_radius_basis) >= 0);

  /* 内切 vs 外接的几何关系 —— 「点位超出底图范围」的根因就在这两者的差额上 */
  const mppSmoke = T.metersPerPixel(28.677203, 16);
  const basisR = (w, h, basis) => (basis === 'cover' ? Math.hypot(w / 2, h / 2) : Math.min(w / 2, h / 2)) * mppSmoke;
  ok('内切 = 短边一半 × 每像素米数',
    Math.abs(basisR(1024, 360, 'visible') - 180 * mppSmoke) < 1e-9);
  ok('内切 < 外接（正方形也一样，对角线永远长于边）',
    basisR(420, 420, 'visible') < basisR(420, 420, 'cover'));
  ok('容器越扁，内切/外接差距越大（宽扁卡片必须用内切才不出图）',
    basisR(1024, 360, 'visible') / basisR(1024, 360, 'cover')
      < basisR(420, 420, 'visible') / basisR(420, 420, 'cover'));
  ok('宽扁容器下外接半径会明显越过短边（老版本结果出图的原因）',
    basisR(1024, 360, 'cover') > basisR(1024, 360, 'visible') * 2.5,
    { visible: Math.round(basisR(1024, 360, 'visible')), cover: Math.round(basisR(1024, 360, 'cover')) });

  console.log('\n=== 9. 坐标转换降级链 ===');
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  T.ALC_API_REGISTRY.clear();
  const api2 = T.getSharedApi('TEST_KEY_2', { minInterval: 0, coordTtl: 300, poiTtl: 300 });
  const degraded = await T.convertToGcj02({ api: api2, wgsLng: 116.397428, wgsLat: 39.90923, jsKey: '', force: false });
  eq('Web 服务失败且无 JS Key → 使用原始坐标', [degraded.lng, degraded.lat], [116.397428, 39.90923]);
  eq('降级标记为 raw', degraded.via, 'raw');
  ok('降级给出提示文案', typeof degraded.notice === 'string' && degraded.notice.length > 0, degraded.notice);

  global.fetch = async (url) => ({ ok: true, json: async () => (String(url).includes('coordinate/convert')
    ? { status: '1', info: 'OK', locations: '116.403846,39.910912' }
    : { status: '1', info: 'OK', pois: [] }) });
  T.ALC_API_REGISTRY.clear();
  const api3 = T.getSharedApi('TEST_KEY_3', { minInterval: 0 });
  const good = await T.convertToGcj02({ api: api3, wgsLng: 116.397428, wgsLat: 39.90923, jsKey: '', force: false });
  eq('正常路径标记为 web', good.via, 'web');
  ok('正常路径无告警', good.notice === undefined, good.notice);

  console.log('\n=== 9a. 坐标系契约：转换静默未生效检测 ===');
  const noop = T.parseConvertedLocation({ locations: '115.958000,28.680500' }, 115.958, 28.6805);
  ok('境内坐标原样回显 → 标记 noopShift', noop.noopShift === true, noop);
  const abroad = T.parseConvertedLocation({ locations: '139.700000,35.680000' }, 139.7, 35.68);
  ok('境外坐标原样回显属正常 → 不标记', abroad.noopShift === false, abroad);
  const realConv = T.parseConvertedLocation({ locations: '115.962895,28.677203' }, 115.958, 28.6805);
  ok('真实转换结果 → 不标记', realConv.noopShift === false, realConv);
  ok('境内包围盒判定：南昌在内', T.inChinaBbox(115.958, 28.6805) === true);
  ok('境内包围盒判定：东京在外', T.inChinaBbox(139.7, 35.68) === false);

  global.fetch = async (url) => ({ ok: true, json: async () => (String(url).includes('coordinate/convert')
    ? { status: '1', info: 'OK', locations: '115.958000,28.680500' }
    : { status: '1', info: 'OK', pois: [] }) });
  T.ALC_API_REGISTRY.clear();
  const apiNoop = T.getSharedApi('TEST_KEY_NOOP', { minInterval: 0 });
  const noopConv = await T.convertToGcj02({ api: apiNoop, wgsLng: 115.958, wgsLat: 28.6805, jsKey: '', force: false });
  eq('原样回显仍按 web 路径采用', noopConv.via, 'web');
  ok('原样回显给出「纠偏未生效」提示', /未生效/.test(noopConv.notice || ''), noopConv.notice);

  console.log('\n=== 9b. 实体坐标系开关（coord_sys）===');
  eq('默认按 WGS-84 处理', T.ALC_DEFAULTS.coord_sys, 'wgs84');
  const edField = T.ALC_EDITOR_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === 'coord_sys');
  ok('配置编辑器提供坐标系选择', !!edField && Array.isArray(edField.options) && edField.options.length === 2,
    edField && edField.options);
  ok('坐标系选项含 wgs84 与 gcj02', !!edField && edField.options.some((o) => o[0] === 'wgs84') && edField.options.some((o) => o[0] === 'gcj02'));
  ok('坐标系字段说明带二次偏移提示', !!edField && typeof edField.hint === 'string' && /偏移/.test(edField.hint));
  ok('编辑器实体字段提示提及 WGS-84 默认',
    T.ALC_EDITOR_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === 'entity').hint.includes('WGS-84'));

  console.log('\n=== 9c. 全屏显示规则（map_height，对齐 ha-map-card-recode）===');
  eq('默认不启用自定义高度', T.ALC_DEFAULTS.map_height, '');
  eq('数字 → 像素', T.parseMapHeight(480), '480px');
  eq('数字字符串 → 像素', T.parseMapHeight('480'), '480px');
  eq('过小像素被抬到下限', T.parseMapHeight(20), '120px');
  eq('过大像素被收到上限', T.parseMapHeight(5000), '3000px');
  eq('vh 原样透传', T.parseMapHeight('100vh'), '100vh');
  eq('dvh 原样透传', T.parseMapHeight('100dvh'), '100dvh');
  eq('calc 原样透传', T.parseMapHeight('calc(100dvh - 120px)'), 'calc(100dvh - 120px)');
  eq('百分比原样透传', T.parseMapHeight('100%'), '100%');
  eq('留空 = 不启用', T.parseMapHeight(''), null);
  eq('null = 不启用', T.parseMapHeight(null), null);
  eq('未知单位被拒', T.parseMapHeight('12foo'), null);
  eq('纯文字被拒', T.parseMapHeight('auto'), null);
  eq('注入分号被拒', T.parseMapHeight('100vh;position:fixed'), null);
  eq('url() 被拒', T.parseMapHeight('url(x)'), null);
  eq('括号不配平被拒', T.parseMapHeight('calc(100dvh - 120px'), null);
  eq('超长值被拒', T.parseMapHeight('calc(' + '1px + '.repeat(20) + '1px)'), null);
  eq('像素折算：480px', T.cssHeightToPx('480px', 800), 480);
  eq('像素折算：100dvh', T.cssHeightToPx('100dvh', 800), 800);
  eq('像素折算：calc(100dvh - 120px)', T.cssHeightToPx('calc(100dvh - 120px)', 800), 680);
  eq('像素折算：50%', T.cssHeightToPx('50%', 800), 400);
  const mhField = T.ALC_EDITOR_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === 'map_height');
  ok('配置编辑器提供自定义高度', !!mhField && mhField.type === 'text', mhField);
  ok('自定义高度说明含 CSS 示例', !!mhField && /100dvh/.test(mhField.placeholder || '') && /calc/.test(mhField.hint || ''));

  console.log('\n=== 9d. iOS App 底图：强制 WebGL / 瓦片底图 ===');
  eq('底图类型默认 auto', T.ALC_DEFAULTS.basemap, 'auto');
  eq('默认强制 WebGL', T.ALC_DEFAULTS.force_webgl, true);
  {
    const savedF = global.window.forceWebGL;
    const savedB = global.window.forceWebGLBaseRender;
    delete global.window.forceWebGL;
    delete global.window.forceWebGLBaseRender;
    T.amapLoader.forceWebGL();
    eq('forceWebGL() 置位 window.forceWebGL', global.window.forceWebGL, true);
    eq('forceWebGL() 置位增强开关 forceWebGLBaseRender', global.window.forceWebGLBaseRender, true);
    eq('诊断能反映已置位', T.amapLoader.webglForced(), true);
    global.window.forceWebGL = false;      // 宿主页面自己设置的值要尊重
    T.amapLoader.forceWebGL();
    eq('不覆盖宿主的 false', global.window.forceWebGL, false);
    global.window.forceWebGL = savedF;
    global.window.forceWebGLBaseRender = savedB;
  }
  ok('识别「浏览器版本过低」提示', T.isWebGLError('浏览器版本过低，请更换浏览器'));
  ok('识别 WebGL 报错', T.isWebGLError('Your browser does not support WebGL'));
  ok('不误伤普通报错', !T.isWebGLError('INVALID_USER_KEY'));
  ok('不误伤普通文案', !T.isWebGLError('当前位置不可用'));
  const bmField = T.ALC_EDITOR_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === 'basemap');
  ok('编辑器提供底图类型选择', !!bmField && bmField.options.some((o) => o[0] === 'tiles'), bmField && bmField.options);
  const fwField = T.ALC_EDITOR_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === 'force_webgl');
  ok('编辑器提供强制 WebGL 开关', !!fwField && fwField.type === 'boolean', fwField);
  ok('强制 WebGL 说明提到 WKWebView', !!fwField && /WKWebView/.test(fwField.hint || ''));

  console.log('\n=== 10. 投影工具 ===');
  const x = T.lonToWorldX(116.397428, 16);
  ok('经度投影可逆', Math.abs(T.worldXToLon(x, 16) - 116.397428) < 1e-9, T.worldXToLon(x, 16));
  const y = T.latToWorldY(39.90923, 16);
  ok('纬度投影可逆', Math.abs(T.worldYToLat(y, 16) - 39.90923) < 1e-9, T.worldYToLat(y, 16));
  const mpp = T.metersPerPixel(39.90923, 16);
  ok('zoom16 北纬40° 每像素约 1.8m', mpp > 1.6 && mpp < 2.0, mpp);
  ok('纬度越高像素越小', T.metersPerPixel(60, 16) < T.metersPerPixel(0, 16));

  console.log('\n=== 11. 外链打开策略（新标签页 / 原页面不跳转） ===');
  const srcAll = fs.readFileSync(path.join(__dirname, 'amap-location-card.js'), 'utf8');
  // 注释里会提到「不要用 window.open(...,'noopener')」，先剥掉注释再查代码
  const codeOnly = srcAll.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('window.open 不再传 noopener（否则返回值恒为 null → 旧代码会再跳一次原页面）',
    !/window\.open\([^)]*noopener/.test(codeOnly));
  const oe = srcAll.slice(srcAll.indexOf('function openExternal'), srcAll.indexOf('function openExternal') + 3600);
  eq('openExternal 内 window.location.href 只出现 1 次（仅 open_in_new_tab=false 分支）',
    (oe.match(/window\.location\.href/g) || []).length, 1);
  ok('新标签分支先走临时锚点，window.open 只在最后兜底（顺序不能反）',
    oe.indexOf("createElement('a')") > -1 && oe.indexOf("createElement('a')") < oe.indexOf('window.open('));
  ok('锚点带 target=_blank + rel=noopener noreferrer',
    /target = '_blank'/.test(oe) && /rel = 'noopener noreferrer'/.test(oe));
  ok('锚点不用 display:none（iOS Safari 会忽略不可见元素的程序化点击）',
    !/\.style\.display\s*=\s*'none'/.test(oe));
  ok('临时锚点用完即移除', /parentNode\.removeChild\(a\)/.test(oe));
  eq('默认配置在新标签打开', T.ALC_DEFAULTS.open_in_new_tab, true);

  console.log('\n=== 12. 实体朝向 heading → 定位点箭头 ===');
  const withAttrs = (attrs) => ({ states: { x: { state: 'home', attributes: attrs } } });
  const loc = (attrs) => T.readEntityLocation(withAttrs(Object.assign({ latitude: 28.6, longitude: 115.9 }, attrs)), 'x');

  eq('读取 heading 属性', loc({ heading: 120 }).heading, 120);
  eq('兼容 course 属性', loc({ course: 45 }).heading, 45);
  eq('兼容 bearing 属性', loc({ bearing: 300 }).heading, 300);
  eq('heading 优先于 course', loc({ heading: 10, course: 90 }).heading, 10);
  eq('没有朝向 → null', loc({}).heading, null);
  eq('字符串朝向照样能用', loc({ heading: '90.5' }).heading, 90.5);

  eq('归一化 -90 → 270', T.normalizeHeading(-90), 270);
  eq('归一化 360 → 0', T.normalizeHeading(360), 0);
  eq('归一化 725.5 → 5.5', T.normalizeHeading(725.5), 5.5);
  eq('非法朝向 → null', T.normalizeHeading('abc'), null);
  eq('空朝向 → null', T.normalizeHeading(''), null);

  ok('1° 内抖动不重绘', !T.headingChanged(10, 10.4));
  ok('超过 1° 则重绘', T.headingChanged(10, 11.2));
  ok('359 → 1 视为转了 2°', T.headingChanged(359, 1));
  ok('从无朝向到有朝向算变化', T.headingChanged(null, 0));
  ok('朝向不变则不动', !T.headingChanged(88, 88));

  const pin = (icon, heading) => T.AmapLocationCard.prototype._pinHtml.call({}, icon, 34, 'entity', heading);
  const p0 = pin('mdi:crosshairs-gps', 0);
  ok('有朝向时定位点画箭头', /alc-dir-arrow/.test(p0), p0);
  ok('0° 指正北（rotate(0deg)）', /rotate\(0deg\)/.test(p0), p0);
  ok('带 data-heading 便于验收', /data-heading="0"/.test(p0), p0);
  ok('默认十字准星图标被箭头替换', !/alc-icon-ha/.test(p0), p0);
  ok('90° → rotate(90deg)（正东，顺时针）', /rotate\(90deg\)/.test(pin('mdi:crosshairs-gps', 90)));
  ok('270° → rotate(270deg)', /rotate\(270deg\)/.test(pin('mdi:crosshairs-gps', -90)));
  const pc = pin('mdi:face-man', 45);
  ok('自定义图标保留图标本体', /alc-icon-ha/.test(pc), pc);
  ok('自定义图标时箭头绕到圆外', /alc-dir-arrow-outside/.test(pc), pc);
  ok('无朝向 → 不画箭头', !/alc-dir-arrow/.test(pin('mdi:crosshairs-gps', null)));
  ok('POI 标记不受 heading 影响',
    !/alc-dir-arrow/.test(T.AmapLocationCard.prototype._pinHtml.call({}, 'mdi:ev-station', 29, 'charging', 90)));

  const src12 = fs.readFileSync(path.join(__dirname, 'amap-location-card.js'), 'utf8');
  ok('渲染标记时把 heading 传给 _pinHtml',
    /this\._pinHtml\(p\.icon, p\.size, p\.kind, p\.heading\)/.test(src12));
  ok('带朝向的定位点解除 overflow 裁剪，箭头才能探出圆外',
    /\.alc-pin-heading\s*\{[^}]*overflow\s*:\s*visible/.test(src12));
  ok('朝向变化时重绘标记（不必等坐标变化/联网）',
    /headingChanged\(prevHeading, res\.heading\)/.test(src12));

  console.log('\n=== 13. 命名（ha-amap-scout）与旧 tag 兼容 ===');
  ok('主 tag 改为 amap-scout', /const ALC_CARD_TAG = 'amap-scout';/.test(src12));
  ok('声明了旧 tag 常量（不直接写死在注册处）', /const ALC_LEGACY_CARD_TAG = 'amap-location-card';/.test(src12));
  ok('旧 tag 用子类别名注册（同构造器注册两次会抛 NotSupportedError）',
    /defineWithLegacyAlias\(ALC_CARD_TAG, ALC_LEGACY_CARD_TAG, AmapLocationCard\)/.test(src12)
    && /class extends base \{\}/.test(src12));
  ok('编辑器同样保留旧 tag',
    /defineWithLegacyAlias\(ALC_EDITOR_TAG, ALC_LEGACY_EDITOR_TAG, AmapLocationCardEditor\)/.test(src12));
  ok('customCards 选择器名称已改为中文名',
    /name: '高德探路 · AMap Scout'/.test(src12));
  ok('文档链接指向新仓库 ha-amap-scout-card',
    /documentationURL: 'https:\/\/github\.com\/lonyii\/ha-amap-scout-card'/.test(src12));
  ok('日志前缀跟随新名（不再出现 [amap-location-card]）', !/\[amap-location-card\]/.test(src12));
  ok('高德导航 src 参数用新名', /const ALC_NAV_SRC = 'ha-amap-scout';/.test(src12));
  ok('旧 Mock 钩子名仍识别（老 demo 不炸）',
    /window\.__ALC_MOCK__ \|\| window\.__AMAP_LOCATION_CARD_MOCK__/.test(src12));

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const hacs = JSON.parse(fs.readFileSync(path.join(__dirname, 'hacs.json'), 'utf8'));
  eq('package.json 名称', pkg.name, 'ha-amap-scout');
  eq('package.json 入口', pkg.main, 'amap-location-card.js');
  ok('package.json 版本号已进位', /^1\.\d+\.\d+$/.test(pkg.version), pkg.version);

  /* 资源路径稳定性：实现留在历史文件名上，换名字会让所有老安装直接报
     Custom element doesn't exist —— v1.1.0 踩过，这里用测试钉死。 */
  eq('hacs.json 文件名保持历史值（HACS 资源路径不失效）', hacs.filename, 'amap-location-card.js');
  ok('hacs.json 不再指向新文件名', hacs.filename !== 'ha-amap-scout.js');

  const shim = fs.readFileSync(path.join(__dirname, 'ha-amap-scout.js'), 'utf8');
  ok('新路径入口转发到实现文件', /import '\.\/amap-location-card\.js';/.test(shim));
  ok('新路径入口不含任何实现（只有 import 与注释）',
    shim.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim() === "import './amap-location-card.js';");
  ok('hacs.json 显示名含中文名与英文名', /高德探路/.test(hacs.name) && /AMap Scout/.test(hacs.name), hacs.name);

  /* ---------- 14. 夜间主题 ---------- */
  console.log('\n=== 14. 夜间主题 ===');

  const fakeWin = (dark) => ({ matchMedia: (q) => ({ matches: dark && /dark/.test(q), media: q }) });

  eq('auto + HA 深色 → 夜间', T.resolveDarkTheme('auto', { themes: { darkMode: true } }, fakeWin(false)), true);
  eq('auto + HA 浅色 → 白天（HA 优先于系统深色）',
    T.resolveDarkTheme('auto', { themes: { darkMode: false } }, fakeWin(true)), false);
  eq('auto + 没有 HA 主题 → 看系统深色', T.resolveDarkTheme('auto', {}, fakeWin(true)), true);
  eq('auto + 什么都没有 → 白天', T.resolveDarkTheme('auto', {}, null), false);
  eq('显式 dark 不受 HA 影响', T.resolveDarkTheme('dark', { themes: { darkMode: false } }, fakeWin(false)), true);
  eq('显式 light 不受 HA 影响', T.resolveDarkTheme('light', { themes: { darkMode: true } }, null), false);
  eq('night / day 别名等价', T.resolveDarkTheme('night', null, null) === true
    && T.resolveDarkTheme('day', null, null) === false, true);
  eq('空值当 auto', T.resolveDarkTheme('', { themes: { darkMode: true } }, null), true);
  eq('hass.themes 是怪对象也不炸', T.resolveDarkTheme('auto', { themes: { darkMode: 'yes' } }, null), false);

  eq('夜间默认样式：normal → 幻影黑',
    T.effectiveMapStyle({ map_style: 'amap://styles/normal' }, true), T.ALC_NIGHT_MAP_STYLE);
  eq('夜间默认样式：空 map_style 也按 normal 处理',
    T.effectiveMapStyle({}, true), T.ALC_NIGHT_MAP_STYLE);
  eq('夜间不吞用户自定义样式',
    T.effectiveMapStyle({ map_style: 'amap://styles/fresh' }, true), 'amap://styles/fresh');
  eq('显式 night_map_style 优先',
    T.effectiveMapStyle({ map_style: 'amap://styles/normal', night_map_style: 'amap://styles/dark' }, true),
    'amap://styles/dark');
  eq('白天永远用 map_style（哪怕配了 night_map_style）',
    T.effectiveMapStyle({ map_style: 'amap://styles/fresh', night_map_style: 'amap://styles/dark' }, false),
    'amap://styles/fresh');
  eq('night_map_style 只填空白 → 走自动', T.effectiveMapStyle({ map_style: 'amap://styles/normal', night_map_style: '   ' }, true),
    T.ALC_NIGHT_MAP_STYLE);

  // 源码护栏：主题是 JS 判定，不能退回 @media（HA 手动切深色时 media query 不会变）
  const srcTheme = fs.readFileSync(SRC, 'utf8');
  ok('CSS 不再用 @media prefers-color-scheme 决定夜间',
    !/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/.test(srcTheme));
  ok('夜间是根节点 class 驱动的', /\.alc-root\.alc-dark/.test(srcTheme) && /\.alc-force-dark/.test(srcTheme));
  ok('auto 模式不强制覆盖 HA 主题变量（只 force-* 才覆盖）',
    /\.alc-root\.alc-force-dark\s*\{[\s\S]{0,400}--card-background-color/.test(srcTheme));
  ok('hass 更新时重新评估主题', /this\._applyTheme\(\);[\s\S]{0,80}this\._stateFromHass\(\)/.test(srcTheme));
  ok('系统深浅色切换有监听', /addEventListener\('change', this\._onScheme\)/.test(srcTheme));
  ok('销毁时解绑系统主题监听', /removeEventListener\('change', this\._onScheme\)/.test(srcTheme));
  ok('切主题走 setMapStyle 而不是重建地图', /setMapStyle\(style\)/.test(srcTheme));
  ok('配置里有 theme / night_map_style', T.ALC_DEFAULTS.theme === 'auto' && T.ALC_DEFAULTS.night_map_style === '');
  const themeField = T.ALC_EDITOR_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === 'theme');
  ok('编辑器暴露夜间主题选项', !!themeField && themeField.type === 'select'
    && themeField.options.some((o) => o[0] === 'dark') && themeField.options.some((o) => o[0] === 'light'));

  console.log('\n=== 15. 编辑模式铺满让位 ===');
  const srcFill = fs.readFileSync(SRC, 'utf8');
  ok('铺满高度计入文档流后方的编辑工具栏',
    srcFill.includes('_measureFlowGap') && /max - gap - flowGap - safe/.test(srcFill));
  ok('文档流让位只在编辑模式生效（不缩普通长仪表盘）',
    /_measureFlowGap\(vh\)\s*\{[\s\S]{0,200}_inHaEditMode/.test(srcFill));
  ok('编辑模式检测走 hui-view.lovelace / hui-root.editMode',
    /'hui-view'/.test(srcFill) && /'hui-root'/.test(srcFill));
  ok('文档流让位有 40% 视口封顶', /Math\.min\(overflow,\s*Math\.round\(vh \* 0\.4\)\)/.test(srcFill));

  console.log('');
  console.log(results.join('\n'));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });

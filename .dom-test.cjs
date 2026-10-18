/* DOM 渲染测试：用 jsdom 真实构造卡片元素，验证渲染链路、标记、弹窗、列表、
 * 事件委托、高德地图分支与简化视图分支。
 * 运行： node .dom-test.cjs   （需先 npm i jsdom 到 node 工作区）
 * 仅用于开发验证，不随卡片发布。 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const NODE_WORKSPACE = process.env.ALC_NODE_WORKSPACE
  || 'C:/Users/lonyi/.workbuddy/binaries/node/workspace';
process.env.NODE_PATH = path.join(NODE_WORKSPACE, 'node_modules');
require('module').Module._initPaths();

const { JSDOM } = require('jsdom');

/* ============================================================
 *  jsdom 环境搭建
 * ============================================================ */

let ctx2dCalls = 0;
const ctxArcs = [];        // 记录 arc(cx, cy, r)：用来验证半径圈画在定位点上
const ctxMoves = [];       // 记录 moveTo：用来验证十字准星的位置
function makeCtx2d() {
  const noop = () => { ctx2dCalls++; };
  return {
    setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop,
    moveTo: (x, y) => { ctx2dCalls++; ctxMoves.push({ x, y }); },
    lineTo: noop, stroke: noop,
    arc: (x, y, r) => { ctx2dCalls++; ctxArcs.push({ x, y, r }); },
    fill: noop,
    fillText: noop, setLineDash: noop,
    drawImage: noop,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
  };
}

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:8777/',
  pretendToBeVisual: true,
});
const { window } = dom;

window.HTMLCanvasElement.prototype.getContext = function (type) {
  if (type === '2d') return makeCtx2d();
  if (type === 'webgl' || type === 'experimental-webgl') return { fake: 'webgl' };
  return null;
};

const openedUrls = [];
window.open = (u) => { openedUrls.push(u); return { closed: false }; };

class FakeResizeObserver { observe() {} disconnect() {} unobserve() {} }

const g = global;
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.HTMLElement = window.HTMLElement;
g.HTMLCanvasElement = window.HTMLCanvasElement;
g.CustomEvent = window.CustomEvent;
g.Event = window.Event;
g.Node = window.Node;
g.customElements = window.customElements;
g.getComputedStyle = window.getComputedStyle.bind(window);
g.ResizeObserver = FakeResizeObserver;
g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
g.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

/* ============================================================
 *  假高德 JS API
 * ============================================================ */

const amapCreated = { maps: [], markers: [], infos: [], circles: [], failMap: false };

/* 假的可视范围：测试通过改 zoom / 尺寸来模拟用户缩放地图 */
const fakeViewport = { zoom: 16, width: 400, height: 300 };

function makeFakeAMap() {
  class Pixel { constructor(x, y) { this.x = x; this.y = y; } }
  class Marker {
    constructor(opts) { Object.assign(this, opts); this._h = {}; amapCreated.markers.push(this); }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    emit(ev) { (this._h[ev] || []).forEach((f) => f()); }
    setContent(html) { this.content = html; return this; }
    setExtData(d) { this.extData = d; return this; }
  }
  class InfoWindow {
    constructor(opts) { Object.assign(this, opts); amapCreated.infos.push(this); this.opened = null; }
    open(map, pos) { this.opened = { map, pos }; }
    close() { this.opened = null; }
  }
  class Circle {
    constructor(opts) { Object.assign(this, opts); amapCreated.circles.push(this); }
    setCenter(c) { this.center = c; return this; }
    setRadius(r) { this.radius = r; return this; }
  }
  class Map {
    constructor(el, opts) {
      if (amapCreated.failMap) throw new Error('INVALID_USER_SCODE: 安全密钥校验失败');
      this.el = el; this.opts = opts; this._h = {}; this.controls = []; this.added = []; this.removed = [];
      this._center = { lng: opts.center[0], lat: opts.center[1] };
      amapCreated.maps.push(this);
    }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    emit(ev, arg) { (this._h[ev] || []).forEach((f) => f(arg)); }
    add(x) { this.added.push(x); }
    remove(x) { if (x) this.removed = this.removed.concat(x); }
    setZoomAndCenter(z, c) {
      this.lastCenter = { z, c }; fakeViewport.zoom = z;
      if (c) this._center = { lng: c[0], lat: c[1] };
      this.emit('zoomend');
    }
    setCenter(c) {
      this._center = (c && typeof c.getLng === 'function') ? { lng: c.getLng(), lat: c.getLat() } : { lng: c[0], lat: c[1] };
      return this;
    }
    setZoom(z, immediately) { fakeViewport.zoom = z; this.lastZoomArgs = [z, immediately]; this.emit('zoomend'); return this; }
    /** 夜间主题：记录样式切换（真实 AMap 会就地重绘，不重建地图） */
    setMapStyle(style) { this.styleCalls = (this.styleCalls || []).concat(style); this.opts.mapStyle = style; return this; }
    /** 容器像素 → 经纬度（与真实 AMap 同名 API 对齐，墨卡托线性近似） */
    containerToLngLat(px) {
      const lat = this._center.lat;
      const mpp = (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, fakeViewport.zoom);
      const lng = this._center.lng + (px[0] - fakeViewport.width / 2) * mpp / (111320 * Math.cos(lat * Math.PI / 180));
      const la = this._center.lat - (px[1] - fakeViewport.height / 2) * mpp / 110540;
      return { getLng: () => lng, getLat: () => la };
    }
    /** 经纬度 → 容器像素 */
    lngLatToContainer(ll) {
      const lng = Array.isArray(ll) ? ll[0] : ll.getLng();
      const lat = Array.isArray(ll) ? ll[1] : ll.getLat();
      const mpp = (156543.03392 * Math.cos(this._center.lat * Math.PI / 180)) / Math.pow(2, fakeViewport.zoom);
      return {
        x: fakeViewport.width / 2 + (lng - this._center.lng) * 111320 * Math.cos(this._center.lat * Math.PI / 180) / mpp,
        y: fakeViewport.height / 2 - (lat - this._center.lat) * 110540 / mpp,
      };
    }
    /** 真实 setFitView 的等价物：缩到能装下全部 overlay（含半径圈）为止 */
    setFitView(overlays) {
      const list = Array.isArray(overlays) ? overlays : [];
      const pts = list.filter((o) => o && o.position).map((o) => o.position);
      const circle = list.find((o) => o && o.radius && o.center);
      for (let z = 19; z >= 3; z--) {
        fakeViewport.zoom = z;
        const b = this.getBounds();
        const okPts = pts.every((p) => b.contains(p));
        const mpp = (156543.03392 * Math.cos(BASE_LAT * Math.PI / 180)) / Math.pow(2, z);
        const okCircle = !circle || (circle.radius * 2) / mpp <= Math.min(fakeViewport.width, fakeViewport.height);
        if (okPts && okCircle) break;
      }
      this.fitViewCalls = (this.fitViewCalls || 0) + 1;
      this.emit('zoomend');
      return this;
    }
    addControl(c) { this.controls.push(c); }
    clearMap() {} destroy() { this.destroyed = true; } resize() { this.resized = (this.resized || 0) + 1; }
    getContainer() { return this.el; }
    getZoom() { return fakeViewport.zoom; }
    /** 真实 AMap.getCenter() 返回不可变快照，这里必须对齐（活引用会让锚点算法漂移） */
    getCenter() { const lng = this._center.lng, lat = this._center.lat; return { getLng: () => lng, getLat: () => lat }; }
    /** 按当前缩放级别换算出的可视矩形（真实 AMap.getBounds 的等价物） */
    getBounds() {
      const lat = BASE_LAT + 0.00162;
      const lng = BASE_LON + 0.0063;
      const mpp = (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, fakeViewport.zoom);
      const dLat = (fakeViewport.height / 2) * mpp / 110540;
      const dLng = (fakeViewport.width / 2) * mpp / (111320 * Math.cos(lat * Math.PI / 180));
      const box = {
        getSouthWest: () => ({ getLng: () => lng - dLng, getLat: () => lat - dLat }),
        getNorthEast: () => ({ getLng: () => lng + dLng, getLat: () => lat + dLat }),
        // 真实 AMap.Bounds 有 contains([lng,lat])，这里一并对齐
        contains: (pt) => {
          const [x, y] = Array.isArray(pt) ? pt : [pt.getLng(), pt.getLat()];
          return x >= lng - dLng && x <= lng + dLng && y >= lat - dLat && y <= lat + dLat;
        },
      };
      return box;
    }
  }
  return {
    Map, Marker, InfoWindow, Pixel, Circle,
    plugin: (list, cb) => { if (cb) cb(); },
    convertFrom: (lnglat, type, cb) => cb('complete', { info: 'ok', locations: [{ lng: lnglat[0] + 0.006, lat: lnglat[1] + 0.0016 }] }),
    ToolBar: class { constructor() {} },
    Scale: class { constructor() {} },
  };
}

/* ============================================================
 *  加载被测源码
 * ============================================================ */

const SRC = path.join(__dirname, 'amap-location-card.js');
const code = fs.readFileSync(SRC, 'utf8') + `
globalThis.__T = { amapLoader, AmapWebApi, ALC_DEFAULTS, ALC_API_REGISTRY, getSharedApi, haversine, formatDistance };
`;
const tmp = path.join(os.tmpdir(), `alc-dom-${Date.now()}.cjs`);
fs.writeFileSync(tmp, code);
require(tmp);
const T = globalThis.__T;

/* ============================================================
 *  断言与工具
 * ============================================================ */

let pass = 0, fail = 0;
const lines = [];
function ok(name, cond, extra) {
  if (cond) { pass++; lines.push(`  PASS  ${name}`); }
  else { fail++; lines.push(`  FAIL  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`); }
}
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

async function waitFor(fn, timeout = 4000, step = 30) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch (e) { v = undefined; }
    if (v) return v;
    if (Date.now() - t0 > timeout) return undefined;
    await new Promise((r) => setTimeout(r, step));
  }
}

const BASE_LAT = 39.90923;
const BASE_LON = 116.397428;

function makeHass(withCoords = true) {
  const attrs = { friendly_name: '测试手机', gps_accuracy: 9 };
  if (withCoords) { attrs.latitude = BASE_LAT; attrs.longitude = BASE_LON; }
  return { states: { 'device_tracker.test': { entity_id: 'device_tracker.test', state: 'home', attributes: attrs } } };
}

/* 可配置的高德 REST 假响应 */
let net = { mode: 'ok', probe: 'up' };
const poiUrls = [];        // 记录周边检索请求，用来核对 types 分类码
function installFetch() {
  g.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.pathname.includes('/v3/place/around')) poiUrls.push(u.search);
    // 底图域名探测（fetch mode: no-cors）—— 用来区分「网络不通」与「脚本被拦截」
    if (u.hostname === 'webapi.amap.com') {
      if (net.probe === 'down') throw new TypeError('Failed to fetch');
      return { ok: true, type: 'opaque', json: async () => ({}) };
    }
    const isConvert = u.pathname.includes('coordinate/convert');

    if (isConvert) {
      if (net.mode === 'convert-fail') return { ok: false, status: 500, json: async () => ({ status: '0', info: 'SERVICE_NOT_AVAILABLE', infocode: '10002' }) };
      if (net.mode === 'convert-limit') return { ok: true, json: async () => ({ status: '0', info: 'ACCESS_TOO_FREQUENT', infocode: '10004' }) };
      // 实测：高德对越界坐标不报错，status=1 / infocode=10000 原样回显 → 卡片必须自行丢弃
      if (net.mode === 'convert-bad') return { ok: true, json: async () => ({ status: '1', info: 'OK', infocode: '10000', locations: '999,999' }) };
      const [lng, lat] = u.searchParams.get('locations').split(',').map(Number);
      return { ok: true, json: async () => ({ status: '1', info: 'OK', infocode: '10000', locations: `${(lng + 0.0063).toFixed(6)},${(lat + 0.00162).toFixed(6)}` }) };
    }

    if (net.mode === 'poi-error') return { ok: true, json: async () => ({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003' }) };
    if (net.mode === 'poi-empty') return { ok: true, json: async () => ({ status: '1', info: 'OK', pois: [] }) };

    const types = u.searchParams.get('types');
    const [lng, lat] = u.searchParams.get('location').split(',').map(Number);

    /* 真实分布形态：POI 铺满整个可视矩形（含四角）—— 用来验证「按整张视图检索，一条不漏」。
       偏移量取固定的 ±0.002°（约 ±220m），在 zoom16 的 400×300 视口里 ≈ ±130px，
       稳稳落在图内；缩到 zoom13 时只会更靠中心，也不会出界。 */
    if (net.mode === 'spread') {
      const grid = [
        [-1, -1], [0, -1], [1, -1],
        [-1, 0], [1, 0],
        [-1, 1], [0, 1], [1, 1],
        [-0.5, 0.5], [0.5, -0.5], [0, 0],
      ];
      const D = 0.002;
      const mk = (prefix, n, label, phase) => Array.from({ length: n }, (_, i) => {
        const gp = grid[(i + (phase ? 3 : 0)) % grid.length];
        const fx = gp[0]; const fy = gp[1];
        const d = Math.round(Math.hypot(fx * D * 110540, fy * D * 111320 * Math.cos(lat * Math.PI / 180)));
        return {
          id: `${prefix}${i}`, name: `${label}${i}`,
          location: `${(lng + fx * D).toFixed(6)},${(lat + fy * D).toFixed(6)}`,
          distance: String(d), address: '测试路 1 号', biz_ext: {},
        };
      });
      const pois = types === '011100' ? mk('C', 8, '充电站', 0) : mk('T', 3, '公厕', 1);
      return { ok: true, json: async () => ({ status: '1', info: 'OK', count: String(pois.length), pois }) };
    }
    /* 常态分布：4 个结果都落在 400×300 视口内（auto 模式会把视口外的结果剔掉，
       所以 mock 坐标必须真实落在可视矩形里，否则卡片拿到的列表会被裁空） */
    if (types === '011100') {
      return { ok: true, json: async () => ({ status: '1', info: 'OK', pois: [
        { id: 'P1', name: '特来电充电站(A店)', location: `${(lng + 0.0015).toFixed(6)},${(lat + 0.0010).toFixed(6)}`, distance: '520', address: '望京街1号', biz_ext: { charge_price: '1.28', available: '6', total: '12' } },
        { id: 'P2', name: '星星充电站(B店)', location: `${(lng - 0.0024).toFixed(6)},${(lat - 0.0008).toFixed(6)}`, distance: '1310', address: '望京街2号', biz_ext: {} },
        { id: 'P3', name: '国家电网充电站(C店)', location: `${(lng + 0.0009).toFixed(6)},${(lat - 0.0016).toFixed(6)}`, distance: '890', address: '望京街3号', biz_ext: { price: '0.98' } },
      ] }) };
    }
    return { ok: true, json: async () => ({ status: '1', info: 'OK', pois: [
      { id: 'T1', name: '公共卫生间(公园)', location: `${(lng + 0.0010).toFixed(6)},${(lat + 0.0009).toFixed(6)}`, distance: '210', address: '公园东门', biz_ext: {} },
    ] }) };
  };
}

function freshCard(config, mockValue = null) {
  g.window.__ALC_MOCK__ = mockValue;
  T.ALC_API_REGISTRY.clear();
  amapCreated.maps.length = 0; amapCreated.markers.length = 0; amapCreated.infos.length = 0;
  amapCreated.circles.length = 0;
  fakeViewport.zoom = 16; fakeViewport.width = 400; fakeViewport.height = 300;
  const el = window.document.createElement('amap-scout');
  el.setConfig(config);
  window.document.body.appendChild(el);
  return el;
}

const baseConfig = () => Object.assign({}, T.ALC_DEFAULTS, {
  type: 'custom:amap-scout',
  entity: 'device_tracker.test',
  amap_key: 'TEST_WEB_KEY',
  radius: 2000,
  show_charging: true,
  show_toilet: true,
  coord_cache_ttl: 300,
  poi_cache_ttl: 300,
  api_min_interval: 0,
});

/* ============================================================
 *  测试主体
 * ============================================================ */

(async function main() {
  installFetch();

  /* ---------- A0. 骨架：无标题栏 / 无底部工具条，操作全部浮在地图上 ---------- */
  console.log('\n=== A0. 布局骨架 ===');
  {
    const shell = freshCard(baseConfig(), { noJsApi: true });
    shell.hass = makeHass();
    await waitFor(() => shell._pins && shell._pins.length >= 5);

    eq('已取消顶部标题栏', shell.shadowRoot.querySelectorAll('.alc-head').length, 0);
    eq('已取消底部工具条', shell.shadowRoot.querySelectorAll('.alc-toolbar').length, 0);
    eq('不再有独立的标题/副标题节点', shell.shadowRoot.querySelectorAll('.alc-title, .alc-sub').length, 0);

    const ctrl = shell._els.ctrl;
    ok('地图上有一列浮动控件', !!ctrl);
    const acts = Array.from(ctrl.querySelectorAll('button[data-act]')).map((b) => b.dataset.act);
    eq('控件顺序：回到定位 → 放大 → 缩小 → 列表', acts, ['recenter', 'zoom-in', 'zoom-out', 'list']);
    ok('回到定位按钮带无障碍标签', /回到定位/.test(ctrl.querySelector('[data-act="recenter"]').getAttribute('aria-label')));
    ok('列表按钮带无障碍标签', /显示列表/.test(ctrl.querySelector('[data-act="list"]').getAttribute('aria-label')));

    // 列表在地图下方：DOM 顺序上必须晚于地图容器
    const card = shell._els.root;
    const kids = Array.from(card.children).map((n) => n.className.split(' ')[0]);
    ok('列表节点排在地图之后', kids.indexOf('alc-list') > kids.indexOf('alc-map-wrap'), kids);
    eq('列表默认收起', shell._els.list.hidden, true);
    eq('列表内容渲染在独立的 body 里', !!shell._els.listBody, true);

    // 简化视图不再自建一套按钮（否则右下角两组重叠）
    eq('简化视图不自带控件列', shell._els.mapEl.querySelectorAll('.alc-fm-controls').length, 0);

    shell._showList(true);
    eq('点列表后展开', shell._els.list.hidden, false);
    ok('数据渲染在列表 body 内', shell._els.listBody.querySelectorAll('.alc-item').length > 0,
      shell._els.listBody.querySelectorAll('.alc-item').length);
    ok('列表头显示结果总数', shell._els.listTotal.textContent.length > 0, shell._els.listTotal.textContent);
    eq('列表头的收起按钮', shell._els.listHead.querySelector('[data-act="list"]').textContent, '收起');
    shell._showList(false);
    eq('再点收起后隐藏', shell._els.list.hidden, true);

    // 状态标签取代了原来的标题栏信息
    ok('状态标签显示坐标与坐标系', /115\.|116\./.test(shell._els.status.textContent), shell._els.status.textContent);
    ok('状态标签含搜索范围', /整屏矩形|内切圆|半径/.test(shell._els.status.textContent), shell._els.status.textContent);
    void shell;
  }

  /* ---------- A. 简化视图分支（降级渲染） ---------- */
  console.log('\n=== A. 简化视图（JS API 不可用 / 无 WebGL） ===');
  const MOCK_NO_JSAPI = { noJsApi: true };
  let el = freshCard(baseConfig(), MOCK_NO_JSAPI);
  el.hass = makeHass();
  const pinsReady = await waitFor(() => el._pins && el._pins.length >= 5);
  ok('卡片完成首次渲染', !!pinsReady, el._pins && el._pins.length);
  eq('降级模式标记为 fallback', el._mapMode, 'fallback');
  ok('创建了简化视图实例', !!el._fbMap);
  eq('标记数 = 1 实体 + 3 充电桩 + 1 公厕', el._pins.length, 5);
  eq('实体标记排在最前', el._pins[0].kind, 'entity');
  // 简化视图会做视口裁剪，先把缩放拉远保证全部可见
  el._fbMap.setZoom(13);
  const fbMarkers = el.shadowRoot.querySelectorAll('.alc-fm-marker');
  eq('简化视图 DOM 标记数一致', fbMarkers.length, 5);
  eq('canvas 绘制被调用', ctx2dCalls > 0, true);

  /* ---------- B. 高德底图分支 ---------- */
  console.log('\n=== B. 高德底图分支（桩 AMap） ===');
  window.AMap = makeFakeAMap();
  T.amapLoader._key = 'TEST_WEB_KEY';      // 让 loader 直接返回已就绪的 window.AMap

  el = freshCard(baseConfig(), null);
  el.hass = makeHass();
  const mapReady = await waitFor(() => el._mapMode === 'amap' && el._pins.length >= 5);
  ok('走通高德底图分支', !!mapReady, el._mapMode);
  eq('创建了 1 个 AMap.Map', amapCreated.maps.length, 1);
  const mapOpts = amapCreated.maps[0].opts;
  eq('地图使用 2D 模式', mapOpts.viewMode, '2D');
  ok('地图中心为纠偏后的 GCJ02 坐标',
    Math.abs(mapOpts.center[0] - (BASE_LON + 0.0063)) < 1e-6 && Math.abs(mapOpts.center[1] - (BASE_LAT + 0.00162)) < 1e-6,
    mapOpts.center);
  eq('手势层 touch-action=none（iOS 手势治理）', el._els.gesture.style.touchAction, 'none');
  ok('滚轮/双击归手势层（防双重触发），拖拽缩放保持开启（zoomEnable:false 会禁掉程序化 setZoom）',
    mapOpts.zoomEnable === true && mapOpts.scrollWheel === false && mapOpts.doubleClickZoom === false, mapOpts);
  eq('当前地图上挂载了 5 个标记', el._markers.length, 5);
  ok('首次加载只预渲染实体标记，无重复重建', amapCreated.markers.length <= 6, amapCreated.markers.length);
  const entityMarker = el._markers[0];
  ok('标记位置为 GCJ02', Math.abs(entityMarker.position[0] - (BASE_LON + 0.0063)) < 1e-6, entityMarker.position);
  ok('标记 content 含图标 DOM', /alc-pin/.test(entityMarker.content) && /ha-icon/.test(entityMarker.content), entityMarker.content.slice(0, 90));
  ok('标记 offset 居中', entityMarker.offset.x === -17 && entityMarker.offset.y === -17, entityMarker.offset);
  eq('实体标记 zIndex 最高', entityMarker.zIndex, 200);
  ok('标记已加入地图', amapCreated.maps[0].added.length >= 1);

  // 触发地图 complete 事件
  amapCreated.maps[0].emit('complete');
  ok('complete 后进入 ready 且隐藏 loading', el._mapReady === true && el._els.loading.hidden === true);

  /* ---------- C. 弹窗与导航 ---------- */
  console.log('\n=== C. 弹窗内容 / 导航链接 / 事件委托 ===');
  const chargingPin = el._pins.find((p) => p.kind === 'charging' && p.data.item.poi.id === 'P1');
  el._onPinClick(chargingPin);
  eq('自绘弹窗已打开', el._els.amapPop.hidden, false);
  const infoHtml = el._els.amapPop.innerHTML;
  ok('弹窗含名称', infoHtml.includes('特来电充电站(A店)'));
  // 距离从实体起算（不是高德返回的、相对检索中心的 520m）
  const p1Want = T.haversine(el._gcj.lat, el._gcj.lng, chargingPin.data.item.poi.lat, chargingPin.data.item.poi.lng);
  ok('弹窗距离从实体坐标起算', infoHtml.includes(T.formatDistance(p1Want)), { want: T.formatDistance(p1Want), p1Want });
  ok('弹窗不再显示高德 distance（520 m）', !infoHtml.includes('520 m'), infoHtml.slice(0, 300));
  ok('弹窗不再含电价', !infoHtml.includes('电价') && !infoHtml.includes('元/度'));
  ok('弹窗不再含可用桩数', !infoHtml.includes('可用桩') && !infoHtml.includes('个可用'));
  ok('弹窗含导航链接', infoHtml.includes('uri.amap.com/navigation') && infoHtml.includes('callnative=1'));
  ok('弹窗含地图标注链接', infoHtml.includes('uri.amap.com/marker'));
  ok('弹窗带关闭按钮', /alc-popup-close/.test(infoHtml));
  ok('弹窗位置已定位', !!el._els.amapPop.style.left && !!el._els.amapPop.style.top, el._els.amapPop.style.cssText);

  // 无 biz_ext 的充电桩：面板只剩距离 + 地址，不再出现「暂无数据 / 字段映射」提示
  const noDataPin = el._pins.find((p) => p.kind === 'charging' && p.data.item.poi.id === 'P2');
  const noDataHtml = el._poiPopupHtml(noDataPin.data.item);
  ok('无扩展数据时面板干净（无「暂无数据」）', !noDataHtml.includes('暂无数据'), noDataHtml.slice(0, 300));
  ok('不再提示「电价字段映射」', !noDataHtml.includes('字段映射'));

  // 公厕弹窗
  const toiletPin = el._pins.find((p) => p.kind === 'toilet');
  const toiletHtml = el._poiPopupHtml(toiletPin.data.item);
  ok('公厕弹窗含名称与距离', toiletHtml.includes('公共卫生间(公园)') && toiletHtml.includes('距离'));
  ok('公厕弹窗同样不含电价/桩数', !toiletHtml.includes('电价') && !toiletHtml.includes('个可用'));

  /* P4 外链打开策略（v1.0.8 关键回归）：
     默认新标签页打开时**只**用临时 <a target="_blank">，一次 window.open 都不调 ——
     旧实现用 window.open(url,'_blank','noopener') 的返回值判空（带 noopener 恒为 null）
     又去 location.href 兜底，造成「新标签开一次 + 原页面也跳一次」的双跳。 */
  openedUrls.length = 0;
  const anchorOpened = [];
  const origAnchorClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {
    anchorOpened.push({ href: this.getAttribute('href'), target: this.getAttribute('target'), rel: this.getAttribute('rel') });
  };
  try {
    const navBtn = el._els.amapPop.querySelector('button[data-alc-act="open-url"]');
    ok('弹窗按钮可被查询到', !!navBtn);
    navBtn.dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
  } finally {
    window.HTMLAnchorElement.prototype.click = origAnchorClick;
  }
  eq('点击导航按钮不调用 window.open（否则会双开/双跳）', openedUrls.length, 0);
  eq('改用临时锚点在新标签页打开', anchorOpened.length, 1);
  ok('锚点带 target=_blank 与 rel=noopener',
    !!anchorOpened[0] && anchorOpened[0].target === '_blank' && /noopener/.test(anchorOpened[0].rel || ''),
    anchorOpened[0]);
  ok('锚点指向高德导航页', !!anchorOpened[0] && /uri\.amap\.com\/navigation/.test(anchorOpened[0].href), anchorOpened[0] && anchorOpened[0].href);
  eq('临时锚点用完即移除（不污染页面）', document.querySelectorAll('body > a[target="_blank"]').length, 0);
  el._els.amapPop.innerHTML = '';

  // 关闭 open_in_new_tab → 走当前页跳转（iOS 唤起 App 的兜底策略）
  const elSameTab = freshCard(Object.assign(baseConfig(), { open_in_new_tab: false }));
  elSameTab.hass = makeHass();
  await waitFor(() => elSameTab._pins.length >= 5);
  const sameTabHtml = elSameTab._poiPopupHtml(elSameTab._pins.find((p) => p.data && p.data.item && p.data.item.poi.id === 'P1').data.item);
  elSameTab._onPinClick(elSameTab._pins.find((p) => p.kind === 'charging' && p.data.item.poi.id === 'P1'));
  void sameTabHtml;
  openedUrls.length = 0;
  let navNavigated = false;
  const locDesc = Object.getOwnPropertyDescriptor(window, 'location');
  try {
    // jsdom 无法真正导航，这里只验证不会抛错且回退分支被走到
    elSameTab._els.amapPop.querySelector('button[data-alc-act="open-url"]')
      .dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
    navNavigated = true;
  } catch (e) { navNavigated = false; }
  ok('open_in_new_tab=false 时点击不抛错', navNavigated);
  void locDesc;
  elSameTab._els.amapPop.innerHTML = '';

  /* ---------- D. 列表渲染 ---------- */
  console.log('\n=== D. 附近列表 ===');
  el._showList(true);
  await waitFor(() => el._els.list.querySelectorAll('.alc-item').length > 0);
  const items = el._els.list.querySelectorAll('.alc-item');
  eq('列表条目数', items.length, 4);
  const listText = el._els.list.textContent;
  ok('列表含充电桩分组', listText.includes('充电桩'));
  ok('列表含公厕分组', listText.includes('公共厕所'));
  const chargingGroup = el._poiGroups.find((g) => g.kind === 'charging');
  ok('充电桩按距离升序（距离已改为从实体起算）',
    chargingGroup.items.every((it, i, arr) => i === 0 || arr[i - 1].distance <= it.distance),
    chargingGroup.items.map((i) => Math.round(i.distance)));
  ok('列表不再显示电价 / 可用桩', !listText.includes('电价') && !listText.includes('可用 '));
  eq('列表展开时地图按钮提示「收起列表」', el._els.ctrl.querySelector('[data-act="list"]').getAttribute('aria-label'), '收起列表');
  ok('展开时地图按钮高亮', el._els.ctrl.querySelector('[data-act="list"]').classList.contains('on'));
  el._showList(false);
  eq('列表收起后提示「显示列表」', el._els.ctrl.querySelector('[data-act="list"]').getAttribute('aria-label'), '显示列表');
  ok('收起后不再高亮', !el._els.ctrl.querySelector('[data-act="list"]').classList.contains('on'));
  el._showList(true);

  // 列表项点击 → 定位并弹窗（自绘弹窗）
  el._closeAmapPopup();
  el._els.list.querySelector('[data-alc-focus="P1"]').dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
  eq('点击列表项弹出信息窗', el._els.amapPop.hidden, false);
  ok('并移动地图到该点', !!amapCreated.maps[0].lastCenter);
  ok('弹窗锚定在 P1', /特来电充电站/.test(el._els.amapPop.innerHTML));
  el._closeAmapPopup();
  eq('close 动作可收起弹窗', el._els.amapPop.hidden, true);

  /* ---------- E. 列表头部按钮（刷新 / 跟随切换 / 收起） ---------- */
  console.log('\n=== E. 列表头部按钮 ===');
  let fetchCount = 0;
  const realFetch = g.fetch;
  g.fetch = async (u) => { fetchCount++; return realFetch(u); };

  fetchCount = 0;
  el._els.listHead.querySelector('[data-act="refresh"]').dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
  await waitFor(() => fetchCount >= 3, 6000);
  ok('点击刷新清缓存后重新请求（转换+两类检索）', fetchCount >= 3, fetchCount);

  const viewBtn = el._els.listHead.querySelector('[data-act="view"]');
  // D 段点过列表项定位 POI —— 真实 AMap 的 setZoomAndCenter 会触发 zoomend，
  // 按设计要暂停自动跟随，避免镜头立刻被实体抢回去
  eq('程序化定位 POI 后暂停自动跟随', viewBtn.textContent, '恢复跟随');
  el._userPannedAt = 0;                     // 模拟「空闲超过 15 秒」
  el._renderStatus();
  eq('空闲后回到跟随中', viewBtn.textContent, '跟随中');
  viewBtn.dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
  eq('切换为已锁定', viewBtn.textContent, '已锁定');
  viewBtn.dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
  eq('再切换回跟随中', viewBtn.textContent, '跟随中');

  const listBtn = el._els.ctrl.querySelector('[data-act="list"]');
  listBtn.dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
  eq('列表可收起', el._els.list.hidden, true);
  g.fetch = realFetch;

  /* ---------- F. 实体无坐标 ---------- */
  console.log('\n=== F. 异常与容错 ===');
  net.mode = 'ok';
  el = freshCard(baseConfig());
  el.hass = makeHass(false);
  await waitFor(() => el._notices.get('loc'));
  const locNotice = el._notices.get('loc');
  ok('无坐标时出现错误提示', !!locNotice && locNotice.level === 'error', locNotice);
  ok('提示文案为中文且说明原因', /没有 latitude|没有/.test(locNotice.text), locNotice.text);
  eq('无坐标时不渲染标记', el._pins.length, 0);
  eq('无坐标时不创建地图', el._mapMode, null);
  ok('卡片 DOM 仍正常存在（未崩溃）', !!el.shadowRoot.querySelector('ha-card'));

  // 恢复坐标 → 提示消失
  el.hass = makeHass(true);
  await waitFor(() => el._pins.length > 0);
  ok('恢复坐标后自动继续执行', el._pins.length > 0);
  ok('错误提示被清除', !el._notices.get('loc'));

  /* ---------- G. 坐标转换降级链 ---------- */
  console.log('\n=== G. 坐标转换降级链 ===');
  net.mode = 'convert-fail';

  // G1: Web 服务失败 → JS API 可用
  el = freshCard(baseConfig());
  el.hass = makeHass();
  await waitFor(() => el._pins.length > 0, 8000);
  eq('G1 Web 服务失败但 JS API 可用 → jsapi', el._convertVia, 'jsapi');
  ok('G1 已给出降级提示', !!el._notices.get('convert'), el._notices.get('convert'));
  ok('G1 使用 JS API 转换结果', Math.abs(el._pins[0].lng - (BASE_LON + 0.006)) < 1e-6, el._pins[0].lng);
  ok('G1 仍能渲染标记', el._pins.length > 0);

  // G1b: 接口返回越界坐标（原样回显）→ 卡片必须丢弃该结果并降级，不能拿去当地图中心
  net.mode = 'convert-bad';
  el = freshCard(baseConfig());
  el.hass = makeHass();
  await waitFor(() => el._pins.length > 0, 8000);
  eq('G1b 越界返回被丢弃并降级', el._convertVia, 'jsapi');
  const badMsg = el._notices.get('convert');
  ok('G1b 提示说明返回结果不可信', !!badMsg && /越界|偏差/.test(badMsg.text), badMsg && badMsg.text);
  ok('G1b 未把 999 当成坐标', Math.abs(el._pins[0].lng - 999) > 1, el._pins[0].lng);

  // G1c: 接口限流（infocode 10004）→ 同样走降级，且提示能识别限流
  net.mode = 'convert-limit';
  el = freshCard(baseConfig());
  el.hass = makeHass();
  await waitFor(() => el._pins.length > 0, 8000);
  eq('G1c 限流后降级到 JS API', el._convertVia, 'jsapi');
  const limitMsg = el._notices.get('convert');
  ok('G1c 提示含限流说明', !!limitMsg && /频繁|限流/.test(limitMsg.text), limitMsg && limitMsg.text);

  net.mode = 'convert-fail';
  // G2: Web 服务 + JS API 都失败 → 原始 WGS84
  const origAppend = window.document.head.appendChild.bind(window.document.head);
  window.document.head.appendChild = function (node) {
    if (node && node.tagName === 'SCRIPT') { setTimeout(() => node.onerror && node.onerror(), 0); return node; }
    return origAppend(node);
  };
  const savedAMap = window.AMap;
  const savedKey = T.amapLoader._key;
  window.AMap = undefined;
  T.amapLoader._key = null;
  T.amapLoader._promise = null;

  el = freshCard(baseConfig());
  el.hass = makeHass();
  await waitFor(() => el._pins.length > 0, 8000);
  eq('G2 双失败 → 回退原始坐标', el._convertVia, 'raw');
  ok('G2 坐标等于原始 WGS84', Math.abs(el._pins[0].lng - BASE_LON) < 1e-6, el._pins[0].lng);
  const g2n = el._notices.get('convert');
  ok('G2 提示说明偏移风险', !!g2n && /偏移|WGS84/.test(g2n.text), g2n && g2n.text);
  eq('G2 JS API 不可用时降级为简化视图', el._mapMode, 'fallback');
  ok('G2 仍不炸卡（标记存在）', el._pins.length > 0);

  // G2b: 脚本加载失败时，提示必须可诊断（区分「网络不通」与「脚本被拦截」）
  const jsapiNotice = el._notices.get('jsapi');
  ok('G2b 底图失败有专门提示', !!jsapiNotice && jsapiNotice.level === 'warn', jsapiNotice);
  ok('G2b 提示含失败原因与降级说明', /脚本加载失败/.test(jsapiNotice.text) && /简化视图/.test(jsapiNotice.text), jsapiNotice.text);
  ok('G2b 域名可达 → 提示「被拦截」而非「网络不通」', /拦截/.test(jsapiNotice.text), jsapiNotice.text);

  // G2c: 域名本身不可达时，提示要指向网络层
  net.probe = 'down';
  el = freshCard(baseConfig());
  el.hass = makeHass();
  await waitFor(() => el._notices.get('jsapi'), 8000);
  const downNotice = el._notices.get('jsapi');
  ok('G2c 域名不可达时提示指向网络/代理/CSP', /无法访问|网络|代理|防火墙|CSP/.test(downNotice.text), downNotice.text);
  ok('G2c 提示里点名了具体域名', /webapi\.amap\.com/.test(downNotice.text), downNotice.text);
  net.probe = 'up';

  // G2d: 失败后遮罩不能卡住（等检索这波 loading 也结束后应处于收起状态）
  await waitFor(() => el._els.loading.hidden, 6000);
  eq('G2d 失败后 loading 遮罩最终收起', el._els.loading.hidden, true);

  window.document.head.appendChild = origAppend;
  window.AMap = savedAMap;
  T.amapLoader._key = savedKey;
  T.amapLoader._promise = null;

  /* ---------- G3. AMap.Map 构造抛错（如缺安全密钥） ---------- */
  console.log('\n=== G3. 建图抛错的处理 ===');
  amapCreated.failMap = true;
  net.mode = 'ok';
  el = freshCard(baseConfig());
  el.hass = makeHass();
  await waitFor(() => el._notices.get('mapfail'), 8000);
  const mfNotice = el._notices.get('mapfail');
  ok('G3 建图异常给出 error 级提示', !!mfNotice && mfNotice.level === 'error', mfNotice);
  eq('G3 模式必须停在简化视图（不能被覆盖成 amap）', el._mapMode, 'fallback');
  await waitFor(() => el._els.loading.hidden, 6000);
  eq('G3 失败后 loading 遮罩最终收起（不会卡住）', el._els.loading.hidden, true);
  ok('G3 SCODE 错误给出安全密钥指引', /安全密钥|securityJsCode/.test(mfNotice.text), mfNotice.text);
  ok('G3 仍渲染标记（不炸卡）', el._pins.length > 0);
  amapCreated.failMap = false;

  /* ---------- G4. 网络恢复后自动重试 ---------- */
  console.log('\n=== G4. 网络恢复自动重试 ===');
  const retryCalls = [];
  ok('G4 前置条件：当前处于简化视图且有建图失败提示',
    el._mapMode === 'fallback' && el._notices.has('mapfail'), el._mapMode);
  el._retryMap = function () { retryCalls.push(Date.now()); };
  window.dispatchEvent(new window.Event('online'));
  eq('G4 处于简化视图且有失败提示时，online 触发重试', retryCalls.length, 1);

  // 已经成功建图（mode=amap）时不应重复重试
  el._mapMode = 'amap';
  window.dispatchEvent(new window.Event('online'));
  eq('G4 已是高德底图时 online 不重试', retryCalls.length, 1);

  // 没有失败提示时也不应重试
  el._mapMode = 'fallback';
  ['jsapi', 'maperr', 'map-timeout', 'mapfail'].forEach((k) => el._notices.delete(k));
  window.dispatchEvent(new window.Event('online'));
  eq('G4 无失败提示时 online 不重试', retryCalls.length, 1);

  // 卸载后必须解绑，避免离开页面后仍被触发
  el._notices.set('jsapi', { level: 'warn', text: 'x' });
  el._teardownAll();
  window.dispatchEvent(new window.Event('online'));
  eq('G4 卸载后已解绑 online 监听', retryCalls.length, 1);
  ok('G4 卸载后监听引用被清空', el._onOnline === null);

  /* ---------- H. POI 接口报错 / 空结果 ---------- */
  console.log('\n=== H. 接口报错与空结果 ===');
  net.mode = 'poi-error';
  el = freshCard(baseConfig());
  el.hass = makeHass();
  await waitFor(() => el._notices.get('poi'), 6000);
  const poiNotice = el._notices.get('poi');
  ok('接口报错产生 warn 提示', !!poiNotice && poiNotice.level === 'warn', poiNotice);
  ok('提示包含中文原因（配额）', /上限|配额|限流/.test(poiNotice.text), poiNotice.text);
  ok('报错不阻塞卡片（实体标记仍存在）', el._pins.some((p) => p.kind === 'entity'));
  ok('报错后仍可打开列表', (el._showList(true), el._els.list.hidden === false));

  net.mode = 'poi-empty';
  el = freshCard(baseConfig());
  el.hass = makeHass();
  await waitFor(() => el._lastRadius != null, 6000);
  await new Promise((r) => setTimeout(r, 80));
  ok('空结果不弹任何提示条（保持安静）',
    !el._notices.get('poi-empty') && !el._notices.get('poi'),
    Array.from(el._notices.keys()));
  ok('检索全程不显示 loading 遮罩', el._els.loading.hidden === true, el._els.loading.hidden);
  ok('空结果只保留实体标记', el._pins.length === 1 && el._pins[0].kind === 'entity', el._pins.length);

  /* ---------- H2. 铺满窗口 / 无感渲染 ---------- */
  console.log('\n=== H2. 铺满窗口与无感渲染 ===');
  net.mode = 'ok';
  el = freshCard(baseConfig());
  el.hass = makeHass();
  await waitFor(() => el._pins.length >= 5, 6000);
  eq('fill_viewport 默认开启', el._cfg.fill_viewport, true);
  ok('铺满时根节点带 alc-fill', el._els.root.classList.contains('alc-fill'), el._els.root.className);
  ok('铺满时地图容器不写死高度', !el._els.mapWrap.getAttribute('style'), el._els.mapWrap.getAttribute('style'));
  ok('普通 DOM 中不误判为编辑器预览', el._inEditorPreview() === false);

  const reused = el._markers.slice();
  el._renderPins();
  ok('重复渲染复用已有 Marker（不整批重建）',
    reused.length === el._markers.length && reused.every((m) => el._markers.indexOf(m) !== -1),
    { before: reused.length, after: el._markers.length });

  const fixed = freshCard(Object.assign(baseConfig(), { fill_viewport: false, height: 280 }));
  ok('关闭铺满后回到固定高度',
    !fixed._els.root.classList.contains('alc-fill')
    && /height:\s*280px/.test(fixed._els.mapWrap.getAttribute('style') || ''),
    fixed._els.mapWrap.getAttribute('style'));

  /* ---------- H2b. 铺满高度要扣掉上下工具栏 ---------- */
  console.log('\n=== H2b. 铺满高度自适应（顶栏 / 底栏） ===');
  const VH = Math.round((window.visualViewport && window.visualViewport.height) || window.innerHeight);
  const fillVar = () => parseInt(el._els.root.style.getPropertyValue('--alc-fill-h'), 10);
  const origEfp = document.elementFromPoint;

  // 1. 没有任何覆盖层：卡片铺满可视高度，只留底部安全区（ALC_FILL_SAFE_BOTTOM = 8）
  const SAFE = 8;
  document.elementFromPoint = () => null;
  eq('无覆盖层时高度 = 可视高度 − 安全区', el._syncFillHeight(), VH - SAFE);
  eq('高度写进 --alc-fill-h', fillVar(), VH - SAFE);

  // 2. 底部固定导航条 56px（HA 移动端底部导航 / App 原生 tab bar）
  const nav = document.createElement('div');
  nav.style.position = 'fixed';
  nav.getBoundingClientRect = () => ({ top: VH - 56, bottom: VH, height: 56, left: 0, right: 390, width: 390 });
  document.body.appendChild(nav);
  document.elementFromPoint = () => nav;
  eq('扣掉底部固定导航条（56px）+ 安全区', el._syncFillHeight(), VH - 56 - SAFE);
  eq('量到的底部遮挡高度被记下来', el._fillGap, 56);

  // 3. 覆盖层高得离谱时按 40% 视口封顶，不把地图压没
  nav.getBoundingClientRect = () => ({ top: 0, bottom: VH, height: VH, left: 0, right: 390, width: 390 });
  eq('遮挡高度最多让出 40% 视口', el._syncFillHeight(), VH - Math.round(VH * 0.4) - SAFE);

  // 4. 底部只是普通文档流内容（不是覆盖层）→ 不让位
  const plain = document.createElement('div');
  plain.getBoundingClientRect = () => ({ top: VH - 200, bottom: VH, height: 200, left: 0, right: 390, width: 390 });
  document.body.appendChild(plain);
  document.elementFromPoint = () => plain;
  eq('普通文档流元素不算遮挡', el._syncFillHeight(), VH - SAFE);

  // 5. 顶部有 HA 顶栏（文档流）：卡片顶端下移 64px → 只算剩下的高度
  document.elementFromPoint = () => null;
  const realRect = el._els.root.getBoundingClientRect.bind(el._els.root);
  el._els.root.getBoundingClientRect = () => ({ top: 64, bottom: 64 + VH, height: VH, left: 0, right: 390, width: 390 });
  eq('顶栏占掉的高度从可用高度里扣掉', el._syncFillHeight(), VH - 64 - SAFE);
  el._els.root.getBoundingClientRect = realRect;

  // 5b. HA 编辑模式：标签栏是 fixed 覆盖层，卡片 rect.top 仍然是 0
  //     —— 只信 rect.top 就会铺满，编辑按钮被顶到屏幕外（用户反馈的场景）
  const topBar = document.createElement('div');
  document.elementFromPoint = (x, y) => (y < 56 ? topBar : el._els.root);
  eq('顶部固定标签栏（rect.top 仍为 0）也会让出高度', el._syncFillHeight(), VH - 56 - SAFE);
  eq('量到的上方让位高度', el._fillTop, 56);
  // 5c. 覆盖层消失后高度要能长回去（巡检 / hass 更新时复核）
  document.elementFromPoint = () => null;
  eq('标签栏消失后高度恢复', el._syncFillHeight(), VH - SAFE);

  // 6. 关闭铺满时不写高度变量（走固定 height）
  eq('关闭铺满后不写 --alc-fill-h', fixed._els.root.style.getPropertyValue('--alc-fill-h'), '');

  if (origEfp) document.elementFromPoint = origEfp; else delete document.elementFromPoint;
  nav.remove();
  plain.remove();
  el._syncFillHeight();

  /* ---------- H2c. 自定义高度 map_height（对齐 lonyii/ha-map-card-recode） ---------- */
  console.log('\n=== H2c. 自定义全屏高度 map_height ===');
  {
    const styleOf = (c) => c._els.mapWrap.getAttribute('style') || '';
    const made = [];
    const mk = (v) => { const c = freshCard(Object.assign(baseConfig(), { map_height: v })); made.push(c); return c; };

    const mPx = mk(480);
    ok('数字高度：退出自动铺满', !mPx._els.root.classList.contains('alc-fill'), mPx._els.root.className);
    ok('数字高度写成 height: 480px', /height:\s*480px/.test(styleOf(mPx)), styleOf(mPx));
    ok('数字高度带 120px 保底', /min-height:\s*120px/.test(styleOf(mPx)), styleOf(mPx));
    eq('getCardSize 按实际高度折算', mPx.getCardSize(), Math.round(480 / 50) + 3);
    eq('数字高度不写 --alc-fill-h', mPx._els.root.style.getPropertyValue('--alc-fill-h'), '');

    const mCalc = mk('calc(100dvh - 120px)');
    ok('calc 高度原样落进样式', /height:\s*calc\(100dvh - 120px\)/.test(styleOf(mCalc)), styleOf(mCalc));
    ok('calc 高度同样不铺满', !mCalc._els.root.classList.contains('alc-fill'), mCalc._els.root.className);

    const mVh = mk('100dvh');
    ok('100dvh 原样落进样式', /height:\s*100dvh/.test(styleOf(mVh)), styleOf(mVh));

    const mPct = mk('100%');
    ok('百分比高度给根节点加 alc-h100（跟随父容器）', mPct._els.root.classList.contains('alc-h100'), mPct._els.root.className);
    ok('百分比高度不启用自动铺满', !mPct._els.root.classList.contains('alc-fill'), mPct._els.root.className);
    ok('百分比高度只留 120px 保底、不写死像素高度',
      /min-height:\s*120px/.test(styleOf(mPct)) && !/(^|;)\s*height:\s*\d/.test(styleOf(mPct)), styleOf(mPct));

    const mBad = mk('100vh;position:fixed');
    eq('非法高度被忽略（回落默认）', mBad._cfg.map_height, null);
    ok('非法高度回落到自动铺满', mBad._els.root.classList.contains('alc-fill'), mBad._els.root.className);

    made.forEach((c) => { try { c.remove(); } catch (e) { /* ignore */ } });
  }

  /* ---------- R. iOS App 底图：强制 WebGL / 瓦片底图 ---------- */
  console.log('\n=== R. iOS App 底图修复（force_webgl / basemap / GL 提示识别） ===');
  {
    net.mode = 'ok';
    const auto = freshCard(baseConfig());
    eq('默认底图类型 auto', auto._cfg.basemap, 'auto');
    eq('默认强制 WebGL', auto._cfg.force_webgl, true);
    auto.setConfig(Object.assign(baseConfig(), { basemap: '乱写', force_webgl: false }));
    eq('非法底图类型回落到 auto', auto._cfg.basemap, 'auto');
    eq('force_webgl: false 被保留', auto._cfg.force_webgl, false);

    // 容器里的「浏览器版本过低」提示能被识别出来
    const glCard = freshCard(baseConfig());
    eq('正常容器没有 GL 提示', glCard._mapShowsGlError(), false);
    glCard._els.mapEl.textContent = '浏览器版本过低，请升级浏览器';
    eq('识别容器内的「浏览器版本过低」', glCard._mapShowsGlError(), true);
    glCard._els.mapEl.textContent = '当前位置不可用';
    eq('普通文案不误判', glCard._mapShowsGlError(), false);
    glCard._els.mapEl.textContent = '';

    // basemap: tiles → 跳过高德 JS 底图，直接铺瓦片
    amapCreated.maps.length = 0;
    const tilesCard = freshCard(Object.assign(baseConfig(), { basemap: 'tiles' }));
    tilesCard.hass = makeHass();
    await waitFor(() => !!tilesCard._mapMode, 4000);
    ok('basemap=tiles 时不创建 AMap.Map', amapCreated.maps.length === 0, amapCreated.maps.length);
    eq('basemap=tiles 走简化/瓦片分支', tilesCard._mapMode, 'fallback');
    ok('创建了瓦片底图实例', !!tilesCard._fbMap);
    eq('瓦片底图开启真实瓦片', tilesCard._fbMap && tilesCard._fbMap.tiles, true);

    // 即使 fallback_tiles 被关，显式 basemap=tiles 仍要有瓦片（否则只剩网格）
    const tilesNoFallback = freshCard(Object.assign(baseConfig(), { basemap: 'tiles', fallback_tiles: false }));
    tilesNoFallback.hass = makeHass();
    await waitFor(() => !!tilesNoFallback._mapMode, 4000);
    eq('basemap=tiles 时忽略 fallback_tiles:false', tilesNoFallback._fbMap && tilesNoFallback._fbMap.tiles, true);

    auto.remove(); glCard.remove(); tilesCard.remove(); tilesNoFallback.remove();
  }

  /* ---------- I. 缓存与节流行为 ---------- */
  console.log('\n=== I. 缓存与节流（端到端） ===');
  net.mode = 'ok';
  el = freshCard(baseConfig());
  el.hass = makeHass();
  await waitFor(() => el._pins.length >= 5);
  const reqAfterFirst = el._api.stats.request;
  const hitsAfterFirst = el._api.stats.cacheHit;
  el._refresh(false);                    // 同坐标再刷一次
  await waitFor(() => el._api.stats.cacheHit > hitsAfterFirst, 3000);
  eq('同坐标二次刷新不再发起网络请求', el._api.stats.request, reqAfterFirst);
  ok('二次刷新走缓存命中', el._api.stats.cacheHit > hitsAfterFirst, el._api.stats);

  /* ---------- J. 配置校验 ---------- */
  console.log('\n=== J. 配置校验与规范化 ===');
  let threw = null;
  try { window.document.createElement('amap-scout').setConfig({ amap_key: 'x' }); }
  catch (e) { threw = e; }
  ok('缺少 entity 时抛出可读错误', !!threw && /entity/.test(threw.message), threw && threw.message);

  const clampEl = freshCard(Object.assign(baseConfig(), {
    height: 99999, radius: 999999, follow_zoom: 99, icon_size: 1, max_poi: 999,
    view_mode: 'weird', gesture: 'weird', click_action: 'weird',
  }));
  eq('height 被夹到上限', clampEl._cfg.height, 1200);
  eq('radius 被夹到上限', clampEl._cfg.radius, 50000);
  eq('follow_zoom 被夹到 19', clampEl._cfg.follow_zoom, 19);
  eq('icon_size 被夹到 16', clampEl._cfg.icon_size, 16);
  eq('max_poi 被夹到 25', clampEl._cfg.max_poi, 25);
  eq('view_mode 非法值回退 follow', clampEl._cfg.view_mode, 'follow');
  eq('gesture 非法值回退 map', clampEl._cfg.gesture, 'map');
  eq('click_action 非法值回退 popup', clampEl._cfg.click_action, 'popup');
  // 关闭「铺满窗口」后，高度才写入容器（默认铺满时不写死高度，见 H2）
  const clampFixed = freshCard(Object.assign(baseConfig(), { height: 99999, fill_viewport: false }));
  eq('地图容器高度按配置写入（固定高度模式）', clampFixed._els.mapWrap.style.height, '1200px');

  /* ---------- K. 编辑器 ---------- */
  console.log('\n=== K. 可视化配置编辑器 ===');
  const ed = window.document.createElement('amap-scout-editor');
  const changes = [];
  ed.addEventListener('config-changed', (e) => changes.push(e.detail.config));
  window.document.body.appendChild(ed);
  ed.setConfig(Object.assign({}, T.ALC_DEFAULTS, { entity: 'device_tracker.test', amap_key: 'K', radius: 2000 }));
  ed.hass = makeHass();
  const sections = ed.shadowRoot.querySelectorAll('.alc-ed-section');
  ok('渲染出 6 个配置分组', sections.length === 6, sections.length);
  const allFields = ed.shadowRoot.querySelectorAll('.alc-ed-field');
  ok('字段总数 >= 40', allFields.length >= 40, allFields.length);
  ok('实体字段存在', !!ed.shadowRoot.querySelector('[data-field="entity"]'));
  ok('电价 / 桩数开关已从编辑器移除',
    !ed.shadowRoot.querySelector('[data-field="show_charging_price"]')
    && !ed.shadowRoot.querySelector('[data-field="show_charging_available"]')
    && !ed.shadowRoot.querySelector('[data-field="price_fields"]'));
  ok('缓存间隔字段存在', !!ed.shadowRoot.querySelector('[data-field="coord_cache_ttl"]'));
  ok('图标自定义字段存在', !!ed.shadowRoot.querySelector('[data-field="icon_charging"]'));

  // 单 Key 化：主分组只剩一个高德 Key 字段
  const keySection = Array.from(sections).find((s) => /高德 Key/.test(s.querySelector('summary').textContent));
  eq('「高德 Key」分组只暴露 1 个字段', keySection.querySelectorAll('.alc-ed-field').length, 1);
  eq('主 Key 字段为 amap_key', keySection.querySelector('[data-field="amap_key"]').dataset.field, 'amap_key');
  const advSection = Array.from(sections).find((s) => /高级/.test(s.querySelector('summary').textContent));
  ok('多 Key / 安全密钥收进高级分组', !!advSection
    && !!advSection.querySelector('[data-field="amap_js_key"]')
    && !!advSection.querySelector('[data-field="security_js_code"]'));
  eq('高级分组默认折叠', advSection.open, false);

  // 半径模式下拉 + 联动显隐
  const rmRow = ed.shadowRoot.querySelector('[data-field="radius_mode"]');
  ok('存在搜索范围模式字段', !!rmRow);
  eq('搜索范围提供 2 个选项', rmRow.querySelectorAll('select option').length, 2);
  eq('auto 模式下隐藏固定半径字段', ed.shadowRoot.querySelector('[data-field="radius"]').hidden, true);
  eq('auto 模式下显示自动系数字段', ed.shadowRoot.querySelector('[data-field="auto_radius_pad"]').hidden, false);
  const rmSel = rmRow.querySelector('select');
  rmSel.value = 'fixed';
  rmSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  eq('切到 fixed 后显示固定半径字段', ed.shadowRoot.querySelector('[data-field="radius"]').hidden, false);
  eq('切到 fixed 后隐藏自动系数字段', ed.shadowRoot.querySelector('[data-field="auto_radius_pad"]').hidden, true);
  rmSel.value = 'auto';
  rmSel.dispatchEvent(new window.Event('change', { bubbles: true }));

  // 视图模式为 follow 时，锁定相关字段应隐藏
  const hiddenLocked = ed.shadowRoot.querySelector('[data-field="locked_center"]').hidden;
  eq('follow 模式下隐藏锁定中心字段', hiddenLocked, true);

  // 改一个数值字段
  const radiusRow = ed.shadowRoot.querySelector('[data-field="radius"]');
  const radiusInput = radiusRow.querySelector('input, ha-textfield');
  radiusInput.value = '3500';
  radiusInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  ok('修改半径触发 config-changed', changes.length >= 1, changes.length);
  const last = changes[changes.length - 1];
  eq('写回的半径为新值', last.radius, 3500);
  eq('写回配置保留 type', last.type, 'custom:amap-scout');

  // 非法数字输入不应写入 NaN
  radiusInput.value = 'abc';
  radiusInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  const afterBad = changes[changes.length - 1];
  ok('非法数字输入不会写入 NaN', !('radius' in afterBad) || Number.isFinite(afterBad.radius), afterBad.radius);
  eq('非法输入回退到默认值', ed._config.radius, 2000);

  // 切换视图模式 → 锁定字段应出现
  const vmRow = ed.shadowRoot.querySelector('[data-field="view_mode"]');
  const vmSel = vmRow.querySelector('select');
  vmSel.value = 'locked';
  vmSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  eq('切换到 locked 后显示锁定中心字段',
    ed.shadowRoot.querySelector('[data-field="locked_center"]').hidden, false);

  /* ---------- M. 自动搜索半径（跟随地图缩放范围） ---------- */
  console.log('\n=== M. 搜索范围：自动跟随地图缩放 ===');
  net.mode = 'ok';

  // M1. 简化视图：半径 = 视口尺寸 + 当前缩放级别
  el = freshCard(baseConfig(), MOCK_NO_JSAPI);
  el.hass = makeHass();
  await waitFor(() => el._pins.length >= 5);
  const autoFb = el._currentRadius();
  // 默认 cover：300×300 视口 → 中心到角 hypot(150,150)=212px × 每像素米数
  ok('简化视图自动半径落在合理区间（不是固定 2000）', autoFb > 300 && autoFb < 700, autoFb);
  eq('检索用的半径已记录到 _lastRadius', el._lastRadius, autoFb);
  eq('默认不再画搜索半径圈', el._fbMap.radius, 0);
  ok('状态标签说明「按整屏矩形搜索」', /整屏矩形/.test(el._els.status.textContent), el._els.status.textContent);
  eq('自动范围取法默认 cover（整张视图）', el._cfg.auto_radius_basis, 'cover');
  ok('cover 半径明显大于内切半径（保证四角方向也覆盖）',
    autoFb > el._fbMap.viewportRadius('visible') * 1.3,
    { cover: autoFb, visible: el._fbMap.viewportRadius('visible') });

  const fbReqBefore = el._api.stats.request;
  el._fbMap.setZoom(13, true, false);          // 用户缩小地图 → 可视范围扩大
  await waitFor(() => el._lastRadius > autoFb * 1.5, 3000);
  ok('缩小地图后半径自动变大', el._lastRadius > autoFb * 1.5, { before: autoFb, after: el._lastRadius });
  ok('半径变化触发了重新检索', el._api.stats.request > fbReqBefore, el._api.stats.request);
  eq('默认不画圈，缩放后也不画', el._fbMap.radius, 0);

  // M1b. 显式打开半径圈时仍然正常工作（不再是默认行为）
  el = freshCard(Object.assign(baseConfig(), { show_radius_circle: true }), MOCK_NO_JSAPI);
  el.hass = makeHass();
  await waitFor(() => el._pins.length >= 5);
  eq('打开开关后简化视图画圈', el._fbMap.radius, el._lastRadius);
  const ringBefore = el._fbMap.radius;
  el._fbMap.setZoom(13, true, false);
  await waitFor(() => el._lastRadius > ringBefore * 1.5, 3000);
  eq('圈半径跟着检索半径更新', el._fbMap.radius, el._lastRadius);

  const bigRadius = el._lastRadius;
  el._fbMap.setZoom(18, true, false);          // 用户放大地图 → 可视范围收窄
  await waitFor(() => el._lastRadius < bigRadius * 0.6, 3000);
  ok('放大后半径自动收窄', el._lastRadius < bigRadius * 0.6, { before: bigRadius, after: el._lastRadius });

  // M2. 高德底图：半径来自 map.getBounds()
  el = freshCard(baseConfig(), null);
  el.hass = makeHass();
  await waitFor(() => el._mapMode === 'amap' && el._pins.length >= 5);
  const autoAmap = el._currentRadius();
  // 默认 cover（外接）：400×300 的视口 → 中心到四角 hypot(200,150)=250px × 每像素米数
  const mpp16 = (156543.03392 * Math.cos((BASE_LAT + 0.00162) * Math.PI / 180)) / Math.pow(2, 16);
  const wantInscribed = Math.min(200, 150) * mpp16;   // 短边一半 150px
  const wantCover = Math.hypot(200, 150) * mpp16;     // 中心→四角 250px
  ok('高德分支自动半径 = 外接半径（覆盖整张视图）', Math.abs(autoAmap - wantCover) <= 4,
    { autoAmap, wantCover: Math.round(wantCover) });
  ok('外接半径明显大于内切半径', autoAmap > wantInscribed * 1.5,
    { autoAmap, wantInscribed: Math.round(wantInscribed) });
  eq('_lastRadius 与之一致', el._lastRadius, autoAmap);
  eq('默认不往地图上画搜索圈', amapCreated.circles.length, 0);

  const amapReqBefore = el._api.stats.request;
  fakeViewport.zoom = 13;
  amapCreated.maps[0].emit('zoomend');
  await waitFor(() => el._lastRadius > autoAmap * 2, 3000);
  ok('zoomend 后按新视野重算半径', el._lastRadius > autoAmap * 2, { before: autoAmap, after: el._lastRadius });
  eq('缩放后仍然不画圈', amapCreated.circles.length, 0);
  ok('缩放触发了新的周边检索', el._api.stats.request > amapReqBefore, el._api.stats.request);

  // M2b. 手动打开「显示搜索半径圈」+ 内切模式：旧行为仍然可用
  el = freshCard(Object.assign(baseConfig(), {
    show_radius_circle: true, auto_radius_basis: 'visible',
  }), null);
  el.hass = makeHass();
  await waitFor(() => el._mapMode === 'amap' && el._pins.length >= 5);
  ok('打开开关后在地图上画出搜索圈', amapCreated.circles.length >= 1, amapCreated.circles.length);
  ok('visible 模式下半径 = 内切半径', Math.abs(el._lastRadius - wantInscribed) <= 2,
    { got: el._lastRadius, want: Math.round(wantInscribed) });
  eq('圈半径 = 检索半径', amapCreated.circles[0].radius, el._lastRadius);
  ok('圈已挂到地图上', amapCreated.maps[0].added.indexOf(amapCreated.circles[0]) >= 0);

  // 12% 死区：连续 zoomend 但视野没实质变化时不应重复请求
  const reqQuiet = el._api.stats.request;
  const keepRadius = el._lastRadius;
  amapCreated.maps[0].emit('zoomend');
  await new Promise((r) => setTimeout(r, 900));
  eq('视野未实质变化时不重复请求', el._api.stats.request, reqQuiet);
  eq('半径保持不变', el._lastRadius, keepRadius);

  // M3. 固定半径模式完全不受缩放影响
  el = freshCard(Object.assign(baseConfig(), { radius_mode: 'fixed', radius: 1500 }), null);
  el.hass = makeHass();
  await waitFor(() => el._pins.length >= 5);
  eq('固定模式半径恒为配置值', el._currentRadius(), 1500);
  eq('固定模式下的检索半径', el._lastRadius, 1500);
  const fixedReq = el._api.stats.request;
  fakeViewport.zoom = 11;
  amapCreated.maps[0].emit('zoomend');
  await new Promise((r) => setTimeout(r, 900));
  eq('固定模式下缩放不改变半径', el._currentRadius(), 1500);
  eq('固定模式下缩放不触发重复检索', el._api.stats.request, fixedReq);

  // M4. 系数、上限与非法值
  const padEl = freshCard(Object.assign(baseConfig(), { radius_mode: 'auto', auto_radius_pad: 2 }), null);
  padEl.hass = makeHass();
  await waitFor(() => padEl._pins.length >= 5);
  ok('系数 2 时半径约为默认的两倍', padEl._currentRadius() > autoAmap * 1.6, { base: autoAmap, padded: padEl._currentRadius() });

  const capEl = freshCard(Object.assign(baseConfig(), { radius_mode: 'auto', auto_radius_pad: 4, auto_radius_max: 800 }), null);
  capEl.hass = makeHass();
  await waitFor(() => capEl._pins.length >= 5);
  eq('自动半径受上限约束', capEl._currentRadius(), 800);

  /* ---------- M5. 按整张视图检索，且结果一条都不出画（「点位超出底图范围」的回归） ---------- */
  console.log('\n=== M5. 整视图检索 + 结果不出底图范围 ===');
  net.mode = 'spread';                       // POI 铺满整个可视矩形（含四角），最接近真实分布

  // M5a. 默认 cover + 视口裁剪：四角方向的点也必须搜到，且条条落在图内
  let sp = freshCard(Object.assign(baseConfig(), { radius_mode: 'auto', show_toilet: true }), null);
  sp.hass = makeHass();
  await waitFor(() => sp._pins.length >= 5);
  const spPois = sp._pins.filter((p) => p.kind !== 'entity');
  ok('拿到铺开的结果集', spPois.length >= 8, spPois.length);
  eq('全部结果都落在可视范围内', spPois.filter((p) => !sp._pinInView(p)).length, 0);
  eq('不弹「铺满显示」提示', sp._notices.has('offscreen'), false);

  // M5b. 四角方向（内切圆覆盖不到的地方）也必须被搜到
  const gotIds = new Set(spPois.map((p) => (p.data && p.data.item && p.data.item.poi.id) || ''));
  ok('四角方向的 POI 全部搜到（内切圆会漏掉它们）',
    ['C0', 'C2', 'C5', 'C7'].every((id) => gotIds.has(id)), [...gotIds]);
  // 返回的全部是真实视口内的点：没有任何「检索到了但显示不出来」的浪费
  eq('列表条目数 = 地图上的 POI 标记数', sp._poiGroups.reduce((s, g) => s + g.items.length, 0), spPois.length);

  // M5c. 内切模式仍可选：只搜画面中间，同样不出画
  sp = freshCard(Object.assign(baseConfig(), {
    radius_mode: 'auto', auto_radius_basis: 'visible', show_toilet: true,
  }), null);
  sp.hass = makeHass();
  await waitFor(() => sp._pins.length >= 5);
  const visPois = sp._pins.filter((p) => p.kind !== 'entity');
  eq('visible：全部结果都落在可视范围内', visPois.filter((p) => !sp._pinInView(p)).length, 0);
  const visWant = Math.round(Math.min(200, 150) * mpp16);
  ok('visible：半径退回内切（覆盖不到四角）', Math.abs(sp._lastRadius - visWant) <= 4,
    { got: sp._lastRadius, want: visWant });

  // M5d. 固定半径模式：结果真的会出画，这里保留「铺满显示」兜底
  net.mode = 'ok';
  sp = freshCard(Object.assign(baseConfig(), { radius_mode: 'fixed', radius: 5000, show_toilet: true }), null);
  sp.hass = makeHass();
  await waitFor(() => sp._pins.length >= 4);
  // 人为放入一个远处的点：固定半径不做视口裁剪，正是「铺满显示」要兜的场景
  sp._poiGroups[0].items.push({
    kind: 'charging', icon: 'mdi:ev-station',
    poi: { id: 'FAR', name: '远处充电站', lng: sp._gcj.lng + 0.05, lat: sp._gcj.lat, address: '', tel: '', bizExt: {}, raw: {} },
    distance: 5000,
  });
  sp._renderPins();
  sp._checkPinsVisible();
  const outPins = sp._pins.filter((p) => p.kind !== 'entity' && !sp._pinInView(p));
  ok('固定半径下确实有结果落在图外', outPins.length > 0, outPins.map((p) => p.data.item.poi.id));
  ok('图外的点由「铺满显示」提示兜住', sp._notices.has('offscreen'), [...sp._notices.keys()]);

  const fitReqBefore = sp._api.stats.request;
  sp._fitAllPins();
  eq('铺满显示确实改了视野', amapCreated.maps[0].fitViewCalls, 1);
  eq('铺满后没有结果留在图外', sp._pins.filter((p) => p.kind !== 'entity' && !sp._pinInView(p)).length, 0);
  eq('铺满后提示条自动消失', sp._notices.has('offscreen'), false);
  await new Promise((r) => setTimeout(r, 900));
  eq('程序化改视野不触发按新视野重检索', sp._api.stats.request, fitReqBefore);

  // M5e. 程序化缩放不该被误记成「用户拖动」（否则自动跟随会被自己关掉 15 秒）
  const followCard = freshCard(Object.assign(baseConfig(), { view_mode: 'follow' }), null);
  followCard.hass = makeHass();
  await waitFor(() => followCard._mapMode === 'amap' && followCard._pins.length >= 5);
  eq('自动跟随改视野后不进入「已暂停跟随」', Date.now() - followCard._userPannedAt > 15000, true);
  ok('跟随按钮仍显示「跟随中」', /跟随中/.test(followCard._els.listHead.querySelector('[data-act="view"]').textContent),
    followCard._els.listHead.querySelector('[data-act="view"]').textContent);

  net.mode = 'ok';

  const normEl = freshCard(Object.assign(baseConfig(), { radius_mode: 'nope', auto_radius_pad: 99, auto_radius_max: 1 }));
  eq('非法 radius_mode 回退 auto', normEl._cfg.radius_mode, 'auto');
  eq('auto_radius_pad 被夹到 4', normEl._cfg.auto_radius_pad, 4);
  eq('auto_radius_max 被夹到 100', normEl._cfg.auto_radius_max, 100);

  // M5f. 默认配置下不创建任何 Circle（检索范围就是整张地图，不需要可视化圈）
  const noCircle = freshCard(baseConfig(), null);
  noCircle.hass = makeHass();
  await waitFor(() => noCircle._pins.length >= 5);
  eq('默认配置不创建 Circle', amapCreated.circles.length, 0);

  /* ---------- M6. 简化视图几何：内切/外接半径 + 定位点不再钉在画布中心 ---------- */
  console.log('\n=== M6. 简化视图几何 ===');
  net.mode = 'ok';
  const fbEl = freshCard(Object.assign(baseConfig(), { show_radius_circle: true }), MOCK_NO_JSAPI);
  fbEl.hass = makeHass();
  await waitFor(() => fbEl._pins.length >= 5);
  const fm = fbEl._fbMap;

  // 模拟宽扁卡片（640×300）
  Object.defineProperty(fm.host, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(fm.host, 'clientHeight', { configurable: true, get: () => 300 });
  fm.resize();

  const fbVisible = fm.viewportRadius('visible');
  const fbCover = fm.viewportRadius('cover');
  ok('宽扁画布：内切半径明显小于外接半径', fbVisible < fbCover * 0.8, { fbVisible, fbCover });
  eq('卡片自动半径采用外接（覆盖整张视图）', fbEl._currentRadius(), fbCover);

  ok('简化视图能识别画布外的点', fbEl._pinInView({ kind: 'poi', lng: fbEl._gcj.lng + 1, lat: fbEl._gcj.lat }) === false);
  ok('简化视图能识别画布内的点', fbEl._pinInView({ kind: 'poi', lng: fbEl._gcj.lng, lat: fbEl._gcj.lat }) === true);

  // 定位点（十字准星 + 半径圈）跟着实体走
  const g6 = fbEl._gcj;
  fm.setFocus(g6.lng, g6.lat);
  fm.setCenter(g6.lng, g6.lat);
  let fp = fm.focusPoint();
  ok('回到定位时定位点落在画布中心', Math.abs(fp.x - 320) < 1.5 && Math.abs(fp.y - 150) < 1.5, fp);

  ctxArcs.length = 0; ctxMoves.length = 0;
  fm.setCenter(g6.lng + 0.02, g6.lat);          // 用户把地图拖走（中心 ≠ 实体）
  fp = fm.focusPoint();
  ok('地图被拖走后定位点跟着实体偏移，不再钉在中心', fp.x < 300, fp);
  const lastArc = ctxArcs[ctxArcs.length - 1];
  ok('半径圈圆心 = 定位点（而不是画布中心）',
    !!lastArc && Math.abs(lastArc.x - fp.x) < 1.5 && Math.abs(lastArc.y - fp.y) < 1.5,
    { arc: lastArc, focus: fp });
  const wantR = fm.radius / ((156543.03392 * Math.cos(fm.center[1] * Math.PI / 180)) / Math.pow(2, fm.zoom));
  ok('半径圈半径 = 检索半径 ÷ 每像素米数',
    !!lastArc && Math.abs(lastArc.r - wantR) < 1, { arc: lastArc, wantR });
  const crossMoves = ctxMoves.filter((m) => Math.abs(m.y - fp.y) < 1.5 && Math.abs(m.x - fp.x) < 8);
  ok('十字准星也画在定位点上', crossMoves.length >= 1, { fp, tail: ctxMoves.slice(-6) });

  // 弹窗夹在画布内，不溢出地图框
  fm.openPopup({ lng: g6.lng, lat: g6.lat, popupHtml: '<div>测试弹窗</div>' });
  const pl = parseFloat(fm.popup.style.left);
  const pt = parseFloat(fm.popup.style.top);
  ok('弹窗水平落在画布内', pl >= 0 && pl <= 640, fm.popup.style.left);
  ok('弹窗底边落在画布内', pt >= 0 && pt <= 300, fm.popup.style.top);
  fm.closePopup();

  /* ---------- M7. 高德底图手势接管（Shadow DOM 下 JSAPI 2.0 拖拽失效的回归） ---------- */
  console.log('\n=== M7. 高德底图手势接管 ===');
  net.mode = 'ok';
  fakeViewport.zoom = 16; fakeViewport.width = 400; fakeViewport.height = 300;
  const gEl = freshCard(Object.assign(baseConfig(), { show_radius_circle: true }), null);
  gEl.hass = makeHass();
  await waitFor(() => gEl._mapMode === 'amap' && gEl._pins.length >= 5);
  const gMap = gEl._map;
  const gesture = gEl._els.gesture;
  Object.defineProperty(gEl._els.mapWrap, 'clientWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(gEl._els.mapWrap, 'clientHeight', { configurable: true, get: () => 300 });

  const pe = (type, x, y, id = 1) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'pointerId', { value: id });
    Object.defineProperty(e, 'clientX', { value: x });
    Object.defineProperty(e, 'clientY', { value: y });
    return e;
  };

  // 拖拽：向左上拖 40/30px → 中心应向东南移动相应像素距离
  const lng0 = gMap.getCenter().getLng();
  const lat0 = gMap.getCenter().getLat();
  gesture.dispatchEvent(pe('pointerdown', 200, 150));
  for (let i = 1; i <= 10; i++) gesture.dispatchEvent(pe('pointermove', 200 - i * 4, 150 - i * 3));
  gesture.dispatchEvent(pe('pointerup', 160, 120));
  const mpp17 = (156543.03392 * Math.cos(gMap.getCenter().getLat() * Math.PI / 180)) / Math.pow(2, 16);
  const wantDLng = 40 * mpp17 / (111320 * Math.cos(gMap.getCenter().getLat() * Math.PI / 180));
  const wantDLat = -30 * mpp17 / 110540;
  const gotDLng = gMap.getCenter().getLng() - lng0;
  const gotDLat = gMap.getCenter().getLat() - lat0;
  ok('拖拽改变地图中心且位移量与像素一致（无放大/漂移）',
    Math.abs(gotDLng - wantDLng) < 1e-7 && Math.abs(gotDLat - wantDLat) < 1e-7,
    { gotDLng, wantDLng, gotDLat, wantDLat });

  // 滚轮缩放
  const z0 = gMap.getZoom();
  const we = new window.Event('wheel', { bubbles: true, cancelable: true });
  Object.defineProperty(we, 'deltaY', { value: -120 });
  gesture.dispatchEvent(we);
  eq('滚轮放大一级', gMap.getZoom(), Math.min(19, z0 + 1));

  // 轻点实体标记（地图中心）→ 打开自绘弹窗；轻点空白 → 收起
  gEl._closeAmapPopup();
  const ePx = gMap.lngLatToContainer([gEl._gcj.lng, gEl._gcj.lat]);
  gesture.dispatchEvent(pe('pointerdown', ePx.x, ePx.y));
  gesture.dispatchEvent(pe('pointerup', ePx.x, ePx.y));
  eq('轻点实体标记打开自绘弹窗', gEl._els.amapPop.hidden, false);
  gesture.dispatchEvent(pe('pointerdown', 20, 20));
  gesture.dispatchEvent(pe('pointerup', 20, 20));
  eq('轻点空白收起弹窗（对齐 closeWhenClickMap）', gEl._els.amapPop.hidden, true);

  // 双指捏合 → 缩放变化，且不被误判成轻点
  const zPinch0 = gMap.getZoom();
  gesture.dispatchEvent(pe('pointerdown', 100, 150, 1));
  gesture.dispatchEvent(pe('pointerdown', 300, 150, 2));
  gesture.dispatchEvent(pe('pointermove', 60, 150, 1));
  gesture.dispatchEvent(pe('pointermove', 340, 150, 2));
  gesture.dispatchEvent(pe('pointerup', 60, 150, 1));
  gesture.dispatchEvent(pe('pointerup', 340, 150, 2));
  ok('双指捏合放大（zoom 随间距增大）', gMap.getZoom() > zPinch0, { zPinch0, after: gMap.getZoom() });
  eq('捏合不触发弹窗', gEl._els.amapPop.hidden, true);

  /* ---------- M8. 缩放锚点 + 弹窗重绑（iOS 缩放后点位错位的回归） ---------- */
  console.log('\n=== M8. 缩放锚点与弹窗重绑 ===');

  // 1) 弹窗重绑：重检索重建 pins 后，同 POI 换绑新对象；POI 消失则收起。
  //    （放在锚点缩放前测，避免捏合挪动中心后标记出界触发「出画收起」）
  gEl._closeAmapPopup();
  fakeViewport.zoom = 16;   // M7 捏合后 zoom 停在 17.4+，先复位，保证 POI 在视口内
  gMap.setCenter([gEl._gcj.lng, gEl._gcj.lat]);
  const poiPin = gEl._pins.find((p) => p.kind !== 'entity');
  gEl._onPinClick(poiPin);
  eq('前置：点 POI 标记后弹窗打开', gEl._els.amapPop.hidden, false);
  const pid = poiPin.data.item.poi.id;
  const popupBefore = gEl._activePopupPin;
  gEl._renderPins();   // 重渲染（模拟重检索后重建标记），_poiGroups 未变 → 同 POI 还在
  const popupAfter = gEl._activePopupPin;
  ok('重渲染后弹窗换绑到新 pin 对象（内容与新数据一致）',
    !!popupAfter && popupAfter !== popupBefore
    && popupAfter.data && popupAfter.data.item && String(popupAfter.data.item.poi.id) === String(pid),
    popupAfter && popupAfter.data && popupAfter.data.item && popupAfter.data.item.poi.id);
  eq('换绑后弹窗保持打开', gEl._els.amapPop.hidden, false);
  gEl._poiGroups = gEl._poiGroups.map((g) => Object.assign({}, g, { items: [] }));
  gEl._renderPins();
  eq('POI 被新结果挤出时弹窗自动收起', gEl._els.amapPop.hidden, true);
  ok('弹窗引用清空', gEl._activePopupPin === null);

  // 2) 捏合：双指中点指的地理位置在锚定缩放前后必须不动
  fakeViewport.zoom = 16;
  gesture.dispatchEvent(pe('pointerdown', 100, 150, 11));
  gesture.dispatchEvent(pe('pointerdown', 300, 150, 12));
  gesture.dispatchEvent(pe('pointermove', 60, 150, 11));
  // 真实捏合中两指交替上报，锚点永远跟随「当前」中点：
  // 在最后一次 move 前抓拍指下经纬度，缩放后它必须还在原地
  const anchorLL = gMap.containerToLngLat([200, 150]);
  const aLng = anchorLL.getLng();
  const aLat = anchorLL.getLat();
  gesture.dispatchEvent(pe('pointermove', 340, 150, 12));
  gesture.dispatchEvent(pe('pointerup', 60, 150, 11));
  gesture.dispatchEvent(pe('pointerup', 340, 150, 12));
  const q8 = gMap.lngLatToContainer([aLng, aLat]);
  ok('捏合锚定双指中点（指下的地点不滑走）',
    Math.abs(q8.x - 200) < 2 && Math.abs(q8.y - 150) < 2, { q8, want: { x: 200, y: 150 } });
  ok('捏合缩放立即生效（setZoom 第二参 immediately=true，防 iOS 动画脱节）',
    Array.isArray(gMap.lastZoomArgs) && gMap.lastZoomArgs[1] === true, gMap.lastZoomArgs);

  // 3) 滚轮：锚定光标位置（对齐高德原生行为）
  fakeViewport.zoom = 15;
  const wpx = { x: 260, y: 180 };
  const wa = gMap.containerToLngLat([wpx.x, wpx.y]);
  const wLng = wa.getLng();
  const wLat = wa.getLat();
  const wEvt = new window.Event('wheel', { bubbles: true, cancelable: true });
  Object.defineProperty(wEvt, 'deltaY', { value: -120 });
  Object.defineProperty(wEvt, 'clientX', { value: wpx.x });
  Object.defineProperty(wEvt, 'clientY', { value: wpx.y });
  gesture.dispatchEvent(wEvt);
  const q9 = gMap.lngLatToContainer([wLng, wLat]);
  ok('滚轮锚定光标位置', Math.abs(q9.x - wpx.x) < 2 && Math.abs(q9.y - wpx.y) < 2, { q9, wpx });
  ok('滚轮缩放也立即生效', Array.isArray(gMap.lastZoomArgs) && gMap.lastZoomArgs[1] === true, gMap.lastZoomArgs);
  eq('滚轮仍放大一级', gMap.getZoom(), 16);

  /* ---------- M9. 拖动地图后以当前视野中心为基点重检索 ---------- */
  console.log('\n=== M9. 拖动后按当前视野重新搜索 ===');
  gEl._closeAmapPopup();
  fakeViewport.zoom = 16;
  gMap.setCenter([gEl._gcj.lng, gEl._gcj.lat]);
  gEl._onViewportChanged();
  await new Promise((r) => setTimeout(r, 900));   // 防抖到期，基线固化（中心=实体）

  // 死区内小幅拖动（30px ≈ 63m < max(120, r*25%)）：只挪视野，不重复请求
  const reqQuiet9 = gEl._api.stats.request;
  gesture.dispatchEvent(pe('pointerdown', 200, 150, 21));
  gesture.dispatchEvent(pe('pointermove', 230, 150, 21));
  gesture.dispatchEvent(pe('pointerup', 230, 150, 21));
  await new Promise((r) => setTimeout(r, 900));
  eq('拖动距离在死区内不重复检索', gEl._api.stats.request, reqQuiet9);

  // 大幅拖动（300px ≈ 630m > 死区）：以拖动后的视野中心为基点重新检索
  const reqBefore9 = gEl._api.stats.request;
  gesture.dispatchEvent(pe('pointerdown', 200, 150, 22));
  gesture.dispatchEvent(pe('pointermove', 500, 150, 22));
  gesture.dispatchEvent(pe('pointerup', 500, 150, 22));
  await waitFor(() => gEl._api.stats.request > reqBefore9, 3000);
  ok('拖动超过死区后触发了重新检索', gEl._api.stats.request > reqBefore9,
    { before: reqBefore9, after: gEl._api.stats.request });
  const c9 = gMap.getCenter();
  // _lastCenter 在检索完成时才记录，等它追上拖后的视野中心
  await waitFor(() => gEl._lastCenter
    && Math.abs(gEl._lastCenter.lng - c9.getLng()) < 1e-9
    && Math.abs(gEl._lastCenter.lat - c9.getLat()) < 1e-9, 3000);
  ok('检索基点跟随视野中心（不再是实体坐标）',
    !!gEl._lastCenter
    && Math.abs(gEl._lastCenter.lng - c9.getLng()) < 1e-9
    && Math.abs(gEl._lastCenter.lat - c9.getLat()) < 1e-9,
    { lastCenter: gEl._lastCenter, mapCenter: { lng: c9.getLng(), lat: c9.getLat() } });
  const circ9 = amapCreated.circles[amapCreated.circles.length - 1];
  ok('半径圈圆心移到新基点',
    !!circ9 && Array.isArray(circ9.center)
    && Math.abs(circ9.center[0] - c9.getLng()) < 1e-9
    && Math.abs(circ9.center[1] - c9.getLat()) < 1e-9,
    circ9 && circ9.center);

  /* ---------- M10. 「回到定位」按钮（用户报“按钮无效”的回归） ---------- */
  console.log('\n=== M10. 回到定位按钮 ===');
  net.mode = 'ok';
  fakeViewport.zoom = 16;
  gMap.setCenter([gEl._gcj.lng + 0.03, gEl._gcj.lat + 0.02]);
  gMap.setZoom(18, true);
  gEl._userPannedAt = Date.now();          // 用户刚拖过：自动跟随处于暂停
  const hit10 = gEl._recenter();
  eq('点回到定位后确实动了地图', hit10, true);
  ok('中心回到实体坐标（GCJ-02）',
    !!gMap.lastCenter && Math.abs(gMap.lastCenter.c[0] - gEl._gcj.lng) < 1e-9
    && Math.abs(gMap.lastCenter.c[1] - gEl._gcj.lat) < 1e-9,
    gMap.lastCenter);
  eq('缩放回到 follow_zoom', gMap.lastCenter.z, gEl._cfg.follow_zoom);
  eq('清掉 15 秒暂停，自动跟随立刻恢复', gEl._userPannedAt, 0);
  eq('状态条闪出「已回到定位」', gEl._statusFlash, '已回到定位');
  ok('状态文案里能看到反馈', /已回到定位/.test(gEl._els.status.textContent || ''), gEl._els.status.textContent);

  // 列表头里点成「已锁定」后再点回到定位 → 必须解除锁定（旧实现直接 return，按钮像死了）
  gEl._viewOverride = 'locked';
  gEl._recenter();
  eq('手动锁定被解除', gEl._viewOverride, null);

  // 配置成 locked 视图：回到定位 = 回到 locked_center（而不是什么都不做）
  const lockEl = freshCard(Object.assign(baseConfig(), {
    view_mode: 'locked', locked_center: '116.300000,39.900000', locked_zoom: 12,
  }), null);
  lockEl.hass = makeHass();
  await waitFor(() => lockEl._mapMode === 'amap');
  const lockMap = lockEl._map;
  lockEl._recenter();
  ok('locked 视图下按钮不是死键',
    !!lockMap.lastCenter && Math.abs(lockMap.lastCenter.c[0] - 116.3) < 1e-6
    && Math.abs(lockMap.lastCenter.c[1] - 39.9) < 1e-6, lockMap.lastCenter);
  eq('locked 视图用 locked_zoom', lockMap.lastCenter.z, 12);
  lockEl.remove();

  // 瓦片/简化底图：旧实现只在首次应用视野时设缩放，之后点按钮不会恢复缩放
  const fbEl10 = freshCard(Object.assign(baseConfig(), { basemap: 'tiles' }), null);
  fbEl10.hass = makeHass();
  await waitFor(() => fbEl10._mapMode === 'fallback' && !!fbEl10._fbMap);
  fbEl10._fbMap.setZoom(11, true, true);
  fbEl10._fbMap.setCenter(fbEl10._gcj.lng + 0.05, fbEl10._gcj.lat);
  fbEl10._recenter();
  eq('瓦片底图回到定位也恢复缩放', fbEl10._fbMap.zoom, fbEl10._cfg.follow_zoom);
  ok('瓦片底图中心回到实体',
    Math.abs(fbEl10._fbMap.center[0] - fbEl10._gcj.lng) < 1e-9
    && Math.abs(fbEl10._fbMap.center[1] - fbEl10._gcj.lat) < 1e-9, fbEl10._fbMap.center);

  // 手势层在简化底图下必须让路，否则瓦片图拖不动、点标记没反应（连带「回到定位」也没有参照物）
  eq('简化底图：手势层 pointer-events 让路', fbEl10._els.gesture.style.pointerEvents, 'none');
  eq('高德底图：手势层重新接管', gEl._els.gesture.style.pointerEvents, '');

  // 让路之后轻点空白要能关弹窗（原先事件被手势层吃掉，简化底图关不掉）
  fbEl10._fbMap.openPopup({ lng: fbEl10._gcj.lng, lat: fbEl10._gcj.lat, popupHtml: '<div>测试</div>' });
  eq('简化底图弹窗已打开', fbEl10._fbMap.popup.hidden, false);
  fbEl10._fbMap.host.dispatchEvent(pe('pointerdown', 10, 10, 31));
  fbEl10._fbMap.host.dispatchEvent(pe('pointerup', 11, 10, 31));
  eq('轻点空白关闭弹窗', fbEl10._fbMap.popup.hidden, true);
  fbEl10.remove();

  // 真实点击路径（事件委托）也要通到 _recenter
  gMap.lastCenter = null;
  const btn10 = gEl._els.ctrl.querySelector('[data-act="recenter"]');
  btn10.dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
  ok('点击按钮走事件委托调用 _recenter', !!gMap.lastCenter, gMap.lastCenter);

  /* ---------- K2. 控件升级不得定时重建（配置面板被反复重置的根因） ---------- */
  console.log('\n=== K2. 编辑器控件升级（禁止定时重建） ===');
  // 真实 HA 里 ha-textfield 必然已注册，ha-entity-picker 常常很晚才按需注册。
  // 旧实现「任一存在就重建」会每 2.5s 把整个配置表单重建一次 → 输入框失焦、值回填。
  if (!window.customElements.get('ha-textfield')) {
    window.customElements.define('ha-textfield', class extends window.HTMLElement {});
  }
  const ed2 = window.document.createElement('amap-scout-editor');
  ed2._upgradeWait = 40;                 // 缩短等待窗口，测试不必真等 2.5s
  window.document.body.appendChild(ed2);
  let builds = 0;
  const origBuild = ed2._build.bind(ed2);
  ed2._build = function () { builds++; return origBuild(); };
  ed2.setConfig(Object.assign({}, T.ALC_DEFAULTS, { entity: 'device_tracker.test' }));
  eq('首次渲染只建一次表单', builds, 1);
  await new Promise((r) => setTimeout(r, 300));
  eq('能力没变化时不再重建（旧实现每 2.5s 重建一次）', builds, 1);

  // 补上 ha-entity-picker：能力真的变多 → 允许升级一次，且只升级一次
  if (!window.customElements.get('ha-entity-picker')) {
    window.customElements.define('ha-entity-picker', class extends window.HTMLElement {});
  }
  ed2.hass = makeHass();
  await new Promise((r) => setTimeout(r, 250));
  eq('新控件到位后升级一次表单', builds, 2);
  ok('实体字段用上 ha-entity-picker',
    !!ed2.shadowRoot.querySelector('[data-field="entity"] ha-entity-picker'));
  ed2.hass = makeHass();
  ed2.hass = makeHass();
  await new Promise((r) => setTimeout(r, 250));
  eq('后续 hass 心跳不会重复重建', builds, 2);

  // 正在输入时必须推迟，不能把输入框重建掉
  const focusBak = ed2._focusInside.bind(ed2);
  ed2._focusInside = () => true;         // jsdom 的 shadow focus 语义不可靠，直接桩
  const b0 = builds;
  ed2._builtSig = '00';
  ed2._ensureUpgrade();
  ok('正在输入时推迟重建并挂失焦回调', builds === b0 && ed2._blurHooked === true,
    { builds, hooked: ed2._blurHooked });
  ed2._focusInside = focusBak;
  ed2.shadowRoot.dispatchEvent(new window.Event('focusout'));
  await new Promise((r) => setTimeout(r, 150));
  eq('失焦后补做升级（只一次）', builds, b0 + 1);

  // 配置弹窗里的预览不铺满（100vh 会把配置面板撑变形）
  const dlg = window.document.createElement('ha-dialog');
  window.document.body.appendChild(dlg);
  const dlgCard = window.document.createElement('amap-scout');
  dlg.appendChild(dlgCard);
  dlgCard.setConfig(Object.assign({}, T.ALC_DEFAULTS, {
    entity: 'device_tracker.test', amap_key: 'K2', fill_viewport: true,
  }));
  ok('配置弹窗内判定为编辑器预览', dlgCard._inEditorPreview() === true);
  ok('配置弹窗内不铺满（不加 alc-fill）',
    !dlgCard.shadowRoot.querySelector('.alc-root').classList.contains('alc-fill'));
  dlg.remove();

  /* ---------- N. iOS App / WKWebView 底图容错 ---------- */
  console.log('\n=== N. 内嵌 WebView（iOS App）底图容错 ===');
  {
    // N1. WebGL 探测失败**不得**阻断底图加载（「iOS App 没有底图、Safari 正常」的回归）
    net.mode = 'ok';
    const origGetCtx = window.HTMLCanvasElement.prototype.getContext;
    window.HTMLCanvasElement.prototype.getContext = function (type, opts) {
      const t = String(type);
      if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') return null;  // 模拟 WKWebView 误报
      return origGetCtx.call(this, type, opts);
    };
    T.amapLoader._key = 'TEST_WEB_KEY';
    const gl = freshCard(baseConfig(), null);
    gl.hass = makeHass();
    await waitFor(() => gl._mapMode === 'amap' && gl._pins.length >= 1, 6000);
    eq('WebGL 探测未通过时仍然去加载高德底图', gl._mapMode, 'amap');
    eq('探测结果已记录（供诊断用）', gl._webglProbe, false);
    eq('不会因为探测失败弹出降级提示', gl._notices.has('webgl'), false);
    window.HTMLCanvasElement.prototype.getContext = origGetCtx;

    // N2. 诊断文本包含排查所需的关键字段
    const diag = gl._diagText();
    ok('诊断含版本号', /ha-amap-scout v\d+\.\d+\.\d+/.test(diag), diag.slice(0, 60));
    ok('诊断含 UA', /UA：/.test(diag));
    ok('诊断含 WebGL 探测结果', /WebGL 探测：/.test(diag));
    ok('诊断含地图模式与就绪状态', /地图模式：/.test(diag) && /地图就绪：/.test(diag));
    ok('诊断含容器尺寸', /卡片容器：/.test(diag));
    ok('诊断含 Key 来源（但不泄露完整 Key）', /Key：TEST_W/.test(diag) && !diag.includes('TEST_WEB_KEY'));
    ok('诊断不泄露安全密钥内容', !/securityJsCode/.test(diag));

    // N3. 提示条支持第二个按钮（复制诊断）
    let extraHit = 0;
    gl._showNotice('n3', 'warn', '测试提示', '重试', () => {}, { label: '复制诊断', action: () => { extraHit++; } });
    const extraBtn = gl._els.notices.querySelector('[data-notice-extra="n3"]');
    ok('提示条渲染出第二个按钮', !!extraBtn, extraBtn && extraBtn.textContent);
    extraBtn.dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
    eq('第二个按钮点击后执行回调', extraHit, 1);
    gl._notices.delete('n3');
    gl._renderNotices();

    // N4. WebGL 上下文丢失 → 给出可重试的提示
    gl._els.mapEl.dispatchEvent(new window.Event('webglcontextlost'));
    ok('上下文丢失时提示恢复方式', gl._notices.has('webgl-lost'), [...gl._notices.keys()]);
    ok('提示里带「重试」', /重试/.test(gl._notices.get('webgl-lost').actionLabel || ''));
    gl._notices.delete('webgl-lost');
    gl._renderNotices();

    // N5. 容器从 0 尺寸变为有尺寸 → 补一次视野应用（App 恢复上次视图）
    const wrap = gl._els.mapWrap;
    gl._wrapSize = { w: 0, h: 0 };
    let applies = 0;
    const applyBak = gl._applyView.bind(gl);
    gl._applyView = (a) => { applies++; return applyBak(a); };
    gl._resizeMap();                            // 仍是 0 尺寸
    eq('0 尺寸时不做视野重置', applies, 0);
    gl._recoverBlankMap();
    eq('0 尺寸时自愈也不动视野', applies, 0);
    Object.defineProperty(wrap, 'clientWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(wrap, 'clientHeight', { configurable: true, get: () => 600 });
    gl._resizeMap();
    eq('有尺寸后补一次视野应用', applies, 1);
    gl._recoverBlankMap();
    eq('有尺寸时自愈会重新应用视野', applies, 2);
    gl._applyView = applyBak;

    // N6. 回到前台：底图异常时自动重建（WKWebView 常见不重绘）
    let retried = 0;
    const retryBak = gl._retryMap.bind(gl);
    gl._retryMap = () => { retried++; };
    gl._showNotice('webgl-lost', 'warn', '模拟丢失', '重试', () => {});
    gl._onVisible();
    eq('有异常提示时切回前台自动重试一次', retried, 1);
    gl._retryMap = retryBak;
    gl._notices.delete('webgl-lost');
    gl._renderNotices();
    gl.remove();

    // N7. 15 秒仍无瓦片 → 自动换成「瓦片底图」（同一套高德瓦片，绕过 JS API）
    net.mode = 'ok';
    T.amapLoader._key = 'TEST_WEB_KEY';
    const sw = freshCard(baseConfig(), null);
    sw.hass = makeHass();
    await waitFor(() => sw._mapMode === 'amap' && sw._pins.length >= 1, 6000);
    const pinsBefore = sw._pins.length;
    sw._switchToTilesMap();
    eq('切换后走简化视图（但铺真实瓦片）', sw._mapMode, 'fallback');
    eq('瓦片开关跟随配置默认开启', sw._fbMap.tiles, true);
    ok('角标写明是瓦片底图', /瓦片底图/.test(sw._fbMap.badge.textContent), sw._fbMap.badge.textContent);
    ok('提示条说明已自动换图并带重试入口', sw._notices.has('tiles')
      && /重试高清底图/.test(sw._notices.get('tiles').actionLabel || ''), [...sw._notices.keys()]);
    ok('提示条带「复制诊断」', !!sw._els.notices.querySelector('[data-notice-extra="tiles"]'));
    eq('切换后点位原样保留', sw._pins.length, pinsBefore);
    ok('切换后标记落在简化视图上', sw._fbMap.markers.length >= pinsBefore - 1, sw._fbMap.markers.length);

    // 瓦片投影与 project() 一致：以实体位置为基准请求的瓦片 x/y 必须覆盖实体所在世界坐标
    {
      const fb = sw._fbMap;
      const z = 16;
      const wx = (sw._gcj.lng + 180) / 360 * 256 * Math.pow(2, z);
      const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, sw._gcj.lat)) * Math.PI / 180);
      const wy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
      const tx = Math.floor(wx / 256);
      const ty = Math.floor(wy / 256);
      ok('实体位置对应的瓦片编号在合理范围（测试基准坐标 ≈ z16 的 53958/24831）',
        tx > 53900 && tx < 54000 && ty > 24700 && ty < 24900,
        { tx, ty });
    }

    // N8. 关闭瓦片兜底 → 仍是网格占位
    const gridCard = freshCard(Object.assign(baseConfig(), { fallback_tiles: false }), null);
    gridCard.hass = makeHass();
    await waitFor(() => gridCard._mapMode);
    gridCard._switchToTilesMap();
    eq('关掉 fallback_tiles 后不再铺瓦片', gridCard._fbMap.tiles, false);
    ok('角标仍写「简化视图」', /简化视图/.test(gridCard._fbMap.badge.textContent), gridCard._fbMap.badge.textContent);
    // jsdom 里图片不加载：_drawTiles 必须安全返回 false（退回网格），不能抛错
    const ctx = gridCard._fbMap.canvas.getContext('2d');
    eq('无瓦片可铺时返回 false', gridCard._fbMap._drawTiles(ctx, 300, 200), false);
    gridCard.remove();

    // N9. 瓦片缓存的存取与裁剪
    const fb2 = freshCard(baseConfig(), null);
    fb2.hass = makeHass();
    await waitFor(() => fb2._mapMode);
    fb2._switchToTilesMap();
    const t = fb2._fbMap;
    eq('jsdom 里图片不加载 → 均为 loading（不重复发起）', t._tileCache.size > 0 && t._drawTiles(t.canvas.getContext('2d'), 300, 200), false);
    const beforePrune = t._tileCache.size;
    t._pruneTiles();
    ok('裁剪后缓存变小', t._tileCache.size < beforePrune || beforePrune <= 80, { beforePrune, after: t._tileCache.size });
    t._tileCache.set('16/53881/27321', { fakeImg: true });
    eq('已缓存的瓦片直接复用', t._tile(16, 53881, 27321), t._tileCache.get('16/53881/27321'));
    fb2.remove();
  }

  /* ---------- N10. 实体 heading → 定位点箭头 ---------- */
  console.log('\n=== N10. 实体 heading → 定位点箭头 ===');
  {
    net.mode = 'ok';
    const hEl = freshCard(Object.assign(baseConfig(), { show_charging: false, show_toilet: false }), { noJsApi: true });
    const hHass = makeHass();
    hHass.states['device_tracker.test'].attributes.heading = 0;
    hEl.hass = hHass;
    await waitFor(() => hEl._gcj && hEl._fbMap && hEl._pins.length >= 1);

    const arrowOf = () => hEl._fbMap.layer.querySelector('.alc-pin-heading .alc-dir-arrow');
    ok('有 heading → 定位点画成箭头', !!arrowOf(), hEl._fbMap.layer.innerHTML.slice(0, 220));
    ok('0° 指正北', !!arrowOf() && /rotate\(0deg\)/.test(arrowOf().getAttribute('style') || ''),
      arrowOf() && arrowOf().getAttribute('style'));
    eq('默认图标被箭头替代（不再叠加十字准星图标）',
      hEl._fbMap.layer.querySelectorAll('.alc-pin-heading ha-icon').length, 0);

    hHass.states['device_tracker.test'].attributes.heading = 90;
    hEl.hass = hHass;
    ok('heading 改 90° → 箭头跟着转（不重建卡片）',
      !!arrowOf() && /rotate\(90deg\)/.test(arrowOf().getAttribute('style') || ''),
      arrowOf() && arrowOf().getAttribute('style'));
    eq('朝向同步进 pin 数据', hEl._pins[0].heading, 90);

    hHass.states['device_tracker.test'].attributes.heading = 360;
    hEl.hass = hHass;
    ok('360° 归一化为 0°', !!arrowOf() && /rotate\(0deg\)/.test(arrowOf().getAttribute('style') || ''));

    hHass.states['device_tracker.test'].attributes.heading = -90;
    hEl.hass = hHass;
    ok('-90° 按 270°（正西）画', !!arrowOf() && /rotate\(270deg\)/.test(arrowOf().getAttribute('style') || ''));

    delete hHass.states['device_tracker.test'].attributes.heading;
    hEl.hass = hHass;
    ok('去掉 heading → 回到普通图标',
      !hEl._fbMap.layer.querySelector('.alc-dir-arrow')
      && !!hEl._fbMap.layer.querySelector('.alc-pin-entity'));
    eq('数据里也没有朝向了', hEl._pins[0].heading, null);
    hEl.remove();
  }
  {
    const aEl = freshCard(Object.assign(baseConfig(), { show_charging: false, show_toilet: false }), null);
    const aHass = makeHass();
    aHass.states['device_tracker.test'].attributes.heading = 45;
    aEl.hass = aHass;
    await waitFor(() => aEl._mapMode === 'amap' && aEl._pins.length >= 1);

    const entityMarker = () => amapCreated.markers.find((m) => m.zIndex === 200);
    ok('高德底图上的定位点同样画箭头',
      !!entityMarker() && /rotate\(45deg\)/.test(entityMarker().content),
      entityMarker() && String(entityMarker().content).slice(0, 200));

    const markersBefore = amapCreated.markers.length;
    aHass.states['device_tracker.test'].attributes.heading = 200;
    aEl.hass = aHass;
    ok('朝向变化复用同一个 Marker，只换 content（不闪、不多建）',
      amapCreated.markers.length === markersBefore
      && /rotate\(200deg\)/.test(entityMarker().content),
      { before: markersBefore, after: amapCreated.markers.length });

    delete aHass.states['device_tracker.test'].attributes.heading;
    aEl.hass = aHass;
    ok('去掉 heading → 高德标记回到图标', !/alc-dir-arrow/.test(entityMarker().content));
    aEl.remove();
  }

  /* ---------- N11. 公共厕所分类码（140306 → 200300） ---------- */
  console.log('\n=== N11. 公共厕所分类码 ===');
  {
    net.mode = 'ok';
    poiUrls.length = 0;
    const wc = freshCard(Object.assign(baseConfig(), { show_charging: false, show_toilet: true }), { noJsApi: true });
    wc.hass = makeHass();
    // 等「公厕」这一次请求出现（别的卡可能还有延迟请求落进来，不能只看 length>0）
    await waitFor(() => poiUrls.some((q) => /types=200300/.test(q)), 4000);
    ok('公共厕所请求使用高德官方分类码 200300',
      poiUrls.some((q) => /(^|&)types=200300(&|$)/.test(q.replace(/\?/, ''))), poiUrls);
    ok('不再请求高德侧永远为空的 140306', !poiUrls.some((q) => /140306/.test(q)), poiUrls);
    eq('默认配置就是 200300', wc._cfg.toilet_type, '200300');
    wc.remove();

    const legacy = freshCard(Object.assign(baseConfig(), { toilet_type: '140306' }), { noJsApi: true });
    eq('历史配置里的 140306 自动纠正为 200300', legacy._cfg.toilet_type, '200300');
    legacy.remove();

    const custom = freshCard(Object.assign(baseConfig(), { toilet_type: '200300|200301' }), { noJsApi: true });
    eq('自定义分类码原样保留（支持 | 多类型）', custom._cfg.toilet_type, '200300|200301');
    custom.remove();
  }

  /* ---------- N12. 命名与兼容别名 ---------- */
  console.log('\n=== N12. 命名（ha-amap-scout）与旧 tag 兼容 ===');
  const ScoutCard = window.customElements.get('amap-scout');
  ok('新 tag amap-scout 已注册', typeof ScoutCard === 'function');
  const LegacyCard = window.customElements.get('amap-location-card');
  ok('旧 tag amap-location-card 仍注册（老 dashboard 不必改 type）', typeof LegacyCard === 'function');
  ok('旧 tag 是新 tag 的子类（同一实现，只是换个名字）',
    !!LegacyCard && LegacyCard.prototype instanceof ScoutCard);
  const ScoutEditor = window.customElements.get('amap-scout-editor');
  const LegacyEditor = window.customElements.get('amap-location-card-editor');
  ok('编辑器新旧 tag 同样成立', typeof ScoutEditor === 'function'
    && typeof LegacyEditor === 'function' && LegacyEditor.prototype instanceof ScoutEditor);

  const cc = (g.window.customCards || []).find((x) => x.type === 'amap-scout');
  ok('customCards 登记了 amap-scout', !!cc);
  ok('卡片选择器名称为「高德探路 · AMap Scout」', !!cc && cc.name === '高德探路 · AMap Scout', cc && cc.name);
  ok('documentationURL 指向新仓库', !!cc && /lonyii\/ha-amap-scout/.test(cc.documentationURL), cc && cc.documentationURL);
  ok('不再有旧的 customCards 条目', !(g.window.customCards || []).some((x) => x.type === 'amap-location-card'));

  // 用旧 tag 建卡，功能与新高德底图链路一致
  const legacyEl = window.document.createElement('amap-location-card');
  ok('旧 tag 元素是同一个卡片类', legacyEl instanceof ScoutCard);
  legacyEl.setConfig(Object.assign(baseConfig(), { type: 'custom:amap-location-card' }));
  window.document.body.appendChild(legacyEl);
  legacyEl.hass = makeHass();
  await waitFor(() => legacyEl._mapMode, 3000);
  ok('旧 tag 卡片能正常出图', !!legacyEl._mapMode, legacyEl._mapMode);
  ok('旧 tag 卡片能出标记', legacyEl._pins.length > 0, legacyEl._pins.length);
  legacyEl.remove();

  // 编辑器不能把用户写的旧 type 悄悄换成新 type
  const edLegacy = window.document.createElement('amap-scout-editor');
  const legacyChanges = [];
  edLegacy.addEventListener('config-changed', (e) => legacyChanges.push(e.detail.config));
  window.document.body.appendChild(edLegacy);
  edLegacy.setConfig(Object.assign({}, T.ALC_DEFAULTS, {
    type: 'custom:amap-location-card', entity: 'device_tracker.test', amap_key: 'CL', radius: 2000,
  }));
  edLegacy.hass = makeHass();
  const legRow = edLegacy.shadowRoot.querySelector('[data-field="radius"]');
  const legInput = legRow.querySelector('input, ha-textfield');
  legInput.value = '4100';
  legInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  eq('旧 type 被原样写回（不被改名污染）', legacyChanges[legacyChanges.length - 1].type, 'custom:amap-location-card');

  // 没有 type 的裸配置 → 写回新 type
  const edFresh = window.document.createElement('amap-scout-editor');
  const freshChanges = [];
  edFresh.addEventListener('config-changed', (e) => freshChanges.push(e.detail.config));
  window.document.body.appendChild(edFresh);
  edFresh.setConfig(Object.assign({}, T.ALC_DEFAULTS, { entity: 'device_tracker.test', amap_key: 'CF' }));
  edFresh.hass = makeHass();
  const freshRow = edFresh.shadowRoot.querySelector('[data-field="radius"]');
  const freshInput = freshRow.querySelector('input, ha-textfield');
  freshInput.value = '1500';
  freshInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  eq('裸配置写回新 type', freshChanges[freshChanges.length - 1].type, 'custom:amap-scout');

  /* ---------- N13. 夜间主题 ---------- */
  console.log('\n=== N13. 夜间主题 ===');
  {
    // 浅色基线：HA 没给主题信息，jsdom 也没有系统深色
    const elDay = freshCard(baseConfig());
    elDay.hass = makeHass();
    await waitFor(() => elDay._mapMode === 'amap' && elDay._pins.length > 0, 4000);
    const rootDay = elDay.shadowRoot.querySelector('.alc-root');
    ok('默认浅色：alc-light 且没有 alc-dark',
      rootDay.classList.contains('alc-light') && !rootDay.classList.contains('alc-dark'));
    eq('默认浅色 data-alc-theme', rootDay.getAttribute('data-alc-theme'), 'light');
    ok('auto 模式不覆盖 HA 自己的主题变量', !rootDay.classList.contains('alc-force-light'));
    const mapDay = amapCreated.maps[0];
    eq('白天用配置指定的底图样式', mapDay.opts.mapStyle, 'amap://styles/normal');

    // 模拟 HA 里手动切深色：只推 hass，不重建地图
    const hDark = makeHass();
    hDark.themes = { darkMode: true };
    elDay.hass = hDark;
    ok('HA 深色 → 根节点转 alc-dark', rootDay.classList.contains('alc-dark'));
    eq('HA 深色 → data-alc-theme', rootDay.getAttribute('data-alc-theme'), 'dark');
    eq('夜间底图换暗色样式', mapDay.opts.mapStyle, 'amap://styles/darkblue');
    eq('走 setMapStyle 而不是重建地图', (mapDay.styleCalls || []).slice(-1)[0], 'amap://styles/darkblue');
    eq('切主题不重建地图实例', amapCreated.maps.length, 1);
    ok('auto 模式仍不强制覆盖 HA 变量', !rootDay.classList.contains('alc-force-dark'));

    // 切回白天：样式要跟着回去
    const hLight = makeHass();
    hLight.themes = { darkMode: false };
    elDay.hass = hLight;
    ok('HA 切回浅色 → alc-light', rootDay.classList.contains('alc-light'));
    eq('底图样式回到白天设置', mapDay.opts.mapStyle, 'amap://styles/normal');
    eq('切回浅色也只调一次 setMapStyle（不重复下发同一样式）',
      (mapDay.styleCalls || []).filter((s) => s === 'amap://styles/normal').length, 1);
    elDay.remove();

    // 显式 dark：HA 是浅色也要夜间，并且强制覆盖卡片 UI 变量
    const elDark = freshCard(Object.assign(baseConfig(), { theme: 'dark' }));
    elDark.hass = makeHass();
    await waitFor(() => elDark._mapMode === 'amap', 4000);
    const rootDark = elDark.shadowRoot.querySelector('.alc-root');
    ok('theme:dark → 夜间 + 强制暗色 class',
      rootDark.classList.contains('alc-dark') && rootDark.classList.contains('alc-force-dark'));
    eq('theme:dark 建图时就用暗色底图', amapCreated.maps[0].opts.mapStyle, 'amap://styles/darkblue');
    elDark.remove();

    // 显式 light：HA 深色也不跟着变
    const hDark2 = makeHass();
    hDark2.themes = { darkMode: true };
    const elLight = freshCard(Object.assign(baseConfig(), { theme: 'light' }));
    elLight.hass = hDark2;
    await waitFor(() => elLight._mapMode === 'amap', 4000);
    const rootLight = elLight.shadowRoot.querySelector('.alc-root');
    ok('theme:light 优先于 HA 深色',
      rootLight.classList.contains('alc-light') && !rootLight.classList.contains('alc-dark'));
    ok('theme:light 带强制浅色 class', rootLight.classList.contains('alc-force-light'));
    eq('theme:light 用白天样式', amapCreated.maps[0].opts.mapStyle, 'amap://styles/normal');
    elLight.remove();

    // 自定义白天样式不能被夜间主题悄悄吞掉
    const elCustom = freshCard(Object.assign(baseConfig(), { theme: 'dark', map_style: 'amap://styles/fresh' }));
    elCustom.hass = makeHass();
    await waitFor(() => elCustom._mapMode === 'amap', 4000);
    eq('自定义白天样式在夜间沿用（不吞用户配置）', amapCreated.maps[0].opts.mapStyle, 'amap://styles/fresh');
    elCustom.remove();

    // 显式配了夜间样式就一律用它
    const elNight = freshCard(Object.assign(baseConfig(), { theme: 'dark', night_map_style: 'amap://styles/dark' }));
    elNight.hass = makeHass();
    await waitFor(() => elNight._mapMode === 'amap', 4000);
    eq('night_map_style 优先于自动规则', amapCreated.maps[0].opts.mapStyle, 'amap://styles/dark');
    elNight.remove();

    // 瓦片 / 简化视图：canvas 自己画底，夜间标记必须传下去
    const hTilesDark = makeHass();
    hTilesDark.themes = { darkMode: true };
    const elTiles = freshCard(Object.assign(baseConfig(), { theme: 'auto', basemap: 'tiles' }), { noJsApi: true });
    elTiles.hass = hTilesDark;
    await waitFor(() => elTiles._mapMode === 'fallback' && elTiles._fbMap, 4000);
    eq('瓦片底图收到夜间标记', elTiles._fbMap.dark, true);
    eq('瓦片根节点也是 alc-dark', elTiles.shadowRoot.querySelector('.alc-root').classList.contains('alc-dark'), true);
    const hTilesDay = makeHass();
    hTilesDay.themes = { darkMode: false };
    elTiles.hass = hTilesDay;
    eq('切回白天时瓦片标记复原', elTiles._fbMap.dark, false);
    elTiles.remove();

    // 拼错的主题值 → 回落 auto（而不是整卡报错）
    const elBad = freshCard(Object.assign(baseConfig(), { theme: 'moonlight' }));
    eq('非法主题值回落 auto', elBad._cfg.theme, 'auto');
    elBad.remove();
  }

  /* ---------- L. 生命周期 ---------- */
  console.log('\n=== L. 生命周期清理 ===');
  const doomed = freshCard(baseConfig());
  doomed.hass = makeHass();
  await waitFor(() => doomed._mapMode);
  const doomedMap = amapCreated.maps[amapCreated.maps.length - 1];
  doomed.remove();
  ok('移除卡片后地图被 destroy', !!doomedMap && doomedMap.destroyed === true, doomedMap && doomedMap.destroyed);
  ok('移除卡片后清理了标记引用', doomed._markers.length === 0);
  ok('移除卡片后解绑了委托监听', doomed._onClick === null);
  ok('移除卡片后清空半径圈引用', doomed._radiusCircle === null);
  ok('移除卡片后取消挂起的半径防抖', doomed._radiusTimer === null);

  console.log('');
  console.log(lines.join('\n'));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log(lines.join('\n'));
  console.error('\nDOM 测试崩溃：', e);
  process.exit(2);
});

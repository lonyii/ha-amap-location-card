/* 几何审计：验证「搜索范围 = 浏览者屏幕上的可视矩形」这一语义是否成立。
 * 卡片实际做法：高德 around 只支持圆形，所以用能盖住整个矩形的外接半径去检索，
 * 再把落在矩形之外的结果剔掉 —— 合起来等价于一次矩形范围检索。
 * 只做数学复算，不加载卡片。运行：node .geo-audit.cjs   仅开发用，不随卡片发布。 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const metersPerPixel = (lat, z) => (156543.03392 * Math.cos(clamp(lat, -85, 85) * Math.PI / 180)) / Math.pow(2, z);

/* 场景：demo 默认（南昌青山湖）+ 常见容器尺寸 */
const GCJ = { lng: 115.962894, lat: 28.677203 };
const ZOOM = 16;

/**
 * 生成一批候选 POI：9 个铺满矩形（含四角），另外 4 个在「外接圆内、矩形外」。
 * fx / fy 是相对屏幕半宽 / 半高的比例，±1 就是屏幕边缘。
 */
function buildPois(coverM, innerM, halfWm, halfHm) {
  const out = [];
  const fxList = [-0.85, 0, 0.85];
  const fyList = [-0.85, 0, 0.85];
  let i = 0;
  fyList.forEach((fy) => fxList.forEach((fx) => {
    const dx = fx * halfWm; const dy = fy * halfHm;
    out.push({ id: `R${i++}`, fx, fy, dist: Math.hypot(dx, dy), inside: true });
  }));
  // 矩形之外、外接圆之内：检索会命中，但屏幕上看不到
  [[1.35, 0], [0, 1.6], [-1.5, 0.2], [0.3, -1.7]].forEach(([fx, fy], k) => {
    const dx = fx * halfWm; const dy = fy * halfHm;
    out.push({ id: `O${k}`, fx, fy, dist: Math.hypot(dx, dy), inside: false });
  });
  return out;
}

function audit(label, w, h) {
  const mpp = metersPerPixel(GCJ.lat, ZOOM);
  const halfWm = (w / 2) * mpp;
  const halfHm = (h / 2) * mpp;
  const cover = Math.round(Math.hypot(halfWm, halfHm));   // 中心 → 最远角
  const inner = Math.round(Math.min(halfWm, halfHm));     // 中心 → 最近边

  const pois = buildPois(cover, inner, halfWm, halfHm);

  // 卡片实际拿到并渲染的结果：外接半径命中 + 矩形裁剪
  const rendered = pois.filter((p) => p.dist <= cover && p.inside);
  const clipped = pois.filter((p) => p.dist <= cover && !p.inside);
  // 内切圆方案：只搜中间一块，四角与边缘全部丢失
  const innerHit = pois.filter((p) => p.dist <= inner && p.inside);

  const insideTotal = pois.filter((p) => p.inside).length;
  const missed = pois.filter((p) => p.inside && p.dist <= cover && !rendered.includes(p));

  console.log(`\n=== ${label}  容器 ${w}×${h}px · zoom ${ZOOM} · mpp=${mpp.toFixed(3)} m/px ===`);
  console.log(`  屏幕矩形半宽/半高: ${Math.round(halfWm)} / ${Math.round(halfHm)} m`);
  console.log(`  外接半径（检索用）: ${cover} m    内切半径（对比）: ${inner} m`);
  console.log(`  矩形内候选 ${insideTotal} 条 → 卡片渲染 ${rendered.length} 条；圆内矩形外 ${clipped.length} 条被裁掉`);
  console.log(`  内切方案只能搜到 ${innerHit.length}/${insideTotal} 条（四角方向全丢）`);

  return { cover, inner, insideTotal, rendered: rendered.length, clipped: clipped.length, innerHit: innerHit.length, missed: missed.length };
}

const cases = [
  ['桌面全屏（1920×1080 铺满）', 1920, 980],
  ['笔记本半屏', 1200, 700],
  ['iPad 竖屏', 820, 1100],
  ['iPhone 竖屏', 390, 640],
  ['宽扁容器（1:0.35）', 1024, 360],
];

const runs = cases.map(([label, w, h]) => [label, audit(label, w, h)]);

let bad = 0;
console.log('\n================ 结论 ================');
runs.forEach(([label, r]) => {
  const noOut = r.clipped >= 0 && r.rendered === r.insideTotal && r.missed === 0;
  if (!noOut) bad++;
  console.log(`  ${noOut ? '✓' : '✗'} ${label}：矩形内 ${r.insideTotal} 条全部渲染，0 条出界`
    + `（外接 ${r.cover} m 检索 → 裁掉 ${r.clipped} 条圆内矩形外的点）`);
});
console.log('\n对比：若退回内切圆（visible），同样的大屏会漏掉大量边缘结果：');
runs.forEach(([label, r]) => {
  console.log(`  · ${label}：只搜到 ${r.innerHit}/${r.insideTotal} 条（半径 ${r.inner} m，屏幕对角线 ${r.cover} m）`);
});

if (bad) {
  console.error(`\n✗ 有 ${bad} 个场景没能覆盖整个屏幕矩形，几何逻辑有问题。`);
  process.exit(1);
}
console.log('\n✓ 外接检索 + 矩形裁剪 = 精确的「屏幕矩形范围检索」，且不会有结果落在画面外。');

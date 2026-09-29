/* TemporaryMyMap — 説明用の地図を即興で作るためのツール
 * 地図: MapLibre GL JS + OpenMapTiles スキーマのベクタータイル（既定は OpenFreeMap。js/config.js で変更可）
 */
(() => {
'use strict';

// ============================================================
// 設定（js/config.js）と定数
// ============================================================
const RAW_CONFIG = window.TEMPORARY_MY_MAP_CONFIG || {};
const DEFAULT_STYLES = [
  { id: 'liberty',  name: '標準',     url: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'positron', name: 'ライト',   url: 'https://tiles.openfreemap.org/styles/positron' },
  { id: 'bright',   name: 'ブライト', url: 'https://tiles.openfreemap.org/styles/bright' },
];
// ベース地図の一覧（id → { name, url }、並び順どおり。先頭が既定）
const STYLES = (() => {
  const list = Array.isArray(RAW_CONFIG.styles)
    ? RAW_CONFIG.styles.filter(s => s && typeof s.id === 'string' && s.id && typeof s.url === 'string' && s.url)
    : [];
  const out = {};
  for (const s of list.length ? list : DEFAULT_STYLES) out[s.id] = { name: String(s.name || s.id), url: s.url };
  return out;
})();
const DEFAULT_STYLE = Object.keys(STYLES)[0];
const fontStack = (v, fallback) => (Array.isArray(v) && v.length ? v.map(String) : typeof v === 'string' && v ? [v] : fallback);
const CONFIG = {
  embed: RAW_CONFIG.embed === true,
  attribution: typeof RAW_CONFIG.attribution === 'string' ? RAW_CONFIG.attribution.trim() : '',
  fonts: {
    regular: fontStack(RAW_CONFIG.fonts && RAW_CONFIG.fonts.regular, ['Noto Sans Regular']),
    bold: fontStack(RAW_CONFIG.fonts && RAW_CONFIG.fonts.bold, ['Noto Sans Bold']),
  },
};
const LABEL_CATS = [
  { key: 'place', name: '地名' },
  { key: 'poi',   name: '施設・駅' },
  { key: 'road',  name: '道路名・道路番号' },
  { key: 'water', name: '河川・水域' },
  { key: 'other', name: 'その他（一方通行の矢印など）' },
];
const COLORS = ['#e53935', '#fb8c00', '#fbc02d', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41', '#212121'];
const TEXT_COLORS = ['#222222', '#ffffff', '#e53935', '#1e88e5', '#2e7d32', '#6d4c41'];
const CIRCLE_R = { s: 8, m: 12, l: 16 };
const DOT_R = { s: 4, m: 5.5, l: 7 };
const DEFAULT_VIEW = (() => {
  const v = RAW_CONFIG.initialView;
  const ok = v && Array.isArray(v.center) && Number.isFinite(+v.center[0]) && Number.isFinite(+v.center[1]);
  return ok
    ? { center: [+v.center[0], +v.center[1]], zoom: Math.min(22, Math.max(0, Number(v.zoom) || 14)) }
    : { center: [139.7671, 35.6812], zoom: 14 };
})();
// 閲覧専用（埋め込み）表示のパラメータ: ?embed=1[&fit=0][&static=1][&link=0]#m=...
const EMBED_PARAMS = new URLSearchParams(location.search);
const IS_EMBED = EMBED_PARAMS.get('embed') === '1';
const IS_FRAMED = (() => { try { return window.self !== window.top; } catch (_) { return true; } })();
const AUTOSAVE_KEY = 'temporarymymap:autosave';
// 出典表記を取得できなかったときの予備（通常は config かスタイルの出典情報を使う）
const FALLBACK_ATTRIBUTION = '© OpenStreetMap contributors';
// 自前ラベル用の書体。ベース地図の配信元（glyphs）に同名の書体が必要
const FONT_REGULAR = CONFIG.fonts.regular;
const FONT_BOLD = CONFIG.fonts.bold;
const TEXT_FONT = ['case', ['get', 'bold'], ['literal', FONT_BOLD], ['literal', FONT_REGULAR]];
const JA_TEXT_FIELD = ['coalesce', ['get', 'name:ja'], ['get', 'name']];
const LOCAL_IDEOGRAPH_FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif';
const CANVAS_FONT = 'system-ui, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif';
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const POINT_DEFAULTS = { label: '', color: '#e53935', shape: 'c', size: 'm', inner: '', pos: 'r', ls: 'halo', fs: 14, bold: true, tc: '#222222' };
// hsz: 矢じりの大きさ（m 標準 / l 大 / xl 特大）、lpos: ラベル位置（c 線上 / t 上 / b 下 / l 左 / r 右）
const ARROW_DEFAULTS = { label: '', color: '#e53935', width: 4, dash: false, curve: 0, head: 'end', hsz: 'm', dist: false, lpos: 'c' };
const HEAD_SCALE = { m: 1, l: 1.5, xl: 2 };
const ARROW_LABEL_FS = 13;
const PIN_DEFAULTS = { text: '', color: '#333333', fs: 13, bold: false, kind: 'other', icon: '' };
const LINE_DEFAULTS = { label: '', color: '#1e88e5', width: 4, dash: false, head: 'none', hsz: 'm', closed: false, fill: true, dist: false, lpos: 'c' };
const LABEL_POSITIONS = ['c', 't', 'b', 'l', 'r'];
const NUM_FIELDS = new Set(['fs', 'width', 'curve']);
const BOOL_FIELDS = new Set(['bold', 'dash', 'dist', 'closed', 'fill']);

// 当たり判定に使うレイヤー（各フィーチャの t プロパティで種類を判別する）
const HIT_LAYERS = [
  'mm-pt-hit', 'mm-pt-label', 'mm-pt-label-box', 'mm-pin', 'mm-pin-icon',
  'mm-arrow-hit', 'mm-arrow-head', 'mm-arrow-label', 'mm-line-hit', 'mm-fill',
];
// 手描きの間引き許容量（画面上の px）
const SIMPLIFY_PX = 2.5;

// ============================================================
// 状態
// ============================================================
function newState() {
  return {
    title: '', style: DEFAULT_STYLE, lang: 'ja', fade: 0,
    labels: { place: true, poi: true, road: true, water: true, other: true },
    points: [], arrows: [], lines: [], pins: [], nextId: 1,
  };
}
let state = newState();
const ui = {
  mode: 'select', sel: null, arrowFrom: null, tab: 'items',
  panelOpen: !isMobile(), exporting: false, scale: 2,
  draft: [], draftHover: null, // 描画中の線（[lng, lat] の配列）
};
let lastPointStyle = {};
let lastArrowStyle = {};
let lastLineStyle = {};
let map = null;
let styleReady = false;
let baseLabelLayers = [];
let appliedLang = null;

// ============================================================
// ユーティリティ
// ============================================================
function $(s, el = document) { return el.querySelector(s); }
function $$(s, el = document) { return [...el.querySelectorAll(s)]; }
function isMobile() { return window.matchMedia('(max-width: 767px)').matches; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function r6(n) { return Math.round(n * 1e6) / 1e6; }
function r5(n) { return Math.round(n * 1e5) / 1e5; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function newId() { return state.nextId++; }
function feature(geometry, properties) { return { type: 'Feature', geometry, properties }; }
function fc(features) { return { type: 'FeatureCollection', features }; }
function pick(src, defaults) {
  const out = {};
  for (const k of Object.keys(defaults)) {
    if (src && typeof src[k] === typeof defaults[k]) out[k] = src[k];
  }
  return out;
}
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function fileBase() {
  const t = state.title.trim().replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  return `${t || 'map'}_${stamp()}`;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

let toastTimer = 0;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function getPoint(id) { return state.points.find(p => p.id === id); }
function getArrow(id) { return state.arrows.find(a => a.id === id); }
function getPin(id) { return state.pins.find(p => p.id === id); }
function getLine(id) { return state.lines.find(l => l.id === id); }
function getObj(sel) {
  if (!sel) return null;
  switch (sel.type) {
    case 'point': return getPoint(sel.id);
    case 'arrow': return getArrow(sel.id);
    case 'line': return getLine(sel.id);
    default: return getPin(sel.id);
  }
}
function isSel(type, id) { return !!ui.sel && ui.sel.type === type && ui.sel.id === id; }

function markerRadius(p) {
  if (p.shape === 'c') return CIRCLE_R[p.size] || 12;
  if (p.shape === 'd') return DOT_R[p.size] || 5.5;
  return 0;
}
function markerOuter(p) {
  if (p.shape === 'c') return markerRadius(p) + 2;
  if (p.shape === 'd') return markerRadius(p) + 1.5;
  return 0;
}

// ============================================================
// 元に戻す / やり直し
// ============================================================
const undoStack = [];
const redoStack = [];
let lastUndoKey = null, lastUndoTime = 0;

function snapshot() { return JSON.stringify(state); }
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  lastUndoKey = null;
}
// 連続する同種の入力（文字入力・スライダー）は1回分にまとめる
function pushUndoCoalesced(key) {
  const now = Date.now();
  if (key === lastUndoKey && now - lastUndoTime < 1500) { lastUndoTime = now; return; }
  pushUndo();
  lastUndoKey = key; lastUndoTime = now;
}
function undo() {
  if (!undoStack.length) { toast('これ以上戻せません'); return; }
  redoStack.push(snapshot());
  restoreSnapshot(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restoreSnapshot(redoStack.pop());
}
function restoreSnapshot(json) {
  const prevStyle = state.style;
  state = { ...newState(), ...JSON.parse(json) };
  lastUndoKey = null;
  if (ui.sel && !getObj(ui.sel)) ui.sel = null;
  if (ui.arrowFrom != null && !getPoint(ui.arrowFrom)) ui.arrowFrom = null;
  applyStateToMap(prevStyle);
  renderPanel();
  scheduleSave();
}

// ============================================================
// 保存形式（JSON / URL）
// ============================================================
function toDoc() {
  const c = map ? map.getCenter() : { lng: DEFAULT_VIEW.center[0], lat: DEFAULT_VIEW.center[1] };
  const z = map ? map.getZoom() : DEFAULT_VIEW.zoom;
  return {
    app: 'TemporaryMyMap', version: 1,
    title: state.title,
    view: { center: [r6(c.lng), r6(c.lat)], zoom: Math.round(z * 100) / 100 },
    style: state.style, lang: state.lang, fade: state.fade,
    labels: { ...state.labels },
    points: state.points.map(p => ({ ...p, lng: r6(p.lng), lat: r6(p.lat) })),
    arrows: state.arrows.map(a => ({ ...a })),
    // 線は頂点数が多くなりやすいので小数5桁（約1m）に丸めてデータ量を抑える
    lines: state.lines.map(l => ({ ...l, coords: l.coords.map(([x, y]) => [r5(x), r5(y)]) })),
    pins: state.pins.map(p => ({ ...p, lng: r6(p.lng), lat: r6(p.lat) })),
  };
}

function stateFromDoc(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.points)) {
    throw new Error('TemporaryMyMap の地図データではありません');
  }
  const s = newState();
  s.title = typeof doc.title === 'string' ? doc.title : '';
  if (STYLES[doc.style]) s.style = doc.style;
  if (doc.lang === 'local') s.lang = 'local';
  s.fade = clamp(Number(doc.fade) || 0, 0, 0.8);
  if (doc.labels) {
    for (const c of LABEL_CATS) if (typeof doc.labels[c.key] === 'boolean') s.labels[c.key] = doc.labels[c.key];
  }
  const used = new Set();
  const idOf = (raw) => {
    let id = Number.isInteger(raw) && raw > 0 && !used.has(raw) ? raw : 0;
    if (!id) { id = 1; while (used.has(id)) id++; }
    used.add(id);
    return id;
  };
  const validLL = o => o && Number.isFinite(+o.lng) && Number.isFinite(+o.lat);
  const idMap = new Map();
  for (const p of doc.points) {
    if (!validLL(p)) continue;
    const id = idOf(p.id);
    idMap.set(p.id, id);
    s.points.push({ ...POINT_DEFAULTS, ...pick(p, POINT_DEFAULTS), id, lng: +p.lng, lat: +p.lat });
  }
  for (const a of doc.arrows || []) {
    const from = idMap.get(a && a.from), to = idMap.get(a && a.to);
    if (from == null || to == null || from === to) continue;
    const arrow = { ...ARROW_DEFAULTS, ...pick(a, ARROW_DEFAULTS), id: idOf(a.id), from, to };
    arrow.curve = clamp(arrow.curve, -1, 1);
    arrow.width = clamp(arrow.width, 1, 12);
    if (!HEAD_SCALE[arrow.hsz]) arrow.hsz = 'm';
    if (!LABEL_POSITIONS.includes(arrow.lpos)) arrow.lpos = 'c';
    s.arrows.push(arrow);
  }
  for (const l of doc.lines || []) {
    if (!l || !Array.isArray(l.coords)) continue;
    const coords = l.coords
      .filter(c => Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1]))
      .map(c => [+c[0], clamp(+c[1], -85, 85)]);
    if (coords.length < 2) continue;
    const line = { ...LINE_DEFAULTS, ...pick(l, LINE_DEFAULTS), id: idOf(l.id), coords };
    line.width = clamp(line.width, 1, 12);
    if (!HEAD_SCALE[line.hsz]) line.hsz = 'm';
    if (!LABEL_POSITIONS.includes(line.lpos)) line.lpos = 'c';
    if (coords.length < 3) line.closed = false;
    s.lines.push(line);
  }
  for (const p of doc.pins || []) {
    if (!validLL(p) || typeof p.text !== 'string') continue;
    s.pins.push({ ...PIN_DEFAULTS, ...pick(p, PIN_DEFAULTS), id: idOf(p.id), lng: +p.lng, lat: +p.lat });
  }
  for (const list of [s.points, s.pins]) for (const o of list) o.fs = clamp(o.fs, 8, 40);
  s.nextId = Math.max(0, ...used) + 1;
  return s;
}

function viewFromDoc(doc) {
  const v = doc && doc.view;
  if (!v || !Array.isArray(v.center) || !Number.isFinite(+v.center[0]) || !Number.isFinite(+v.center[1])) return null;
  return { center: [+v.center[0], +v.center[1]], zoom: clamp(Number(v.zoom) || DEFAULT_VIEW.zoom, 0, 22) };
}

// --- URL（deflate 圧縮 + base64url） ---
function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function encodeDoc(doc) {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return 'm=' + b64urlEncode(new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  return 'j=' + b64urlEncode(bytes);
}
async function decodeHash(hash) {
  const m = /^#?([mj])=(.+)$/.exec(hash);
  if (!m) return null;
  let bytes = b64urlDecode(m[2]);
  if (m[1] === 'm') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// --- 自動保存（このブラウザ内のみ） ---
let saveTimer = 0;
function scheduleSave() {
  if (IS_EMBED) return; // 閲覧専用表示では利用者の作業データを上書きしない
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(toDoc())); } catch (_) { /* 保存できない環境では無視 */ }
  }, 400);
}
function readAutosave() {
  try {
    const s = localStorage.getItem(AUTOSAVE_KEY);
    return s ? JSON.parse(s) : null;
  } catch (_) { return null; }
}

// ============================================================
// 地図
// ============================================================
function createMap(view, { interactive = true, embed = false } = {}) {
  map = new maplibregl.Map({
    container: 'map',
    style: STYLES[state.style].url,
    center: view.center,
    zoom: view.zoom,
    maxPitch: 0,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: false,
    interactive,
    // 埋め込み時はページのスクロールを奪わないよう、Ctrl+スクロール／2本指でのみ地図を操作する
    cooperativeGestures: embed && interactive,
    locale: {
      'CooperativeGesturesHandler.WindowsHelpText': 'Ctrl キーを押しながらスクロールで拡大・縮小',
      'CooperativeGesturesHandler.MacHelpText': '⌘ キーを押しながらスクロールで拡大・縮小',
      'CooperativeGesturesHandler.MobileHelpText': '2本指で地図を動かせます',
    },
    localIdeographFontFamily: LOCAL_IDEOGRAPH_FONT,
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    maxCanvasSize: [8192, 8192],
  });
  map.dragRotate.disable();
  map.keyboard.disableRotation();
  map.touchZoomRotate.disableRotation();

  if (interactive) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
  if (!embed) map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'bottom-left');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    ...(CONFIG.attribution ? { customAttribution: esc(CONFIG.attribution) } : {}),
  }), 'bottom-left');

  map.on('style.load', setupStyle);
  map.on('styleimagemissing', onImageMissing);
  map.on('click', onMapClick);
  map.on('mousedown', onPointerDown);
  map.on('touchstart', onPointerDown);
  map.on('mousemove', onPointerMove);
  map.on('touchmove', onPointerMove);
  map.on('mouseup', onPointerUp);
  map.on('touchend', onPointerUp);
  map.on('touchcancel', onPointerUp);
  window.addEventListener('mouseup', onPointerUp);
  map.on('zoom', () => scheduleRender('strokes'));
  map.on('moveend', scheduleSave);
  bindDrawModePan();
}

// 線モードでは左ドラッグを描画に使うため、右（中）ボタンのドラッグで地図を動かせるようにする
function bindDrawModePan() {
  const cc = map.getCanvasContainer();
  let last = null;
  cc.addEventListener('mousedown', (e) => {
    if (ui.mode !== 'draw' || (e.button !== 1 && e.button !== 2)) return;
    e.preventDefault();
    last = [e.clientX, e.clientY];
    cc.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!last) return;
    map.panBy([last[0] - e.clientX, last[1] - e.clientY], { animate: false });
    last = [e.clientX, e.clientY];
  });
  window.addEventListener('mouseup', () => {
    if (!last) return;
    last = null;
    cc.classList.remove('dragging');
  });
  cc.addEventListener('contextmenu', (e) => { if (ui.mode === 'draw') e.preventDefault(); });
}

function labelCategory(sourceLayer) {
  switch (sourceLayer) {
    case 'place': return 'place';
    case 'poi': case 'aerodrome_label': return 'poi';
    case 'transportation_name': return 'road';
    case 'water_name': case 'waterway': return 'water';
    default: return 'other';
  }
}

// スタイル読込ごと（初回・ベース地図切替時）に自前のレイヤーを追加し直す
function setupStyle() {
  styleReady = false;
  appliedLang = null;
  const layers = map.getStyle().layers;
  baseLabelLayers = layers
    .filter(l => l.type === 'symbol' && !l.id.startsWith('mm-'))
    .map(l => ({
      id: l.id,
      cat: labelCategory(l['source-layer']),
      visible: ((l.layout && l.layout.visibility) || 'visible') !== 'none',
      textField: l.layout && l.layout['text-field'],
    }));
  const firstSymbol = baseLabelLayers.length ? baseLabelLayers[0].id : undefined;

  addStaticImages();

  map.addSource('mm-world', {
    type: 'geojson',
    data: feature({ type: 'Polygon', coordinates: [[[-180, -85.06], [180, -85.06], [180, 85.06], [-180, 85.06], [-180, -85.06]]] }, {}),
  });
  map.addLayer({ id: 'mm-fade', type: 'fill', source: 'mm-world', paint: { 'fill-color': '#ffffff', 'fill-opacity': state.fade } }, firstSymbol);

  for (const id of ['mm-fills', 'mm-lines', 'mm-arrows', 'mm-heads', 'mm-alabels', 'mm-points', 'mm-pins', 'mm-draft']) {
    map.addSource(id, { type: 'geojson', data: EMPTY_FC });
  }
  addCustomLayers();
  styleReady = true;
  applyBaseSettings();
  render();
}

function addCustomLayers() {
  const labelLayout = {
    'text-field': ['get', 'label'],
    'text-font': TEXT_FONT,
    'text-size': ['get', 'fs'],
    'text-anchor': ['get', 'anchor'],
    'text-radial-offset': ['get', 'ro'],
    'text-justify': 'auto',
    'text-max-width': 20,
    'text-allow-overlap': true,
    // 自前ラベルは衝突判定に参加させ、重なるベース地図のラベルを自動で隠す
    'text-ignore-placement': false,
  };
  const selHalo = ['case', ['get', 'sel'], '#ffe066', '#ffffff'];

  // 線・図形
  map.addLayer({
    id: 'mm-fill', type: 'fill', source: 'mm-fills',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'sel'], 0.32, 0.2] },
  });
  map.addLayer({
    id: 'mm-line-sel', type: 'line', source: 'mm-lines', filter: ['get', 'sel'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#3b82f6', 'line-opacity': 0.35, 'line-width': ['+', ['get', 'width'], 10] },
  });
  map.addLayer({
    id: 'mm-line', type: 'line', source: 'mm-lines', filter: ['!', ['get', 'dash']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] },
  });
  map.addLayer({
    id: 'mm-line-dash', type: 'line', source: 'mm-lines', filter: ['get', 'dash'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-dasharray': [2, 1.5] },
  });
  map.addLayer({
    id: 'mm-line-hit', type: 'line', source: 'mm-lines',
    paint: { 'line-color': '#000000', 'line-opacity': 0.01, 'line-width': 20 },
  });

  // 矢印
  map.addLayer({
    id: 'mm-arrow-sel', type: 'line', source: 'mm-arrows', filter: ['get', 'sel'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#3b82f6', 'line-opacity': 0.35, 'line-width': ['+', ['get', 'width'], 10] },
  });
  map.addLayer({
    id: 'mm-arrow-line', type: 'line', source: 'mm-arrows', filter: ['!', ['get', 'dash']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] },
  });
  map.addLayer({
    id: 'mm-arrow-dash', type: 'line', source: 'mm-arrows', filter: ['get', 'dash'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-dasharray': [2, 1.5] },
  });
  map.addLayer({
    id: 'mm-arrow-hit', type: 'line', source: 'mm-arrows',
    paint: { 'line-color': '#000000', 'line-opacity': 0.01, 'line-width': 20 },
  });
  map.addLayer({
    id: 'mm-arrow-head', type: 'symbol', source: 'mm-heads',
    layout: {
      'icon-image': ['get', 'img'], 'icon-rotate': ['get', 'rot'], 'icon-anchor': 'top',
      'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });

  // ポイント
  map.addLayer({
    id: 'mm-pt-hit', type: 'circle', source: 'mm-points',
    paint: { 'circle-radius': ['get', 'hr'], 'circle-color': '#000000', 'circle-opacity': 0.01 },
  });
  map.addLayer({
    id: 'mm-pt-sel', type: 'circle', source: 'mm-points', filter: ['!=', ['get', 'selc'], ''],
    paint: {
      'circle-radius': ['get', 'selr'], 'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': ['get', 'selc'], 'circle-stroke-width': 3,
    },
  });
  map.addLayer({
    id: 'mm-pt-circle', type: 'circle', source: 'mm-points',
    paint: {
      'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': ['get', 'cop'],
      'circle-stroke-width': ['get', 'sw'], 'circle-stroke-color': ['get', 'sc'], 'circle-stroke-opacity': ['get', 'sop'],
    },
  });
  map.addLayer({
    id: 'mm-pt-inner', type: 'symbol', source: 'mm-points',
    layout: {
      'text-field': ['get', 'inner'], 'text-font': ['literal', FONT_BOLD], 'text-size': ['get', 'ifs'],
      'text-allow-overlap': true, 'text-ignore-placement': true,
      // 透明アイコンでマーカーの範囲を確保し、ベース地図のラベルと重ならないようにする
      'icon-image': 'mm-blank', 'icon-size': ['get', 'bsz'],
      'icon-allow-overlap': true, 'icon-ignore-placement': false,
    },
    paint: { 'text-color': '#ffffff' },
  });
  map.addLayer({
    id: 'mm-arrow-label', type: 'symbol', source: 'mm-alabels',
    layout: {
      'text-field': ['get', 'label'], 'text-font': ['literal', FONT_BOLD], 'text-size': ARROW_LABEL_FS,
      'text-anchor': ['get', 'anchor'], 'text-radial-offset': ['get', 'ro'], 'text-justify': 'auto',
      'text-max-width': 14, 'text-allow-overlap': true, 'text-ignore-placement': false,
    },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': selHalo, 'text-halo-width': 2.2 },
  });
  map.addLayer({
    id: 'mm-pt-label', type: 'symbol', source: 'mm-points', filter: ['==', ['get', 'ls'], 'halo'],
    layout: labelLayout,
    paint: { 'text-color': ['get', 'tc'], 'text-halo-color': selHalo, 'text-halo-width': 2.2 },
  });
  map.addLayer({
    id: 'mm-pt-label-box', type: 'symbol', source: 'mm-points', filter: ['==', ['get', 'ls'], 'box'],
    layout: {
      ...labelLayout,
      'icon-image': ['case', ['get', 'sel'], 'mm-box-sel', 'mm-box'],
      'icon-text-fit': 'both', 'icon-text-fit-padding': [3, 6, 3, 6],
      'icon-allow-overlap': true, 'icon-ignore-placement': false,
    },
    paint: { 'text-color': ['get', 'tc'] },
  });

  // 固定ラベル
  const pinLayout = {
    'text-field': ['get', 'text'], 'text-font': TEXT_FONT, 'text-size': ['get', 'fs'],
    'text-max-width': 12, 'text-allow-overlap': true, 'text-ignore-placement': false,
  };
  const pinPaint = { 'text-color': ['get', 'color'], 'text-halo-color': selHalo, 'text-halo-width': 2 };
  map.addLayer({
    id: 'mm-pin', type: 'symbol', source: 'mm-pins', filter: ['==', ['get', 'icon'], ''],
    layout: pinLayout, paint: pinPaint,
  });
  map.addLayer({
    id: 'mm-pin-icon', type: 'symbol', source: 'mm-pins', filter: ['!=', ['get', 'icon'], ''],
    layout: {
      ...pinLayout,
      'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': false,
      'text-anchor': 'left', 'text-radial-offset': 0.9, 'text-justify': 'left',
    },
    paint: pinPaint,
  });

  // 描画中の線（下書き）
  map.addLayer({
    id: 'mm-draft-line', type: 'line', source: 'mm-draft', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.75 },
  });
  map.addLayer({
    id: 'mm-draft-pt', type: 'circle', source: 'mm-draft', filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': ['case', ['get', 'first'], 6, 4], 'circle-color': '#ffffff',
      'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2,
    },
  });
}

function setHitLayersVisible(v) {
  if (!styleReady) return;
  for (const id of ['mm-pt-hit', 'mm-arrow-hit', 'mm-line-hit']) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
}

// ベース地図のラベル表示・言語・淡さを反映
function applyBaseSettings() {
  if (!styleReady) return;
  for (const l of baseLabelLayers) {
    map.setLayoutProperty(l.id, 'visibility', l.visible && state.labels[l.cat] ? 'visible' : 'none');
  }
  if (appliedLang !== state.lang) {
    for (const l of baseLabelLayers) {
      if (!l.textField || !JSON.stringify(l.textField).includes('"name')) continue;
      map.setLayoutProperty(l.id, 'text-field', state.lang === 'ja' ? JA_TEXT_FIELD : l.textField);
    }
    appliedLang = state.lang;
  }
  map.setPaintProperty('mm-fade', 'fill-opacity', state.fade);
}

function applyStateToMap(prevStyle) {
  if (!map) return;
  if (prevStyle !== state.style) {
    styleReady = false;
    map.setStyle(STYLES[state.style].url, { diff: false });
  } else {
    applyBaseSettings();
    render();
  }
}

// ------------------------------------------------------------
// 画像（矢じり・ラベル枠）
// ------------------------------------------------------------
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  return [c, c.getContext('2d')];
}
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function makeBoxImage(fill, stroke) {
  const pr = 2, s = 32;
  const [c, ctx] = makeCanvas(s * pr, s * pr);
  ctx.scale(pr, pr);
  roundRectPath(ctx, 1.5, 1.5, s - 3, s - 3, 6);
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = stroke; ctx.stroke();
  return ctx.getImageData(0, 0, c.width, c.height);
}
function addStaticImages() {
  const boxOpts = { pixelRatio: 2, stretchX: [[16, 48]], stretchY: [[16, 48]], content: [12, 12, 52, 52] };
  map.addImage('mm-blank', { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) });
  map.addImage('mm-box', makeBoxImage('#ffffff', '#555555'), boxOpts);
  map.addImage('mm-box-sel', makeBoxImage('#fff8d6', '#2563eb'), boxOpts);
}
// 矢じり画像: 先端が上向き。上部に gap の余白を持たせ、マーカーの縁で止まるようにする
function headImageId(color, hs, gap) { return `mm-head|${color}|${hs}|${gap}`; }
function makeHeadImage(color, hs, gap) {
  const pr = 2, w = hs, h = hs + gap;
  const [c, ctx] = makeCanvas(w * pr, h * pr);
  ctx.scale(pr, pr);
  ctx.beginPath();
  ctx.moveTo(w / 2, gap);
  ctx.lineTo(w - 1, gap + hs - 1);
  ctx.lineTo(w / 2, gap + hs * 0.72);
  ctx.lineTo(1, gap + hs - 1);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  return ctx.getImageData(0, 0, c.width, c.height);
}
function onImageMissing(e) {
  if (!e.id.startsWith('mm-head|') || map.hasImage(e.id)) return;
  const [, color, hs, gap] = e.id.split('|');
  map.addImage(e.id, makeHeadImage(color, +hs, +gap), { pixelRatio: 2 });
}

// ------------------------------------------------------------
// 描画
// ------------------------------------------------------------
let renderQueued = null;
function scheduleRender(what = 'all') {
  if (renderQueued) { if (what === 'all') renderQueued = 'all'; return; }
  renderQueued = what;
  requestAnimationFrame(() => {
    const w = renderQueued;
    renderQueued = null;
    if (w === 'strokes') renderStrokes();
    else if (w === 'draft') renderDraft();
    else render();
  });
}

function render() {
  if (!styleReady) return;
  renderPoints();
  renderStrokes();
  renderPins();
  renderDraft();
}

function renderPoints() {
  const anchors = { r: 'left', l: 'right', t: 'bottom', b: 'top', c: 'center' };
  const features = state.points.map(p => {
    const none = p.shape === 'n';
    const r = markerRadius(p);
    const outer = markerOuter(p);
    const selc = isSel('point', p.id) ? '#2563eb' : ui.arrowFrom === p.id ? '#f59e0b' : '';
    const gap = p.pos === 'c' ? 0 : (outer + (p.ls === 'box' ? 8 : 4)) / p.fs;
    return feature({ type: 'Point', coordinates: [p.lng, p.lat] }, {
      id: p.id, t: 'point',
      r: none ? 6 : r,
      color: p.color,
      cop: none ? 0 : 1,
      sw: none ? 1.5 : p.shape === 'c' ? 2 : 1.5,
      sc: none ? '#666666' : '#ffffff',
      sop: none ? (ui.exporting || IS_EMBED ? 0 : 0.8) : 1,
      hr: Math.max(r, 6) + 9,
      selr: Math.max(r, 6) + 5,
      selc,
      sel: !!selc,
      inner: p.shape === 'c' ? p.inner : '',
      ifs: Math.max(9, r * 1.1),
      bsz: none ? 0.01 : (outer * 2) / 8,
      label: p.label,
      fs: p.fs, bold: p.bold, tc: p.tc, ls: p.ls,
      anchor: anchors[p.pos] || 'left',
      ro: gap,
    });
  });
  map.getSource('mm-points').setData(fc(features));
}

// メルカトル座標上で2点間のパス（直線 or 2次ベジェ曲線）を作る
function arrowPath(p1, p2, curve) {
  const A = maplibregl.MercatorCoordinate.fromLngLat([p1.lng, p1.lat]);
  const B = maplibregl.MercatorCoordinate.fromLngLat([p2.lng, p2.lat]);
  if (!curve) return [[A.x, A.y], [B.x, B.y]];
  const dx = B.x - A.x, dy = B.y - A.y;
  const cx = (A.x + B.x) / 2 - dy * curve * 0.5;
  const cy = (A.y + B.y) / 2 + dx * curve * 0.5;
  const pts = [];
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 1 - t;
    pts.push([u * u * A.x + 2 * u * t * cx + t * t * B.x, u * u * A.y + 2 * u * t * cy + t * t * B.y]);
  }
  return pts;
}
function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}
// パスの端を指定距離だけ短くする（矢じりの下から線がはみ出さないように）
function trimEnd(pts, dist) {
  const out = pts.slice();
  while (out.length >= 2 && dist > 0) {
    const a = out[out.length - 2], b = out[out.length - 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg > dist) {
      const t = (seg - dist) / seg;
      out[out.length - 1] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      return out;
    }
    dist -= seg;
    out.pop();
  }
  return out;
}
function mercToLngLat([x, y]) {
  const ll = new maplibregl.MercatorCoordinate(x, y).toLngLat();
  return [ll.lng, ll.lat];
}
// 画面上の角度（北＝上から時計回り）
function bearingOf(from, to) { return Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180 / Math.PI; }

function arrowHeadSize(a) {
  return Math.round(Math.max(12, a.width * 3.2 + 8) * (HEAD_SCALE[a.hsz] || 1));
}

// パス上の指定距離の位置と、その地点での進行方向（単位ベクトル）
function tangentAlong(pts, dist) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if ((seg >= dist || i === pts.length - 1) && seg > 0) {
      const t = Math.min(1, dist / seg);
      return { pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], dir: [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg] };
    }
    dist -= seg;
  }
  return { pt: pts[pts.length - 1], dir: [1, 0] };
}

// 線の周囲にラベルを置くときの text-anchor と text-radial-offset を求める。
// 指定方向（上下左右）に近い側の法線方向へ、線に文字がかからない距離だけ離す
const ANCHOR_BY_SECTOR = ['left', 'top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left'];
function sideLabelPlacement(dir, pos, text, fs, lineWidth) {
  const want = { t: [0, -1], b: [0, 1], l: [-1, 0], r: [1, 0] }[pos];
  if (!want) return { anchor: 'center', ro: 0 };
  const [tx, ty] = dir;
  const n1 = [-ty, tx], n2 = [ty, -tx];
  const d1 = n1[0] * want[0] + n1[1] * want[1], d2 = -d1;
  // 真横・真上など同点のときは上側（なければ右側）を優先
  let n = d1 > d2 ? n1 : n2;
  if (Math.abs(d1 - d2) < 1e-9) n = (n1[1] < 0 || (n1[1] === 0 && n1[0] > 0)) ? n1 : n2;
  const sector = ((Math.round(Math.atan2(n[1], n[0]) / (Math.PI / 4)) % 8) + 8) % 8;
  const anchor = ANCHOR_BY_SECTOR[sector];
  // 上下／左右ぴったりに置く場合は、傾いた線が文字の端にかからないよう余分に離す
  const lines = text.split('\n');
  const halfW = Math.max(...lines.map(s => s.length)) * fs * 0.5;
  const halfH = lines.length * fs * 0.6;
  let extra = 0;
  if (anchor === 'top' || anchor === 'bottom') extra = halfW * Math.abs(ty / (tx || 1e-9));
  if (anchor === 'left' || anchor === 'right') extra = halfH * Math.abs(tx / (ty || 1e-9));
  return { anchor, ro: (lineWidth / 2 + 5 + Math.min(extra, halfW)) / fs };
}

// 2点間の直線距離（大円距離, m）
function distanceMeters(p1, p2) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (p2.lat - p1.lat) * rad, dLng = (p2.lng - p1.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1.lat * rad) * Math.cos(p2.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function formatDistance(m) {
  if (m < 100) return `${Math.round(m)}m`;
  if (m < 1000) return `${Math.round(m / 10) * 10}m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)}km`;
  return `${Math.round(m / 1000)}km`;
}
function arrowDistanceText(a) {
  const p1 = getPoint(a.from), p2 = getPoint(a.to);
  return p1 && p2 ? formatDistance(distanceMeters(p1, p2)) : '';
}
// 地図に表示する矢印のラベル（ラベル文字 + 距離）
function arrowLabelText(a) {
  return [a.label, a.dist ? arrowDistanceText(a) : ''].filter(Boolean).join('\n');
}

// 線の長さ（m）
function lineLengthMeters(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    m += distanceMeters({ lng: coords[i - 1][0], lat: coords[i - 1][1] }, { lng: coords[i][0], lat: coords[i][1] });
  }
  return m;
}
// 閉じた図形の面積（㎡）。説明用なので図形の中心緯度で平面近似する
function polygonAreaM2(coords) {
  const R = 6371008.8, rad = Math.PI / 180;
  const lat0 = coords.reduce((s, c) => s + c[1], 0) / coords.length * rad;
  const xy = coords.map(([lng, lat]) => [lng * rad * R * Math.cos(lat0), lat * rad * R]);
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
function formatArea(m2) {
  if (m2 < 10000) return `${m2 < 1000 ? Math.round(m2) : Math.round(m2 / 10) * 10}㎡`;
  if (m2 < 1e6) return `${(m2 / 10000).toFixed(1)}ha`;
  return `${(m2 / 1e6).toFixed(m2 < 1e7 ? 2 : 1)}km²`;
}
function lineMeasureText(l) {
  return l.closed ? `面積 ${formatArea(polygonAreaM2(l.coords))}` : `長さ ${formatDistance(lineLengthMeters(l.coords))}`;
}
function lineLabelText(l) {
  return [l.label, l.dist ? lineMeasureText(l).replace(/^\S+ /, '') : ''].filter(Boolean).join('\n');
}
// 多角形の重心（メルカトル座標）
function polygonCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-18) return pts[0];
  return [cx / (3 * a), cy / (3 * a)];
}

// 閉じた図形のラベル位置: 中央は重心、上下左右は外接矩形の各辺の中点から外側へ置く
function shapeLabelPlacement(merc, pos, lineWidth) {
  if (pos === 'c' || !LABEL_POSITIONS.includes(pos)) return { at: polygonCentroid(merc), place: { anchor: 'center', ro: 0 } };
  const xs = merc.map(p => p[0]), ys = merc.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const at = { t: [cx, minY], b: [cx, maxY], l: [minX, cy], r: [maxX, cy] }[pos];
  const anchor = { t: 'bottom', b: 'top', l: 'right', r: 'left' }[pos];
  return { at, place: { anchor, ro: (lineWidth / 2 + 5) / ARROW_LABEL_FS } };
}

// 線（メルカトル座標のパス）を描画用フィーチャにする。矢じりがある端は矢じりの下で線を止める
function addStroke(out, path, o, unit) {
  const n = path.length;
  const hs = arrowHeadSize(o);
  const trimTo = o.head === 'none' ? 0 : o.endGap + hs * 0.6;
  const trimFrom = o.head === 'both' ? o.startGap + hs * 0.6 : 0;
  const total = pathLength(path);
  let line = trimEnd(path, trimTo * unit);
  line = trimEnd(line.slice().reverse(), trimFrom * unit).reverse();
  if (line.length >= 2 && total > (trimTo + trimFrom) * unit) {
    out.lines.push(feature({ type: 'LineString', coordinates: line.map(mercToLngLat) },
      { id: o.id, t: o.t, color: o.color, width: o.width, dash: o.dash, sel: o.sel }));
  }
  if (o.head !== 'none') {
    out.heads.push(feature({ type: 'Point', coordinates: mercToLngLat(path[n - 1]) },
      { id: o.id, t: o.t, img: headImageId(o.color, hs, o.endGap), rot: bearingOf(path[n - 2], path[n - 1]) }));
  }
  if (o.head === 'both') {
    out.heads.push(feature({ type: 'Point', coordinates: mercToLngLat(path[0]) },
      { id: o.id, t: o.t, img: headImageId(o.color, hs, o.startGap), rot: bearingOf(path[1], path[0]) }));
  }
  return total;
}

// 矢印と線・図形をまとめて描画（ズームごとに矢じり部分の長さを調整するため再計算する）
function renderStrokes() {
  if (!styleReady) return;
  const unit = 1 / (512 * Math.pow(2, map.getZoom())); // 1px あたりのメルカトル距離
  const arrows = { lines: [], heads: [] };
  const lines = { lines: [], heads: [] };
  const labels = [], fills = [];

  for (const a of state.arrows) {
    const p1 = getPoint(a.from), p2 = getPoint(a.to);
    if (!p1 || !p2) continue;
    const path = arrowPath(p1, p2, a.curve);
    const sel = isSel('arrow', a.id);
    const total = addStroke(arrows, path, {
      ...a, t: 'arrow', sel,
      endGap: Math.round(markerOuter(p2) + 1), startGap: Math.round(markerOuter(p1) + 1),
    }, unit);
    const labelText = arrowLabelText(a);
    if (labelText) {
      // メルカトル座標は画面と同じく y 下向きなので、進行方向をそのまま画面上の向きとして使える
      const { pt, dir } = tangentAlong(path, total / 2);
      const place = sideLabelPlacement(dir, a.lpos, labelText, ARROW_LABEL_FS, a.width);
      labels.push(feature({ type: 'Point', coordinates: mercToLngLat(pt) },
        { id: a.id, t: 'arrow', label: labelText, color: a.color, sel, ...place }));
    }
  }

  for (const l of state.lines) {
    const sel = isSel('line', l.id);
    const merc = l.coords.map(c => { const m = maplibregl.MercatorCoordinate.fromLngLat(c); return [m.x, m.y]; });
    const path = l.closed ? [...merc, merc[0]] : merc;
    const total = addStroke(lines, path, {
      ...l, t: 'line', sel, head: l.closed ? 'none' : l.head, endGap: 0, startGap: 0,
    }, unit);
    if (l.closed && l.fill) {
      fills.push(feature({ type: 'Polygon', coordinates: [[...l.coords, l.coords[0]]] }, { id: l.id, t: 'line', color: l.color, sel }));
    }
    const labelText = lineLabelText(l);
    if (labelText) {
      let at, place;
      if (l.closed) {
        ({ at, place } = shapeLabelPlacement(merc, l.lpos, l.width));
      } else {
        const { pt, dir } = tangentAlong(path, total / 2);
        at = pt;
        place = sideLabelPlacement(dir, l.lpos, labelText, ARROW_LABEL_FS, l.width);
      }
      labels.push(feature({ type: 'Point', coordinates: mercToLngLat(at) },
        { id: l.id, t: 'line', label: labelText, color: l.color, sel, ...place }));
    }
  }

  map.getSource('mm-arrows').setData(fc(arrows.lines));
  map.getSource('mm-lines').setData(fc(lines.lines));
  map.getSource('mm-fills').setData(fc(fills));
  map.getSource('mm-heads').setData(fc([...arrows.heads, ...lines.heads]));
  map.getSource('mm-alabels').setData(fc(labels));
}

function renderPins() {
  const features = state.pins.map(p => feature({ type: 'Point', coordinates: [p.lng, p.lat] }, {
    id: p.id, t: 'pin', text: p.text, color: p.color, fs: p.fs, bold: p.bold,
    icon: p.icon && map.hasImage(p.icon) ? p.icon : '',
    sel: isSel('pin', p.id),
  }));
  map.getSource('mm-pins').setData(fc(features));
}

// ============================================================
// 地図上の操作
// ============================================================
// types の順が優先度（塗りつぶしの面は一番最後に当たる）
function hitTest(point, types = ['point', 'pin', 'arrow', 'line']) {
  if (!styleReady) return null;
  const box = [[point.x - 5, point.y - 5], [point.x + 5, point.y + 5]];
  const feats = map.queryRenderedFeatures(box, { layers: HIT_LAYERS });
  for (const type of types) {
    const f = feats.find(f => f.properties.t === type);
    if (f) return { type, id: f.properties.id };
  }
  return null;
}

let drag = null;
let suppressClick = false;

function onPointerDown(e) {
  if (ui.mode === 'draw') { drawDown(e); return; }
  if (ui.mode !== 'select' && ui.mode !== 'point') return;
  if (e.type === 'touchstart' && e.points.length !== 1) return;
  if (e.type === 'mousedown' && e.originalEvent.button !== 0) return;
  const hit = hitTest(e.point, ['point', 'pin']);
  if (!hit) return;
  const obj = getObj(hit);
  if (!obj) return;
  e.preventDefault(); // 地図のパンを止める
  drag = { hit, obj, start: e.point, moved: false, dLng: obj.lng - e.lngLat.lng, dLat: obj.lat - e.lngLat.lat };
}

function onPointerMove(e) {
  if (ui.mode === 'draw') { drawMove(e); return; }
  if (ui.mode === 'view') return;
  if (drag) {
    if (!drag.moved) {
      if (Math.hypot(e.point.x - drag.start.x, e.point.y - drag.start.y) < 4) return;
      pushUndo();
      drag.moved = true;
      ui.sel = drag.hit;
      map.getCanvasContainer().classList.add('dragging');
    }
    drag.obj.lng = e.lngLat.lng + drag.dLng;
    drag.obj.lat = clamp(e.lngLat.lat + drag.dLat, -85, 85);
    scheduleRender();
    return;
  }
  if (e.type !== 'mousemove') return;
  // ホバー時のカーソル
  const cc = map.getCanvasContainer();
  let hover = false;
  if (ui.mode === 'pin') hover = !!findBaseLabel(e.point);
  else if (ui.mode === 'arrow') hover = !!hitTest(e.point, ['point']);
  else hover = !!hitTest(e.point);
  cc.classList.toggle('hover-item', hover);
}

function onPointerUp() {
  if (stroke) { drawUp(); return; }
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  map.getCanvasContainer().classList.remove('dragging');
  if (moved) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 60);
    render();
    renderPanel();
    scheduleSave();
  }
}

function onMapClick(e) {
  if (suppressClick) return;
  switch (ui.mode) {
    case 'select': {
      select(hitTest(e.point));
      break;
    }
    case 'point': {
      const hit = hitTest(e.point, ['point']);
      if (hit) select(hit); else addPoint(e.lngLat);
      break;
    }
    case 'arrow': {
      const hit = hitTest(e.point, ['point']);
      if (hit) arrowTap(hit.id);
      else if (ui.arrowFrom != null) { ui.arrowFrom = null; render(); updateHint(); }
      else {
        const arrowHit = hitTest(e.point, ['arrow']);
        if (arrowHit) select(arrowHit); else toast('矢印はポイント同士をつなぎます。先にポイントを置いてください');
      }
      break;
    }
    case 'pin': {
      const hit = hitTest(e.point, ['pin']);
      if (hit) select(hit); else pinAt(e.point, e.lngLat);
      break;
    }
    // 'draw' はタップも drawUp で処理する
  }
}

// ------------------------------------------------------------
// 線（手描き + 直線のつなぎ描き）
// ------------------------------------------------------------
let stroke = null; // ドラッグ中の手描き軌跡（画面座標）

function drawDown(e) {
  if (e.type === 'touchstart') {
    // 2本指はピンチ・パン操作に譲る
    if (e.points.length !== 1) { stroke = null; scheduleRender('draft'); return; }
  } else if (e.originalEvent.button !== 0) {
    return;
  }
  e.preventDefault();
  stroke = { pts: [[e.point.x, e.point.y]], moved: false };
}

function drawMove(e) {
  if (!stroke) {
    if (e.type === 'mousemove' && ui.draft.length) {
      ui.draftHover = [e.lngLat.lng, e.lngLat.lat];
      scheduleRender('draft');
    }
    return;
  }
  if (e.type === 'touchmove' && e.points.length !== 1) { stroke = null; scheduleRender('draft'); return; }
  const last = stroke.pts[stroke.pts.length - 1];
  if (Math.hypot(e.point.x - last[0], e.point.y - last[1]) < 2) return;
  stroke.pts.push([e.point.x, e.point.y]);
  if (!stroke.moved && Math.hypot(e.point.x - stroke.pts[0][0], e.point.y - stroke.pts[0][1]) > 6) stroke.moved = true;
  scheduleRender('draft');
}

function drawUp() {
  const s = stroke;
  stroke = null;
  if (!s) return;
  if (s.moved) drawStroke(s.pts); else drawTap(s.pts[0]);
}

function toLngLatArr(px) { const ll = map.unproject(px); return [ll.lng, ll.lat]; }
function screenDist(a, lngLat) { const p = map.project(lngLat); return Math.hypot(p.x - a[0], p.y - a[1]); }

// タップ: 頂点を追加して直線でつなぐ。最後の点をもう一度タップで完了、始点タップで閉じた図形
function drawTap(px) {
  const d = ui.draft;
  if (d.length && screenDist(px, d[d.length - 1]) < 12) { finishDraft(false); return; }
  if (d.length >= 3 && screenDist(px, d[0]) < 12) { finishDraft(true); return; }
  d.push(toLngLatArr(px));
  afterDraftChange();
}

// ドラッグ: 手描き軌跡を間引いて折れ線にする
function drawStroke(pts) {
  let simp = simplifyPath(pts, SIMPLIFY_PX);
  const d = ui.draft;
  if (d.length) {
    // 描きかけの線の終点から描き始めたら続きとしてつなぐ。離れた場所なら別の線にする
    if (screenDist(simp[0], d[d.length - 1]) < 16) simp = simp.slice(1);
    else finishDraft(false);
  }
  ui.draft.push(...simp.map(toLngLatArr));
  afterDraftChange();
}

function afterDraftChange() {
  ui.draftHover = null;
  renderDraft();
  updateDrawBar();
  updateHint();
}

// Ramer–Douglas–Peucker 法で折れ線を間引く
function simplifyPath(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = pts[s], [bx, by] = pts[e];
    const len = Math.hypot(bx - ax, by - ay);
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      const d = len === 0 ? Math.hypot(px - ax, py - ay)
        : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function finishDraft(closed) {
  // 連続する同一点を除く
  const coords = ui.draft.filter((c, i, a) => i === 0 || c[0] !== a[i - 1][0] || c[1] !== a[i - 1][1]);
  ui.draft = [];
  ui.draftHover = null;
  if (coords.length >= 2) {
    pushUndo();
    const l = { ...LINE_DEFAULTS, ...lastLineStyle, id: newId(), coords, closed: closed && coords.length >= 3, label: '' };
    state.lines.push(l);
    ui.sel = { type: 'line', id: l.id };
    render();
    renderEditor();
    renderLists();
    scheduleSave();
  } else {
    renderDraft();
  }
  updateDrawBar();
  updateHint();
}

function cancelDraft() {
  ui.draft = [];
  ui.draftHover = null;
  stroke = null;
  renderDraft();
  updateDrawBar();
  updateHint();
}

function undoDraftVertex() {
  ui.draft.pop();
  afterDraftChange();
}

function renderDraft() {
  if (!styleReady) return;
  const features = [];
  if (!ui.exporting) {
    const st = { ...LINE_DEFAULTS, ...lastLineStyle };
    const coords = ui.draft.slice();
    if (stroke && stroke.moved) coords.push(...stroke.pts.map(toLngLatArr));
    else if (ui.draftHover && coords.length) coords.push(ui.draftHover);
    if (coords.length >= 2) {
      features.push(feature({ type: 'LineString', coordinates: coords }, { color: st.color, width: st.width }));
    }
    ui.draft.forEach((c, i) => features.push(feature({ type: 'Point', coordinates: c }, { color: st.color, first: i === 0 && ui.draft.length >= 3 })));
  }
  map.getSource('mm-draft').setData(fc(features));
}

function updateDrawBar() {
  $('#draw-bar').hidden = !(ui.mode === 'draw' && ui.draft.length);
  $('#draw-bar [data-act="draft-close"]').disabled = ui.draft.length < 3;
  $('#draw-bar [data-act="draft-done"]').disabled = ui.draft.length < 2;
}

function addPoint(lngLat) {
  pushUndo();
  const style = { ...POINT_DEFAULTS, ...lastPointStyle };
  // 番号付きで運用している場合は続き番号を振る
  const nums = state.points.map(p => parseInt(p.inner, 10)).filter(Number.isFinite);
  const inner = style.shape === 'c' && nums.length ? String(Math.max(...nums) + 1) : '';
  const p = { ...style, id: newId(), lng: lngLat.lng, lat: lngLat.lat, label: `ポイント${state.points.length + 1}`, inner };
  state.points.push(p);
  select({ type: 'point', id: p.id }, { focusLabel: true });
  scheduleSave();
}

function arrowTap(id) {
  if (ui.arrowFrom == null) {
    ui.arrowFrom = id;
  } else if (ui.arrowFrom === id) {
    ui.arrowFrom = null;
  } else {
    const from = ui.arrowFrom;
    if (state.arrows.some(a => a.from === from && a.to === id)) {
      toast('同じ矢印がすでにあります');
    } else {
      pushUndo();
      const a = { ...ARROW_DEFAULTS, ...lastArrowStyle, id: newId(), from, to: id, label: '' };
      state.arrows.push(a);
      ui.sel = { type: 'arrow', id: a.id };
      scheduleSave();
    }
    ui.arrowFrom = id; // 続けてタップすると連続して矢印を引ける
  }
  render();
  renderPanel();
  updateHint();
}

// ------------------------------------------------------------
// ラベル固定
// ------------------------------------------------------------
function shownBaseLayerIds(cat) {
  return baseLabelLayers
    .filter(l => (!cat || l.cat === cat) && map.getLayoutProperty(l.id, 'visibility') !== 'none')
    .map(l => l.id);
}
function labelText(props) {
  if (state.lang === 'ja') return props['name:ja'] || props.name || props.ref || '';
  return props.name || props.ref || '';
}
function findBaseLabel(point) {
  if (!styleReady) return null;
  const layers = shownBaseLayerIds();
  if (!layers.length) return null;
  const feats = map.queryRenderedFeatures([[point.x - 10, point.y - 10], [point.x + 10, point.y + 10]], { layers })
    .filter(f => labelText(f.properties));
  if (!feats.length) return null;
  // 点ラベルはタップ位置に一番近いものを優先
  let best = null, bestD = Infinity;
  for (const f of feats) {
    let d = 1e6;
    if (f.geometry.type === 'Point') {
      const p = map.project(f.geometry.coordinates);
      d = Math.hypot(p.x - point.x, p.y - point.y);
    }
    if (d < bestD) { best = f; bestD = d; }
  }
  return best;
}
function pinStyleFor(cat, props) {
  if (cat === 'place') {
    switch (props.class) {
      case 'country': return { fs: 18, bold: true, color: '#222222' };
      case 'state': case 'province': return { fs: 15, bold: true, color: '#444444' };
      case 'city': return { fs: 17, bold: true, color: '#222222' };
      case 'town': return { fs: 15, bold: true, color: '#222222' };
      case 'village': return { fs: 14, bold: false, color: '#222222' };
      default: return { fs: 13, bold: false, color: '#333333' };
    }
  }
  if (cat === 'water') return { fs: 13, bold: false, color: '#1e5aa8' };
  if (cat === 'poi') return { fs: 12, bold: false, color: '#444444' };
  if (cat === 'road') return { fs: 12, bold: false, color: '#555555' };
  return { fs: 12, bold: false, color: '#333333' };
}
function pinFromFeature(f, fallbackLngLat) {
  const props = f.properties;
  const text = labelText(props);
  if (!text) return null;
  const cat = labelCategory(f.sourceLayer);
  const [lng, lat] = f.geometry.type === 'Point' ? f.geometry.coordinates : [fallbackLngLat.lng, fallbackLngLat.lat];
  let icon = '';
  if (cat === 'poi') {
    icon = [props.subclass, props.class].find(n => n && map.hasImage(n)) || '';
    if (!icon && f.layer.id === 'airport' && map.hasImage('airport_11')) icon = 'airport_11';
  }
  return { ...PIN_DEFAULTS, ...pinStyleFor(cat, props), id: 0, text, lng, lat, kind: cat, icon };
}
function pinAt(point, lngLat) {
  const f = findBaseLabel(point);
  if (!f) { toast('ここには固定できる地図ラベルがありません'); return; }
  const pin = pinFromFeature(f, lngLat);
  if (!pin) return;
  const px = map.project([pin.lng, pin.lat]);
  const dup = state.pins.find(p => {
    if (p.text !== pin.text) return false;
    const q = map.project([p.lng, p.lat]);
    return Math.hypot(q.x - px.x, q.y - px.y) < 40;
  });
  if (dup) { select({ type: 'pin', id: dup.id }); toast('すでに固定済みです'); return; }
  pushUndo();
  pin.id = newId();
  state.pins.push(pin);
  select({ type: 'pin', id: pin.id });
  toast(`「${pin.text}」を固定しました`);
  scheduleSave();
}
function pinVisiblePlaces() {
  if (!styleReady) return;
  const layers = shownBaseLayerIds('place');
  if (!layers.length) { toast('地名ラベルが非表示になっています。先に表示してください'); return; }
  const bounds = map.getBounds();
  const seen = new Set(state.pins.map(p => p.text));
  const add = [];
  for (const f of map.queryRenderedFeatures({ layers })) {
    if (f.geometry.type !== 'Point' || !bounds.contains(f.geometry.coordinates)) continue;
    const pin = pinFromFeature(f);
    if (!pin || seen.has(pin.text)) continue;
    seen.add(pin.text);
    add.push(pin);
    if (add.length >= 150) break;
  }
  if (!add.length) { toast('新たに固定できる地名が見つかりませんでした'); return; }
  pushUndo();
  for (const p of add) { p.id = newId(); state.pins.push(p); }
  render();
  renderPanel();
  scheduleSave();
  toast(`${add.length}件の地名を固定しました`);
}

// ------------------------------------------------------------
// 全体表示
// ------------------------------------------------------------
function fitAll(animate = true) {
  // ポイントと線を優先し、どちらもなければ固定ラベルに合わせる
  const coords = [...state.points.map(p => [p.lng, p.lat]), ...state.lines.flatMap(l => l.coords)];
  if (!coords.length) coords.push(...state.pins.map(p => [p.lng, p.lat]));
  if (!coords.length) { if (!IS_EMBED) toast('ポイントや線がまだありません'); return; }
  const bounds = new maplibregl.LngLatBounds();
  for (const c of coords) bounds.extend(c);
  // 埋め込み表示は画面が小さく UI もないので余白を控えめにする
  const pad = IS_EMBED ? { top: 40, bottom: 40, left: 40, right: 70 } : { top: 70, bottom: 60, left: 60, right: 90 };
  if (state.title.trim()) pad.top += 40;
  const panel = $('#panel');
  if (ui.panelOpen && !IS_EMBED) {
    if (isMobile()) pad.bottom += Math.max(0, panel.getBoundingClientRect().height - 52);
    else pad.right += panel.getBoundingClientRect().width + 10;
  }
  const c = map.getContainer();
  // 画面が小さくて余白を取りきれない場合は縮める
  const k = Math.min(1, (c.clientWidth - 40) / (pad.left + pad.right), (c.clientHeight - 40) / (pad.top + pad.bottom));
  for (const key in pad) pad[key] = Math.floor(pad[key] * Math.min(k, 1));
  map.fitBounds(bounds, { padding: pad, maxZoom: 17, animate, duration: animate ? 600 : 0 });
}

// ============================================================
// 選択・編集
// ============================================================
function select(sel, opts = {}) {
  ui.sel = sel && getObj(sel) ? sel : null;
  render();
  renderEditor(opts);
  renderLists();
  if (ui.sel) {
    ui.tab = 'items';
    renderTabs();
    if (!ui.panelOpen) setPanelOpen(true);
  }
}

function deleteSel() {
  const sel = ui.sel;
  if (!sel) return;
  pushUndo();
  if (sel.type === 'point') {
    state.points = state.points.filter(p => p.id !== sel.id);
    state.arrows = state.arrows.filter(a => a.from !== sel.id && a.to !== sel.id);
    if (ui.arrowFrom === sel.id) ui.arrowFrom = null;
  } else if (sel.type === 'arrow') {
    state.arrows = state.arrows.filter(a => a.id !== sel.id);
  } else if (sel.type === 'line') {
    state.lines = state.lines.filter(l => l.id !== sel.id);
  } else {
    state.pins = state.pins.filter(p => p.id !== sel.id);
  }
  ui.sel = null;
  render();
  renderPanel();
  scheduleSave();
}

function deleteItem(type, id) {
  ui.sel = { type, id };
  deleteSel();
}

function setField(field, raw, rebuild) {
  const obj = getObj(ui.sel);
  if (!obj) return;
  let v = raw;
  if (NUM_FIELDS.has(field)) v = Number(raw);
  if (BOOL_FIELDS.has(field)) v = raw === true || raw === 'true';
  if (obj[field] === v) return;
  pushUndoCoalesced(`${ui.sel.type}:${ui.sel.id}:${field}`);
  obj[field] = v;
  if (ui.sel.type === 'point' && field !== 'label' && field !== 'inner') lastPointStyle[field] = v;
  if (ui.sel.type === 'arrow' && field !== 'label') lastArrowStyle[field] = v;
  if (ui.sel.type === 'line' && field !== 'label' && field !== 'closed') lastLineStyle[field] = v;
  if (ui.sel.type === 'line' && field === 'closed' && v && obj.coords.length < 3) {
    obj.closed = false;
    toast('閉じた図形には3点以上が必要です');
  }
  render();
  renderLists();
  if (rebuild) renderEditor();
  else {
    const out = $(`#editor output[data-for="${field}"]`);
    if (out) out.textContent = v;
  }
  scheduleSave();
}

function numberPoints() {
  const circles = state.points.filter(p => p.shape === 'c');
  if (!circles.length) { toast('丸マーカーのポイントがありません'); return; }
  pushUndo();
  circles.forEach((p, i) => { p.inner = String(i + 1); });
  render();
  renderPanel();
  scheduleSave();
}

function reverseArrow() {
  const a = getObj(ui.sel);
  if (!a || ui.sel.type !== 'arrow') return;
  pushUndo();
  [a.from, a.to] = [a.to, a.from];
  a.curve = -a.curve;
  render();
  renderPanel();
  scheduleSave();
}

// ============================================================
// パネル UI
// ============================================================
function segHtml(field, options, current) {
  return `<div class="seg">${options.map(([v, label]) =>
    `<button type="button" data-f="${field}" data-v="${v}" class="${String(current) === String(v) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}
function swatchHtml(field, colors, current) {
  return `<div class="swatches">${colors.map(c =>
    `<button type="button" class="sw ${c === current ? 'on' : ''}" style="--c:${c}" data-f="${field}" data-v="${c}" aria-label="${c}"></button>`).join('')}
    <input type="color" data-f="${field}" value="${esc(current)}" aria-label="任意の色"></div>`;
}
function headSizeHtml(o) {
  return `<div class="field-label">矢じりの大きさ</div>
    ${segHtml('hsz', [['m', '標準'], ['l', '大'], ['xl', '特大']], o.hsz)}`;
}
function rangeHtml(field, label, min, max, step, value) {
  return `<div class="field-label"><span>${label}</span><output data-for="${field}">${value}</output></div>
    <input type="range" data-f="${field}" min="${min}" max="${max}" step="${step}" value="${value}">`;
}

function renderEditor(opts = {}) {
  const el = $('#editor');
  const obj = getObj(ui.sel);
  if (!obj) {
    el.innerHTML = `<div class="help">
      <b>使い方</b><br>
      ① 地図をドラッグ・ズームして場所を決める<br>
      ②「ポイント」で地図をタップして地点を追加<br>
      ③「矢印」でポイントを順にタップしてつなぐ<br>
      　「線」でなぞって手描き・タップで直線を描く<br>
      ④「ラベル固定」で残したい地名をタップ<br>
      ⑤「表示」タブで不要な地図ラベルを非表示に<br>
      ⑥「全体表示」で縮尺を合わせて「画像保存」
    </div>`;
    return;
  }
  const head = (title) => `<div class="ed-head"><span class="badge">${title}</span>
    <button class="icon-btn" data-act="deselect" aria-label="選択解除"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
  let html = '';
  if (ui.sel.type === 'point') {
    const p = obj;
    html = `${head('ポイント')}
      <div class="field-label">ラベル（改行可）</div>
      <textarea data-f="label" rows="2" placeholder="ラベルなし">${esc(p.label)}</textarea>
      <div class="field-label">マーカー</div>
      ${segHtml('shape', [['c', '丸'], ['d', '小さな点'], ['n', 'なし']], p.shape)}
      ${p.shape !== 'n' ? `<div class="field-label">マーカーの色</div>${swatchHtml('color', COLORS, p.color)}
        <div class="two-col">
          <div><div class="field-label">大きさ</div>${segHtml('size', [['s', '小'], ['m', '中'], ['l', '大']], p.size)}</div>
          ${p.shape === 'c' ? `<div><div class="field-label">丸の中の文字</div><input type="text" data-f="inner" maxlength="3" value="${esc(p.inner)}" placeholder="例: 1, A"></div>` : '<div></div>'}
        </div>` : ''}
      <div class="field-label">ラベルの位置</div>
      ${segHtml('pos', [['r', '右'], ['l', '左'], ['t', '上'], ['b', '下'], ['c', '中央']], p.pos)}
      <div class="field-label">ラベルの形式</div>
      ${segHtml('ls', [['halo', '白フチ'], ['box', '枠付き']], p.ls)}
      <div class="field-label">文字色</div>
      ${swatchHtml('tc', TEXT_COLORS, p.tc)}
      <div class="two-col">
        <div>${rangeHtml('fs', '文字サイズ', 10, 32, 1, p.fs)}</div>
        <div><div class="field-label">太さ</div>${segHtml('bold', [['false', '標準'], ['true', '太字']], p.bold)}</div>
      </div>
      <div class="ed-actions">
        <button class="btn" data-act="arrow-from">ここから矢印</button>
        <button class="btn danger" data-act="delete">削除</button>
      </div>`;
  } else if (ui.sel.type === 'arrow') {
    const a = obj;
    const f = getPoint(a.from), t = getPoint(a.to);
    html = `${head('矢印')}
      <div class="note">${esc((f && f.label) || '（ラベルなし）')} → ${esc((t && t.label) || '（ラベルなし）')}</div>
      <div class="field-label">ラベル（例: 徒歩5分）</div>
      <input type="text" data-f="label" value="${esc(a.label)}" placeholder="なし">
      <div class="field-label"><span>距離の表示</span><span>直線 ${arrowDistanceText(a)}</span></div>
      ${segHtml('dist', [['false', '表示しない'], ['true', '表示する']], a.dist)}
      <div class="field-label">ラベルの位置</div>
      ${segHtml('lpos', [['c', '線上'], ['t', '上'], ['b', '下'], ['l', '左'], ['r', '右']], a.lpos)}
      <div class="field-label">色</div>
      ${swatchHtml('color', COLORS, a.color)}
      <div class="field-label">太さ</div>
      ${segHtml('width', [[2, '細'], [4, '中'], [6, '太'], [9, '極太']], a.width)}
      <div class="two-col">
        <div><div class="field-label">線の種類</div>${segHtml('dash', [['false', '実線'], ['true', '破線']], a.dash)}</div>
        <div><div class="field-label">矢じり</div>${segHtml('head', [['end', '終点'], ['both', '両端'], ['none', 'なし']], a.head)}</div>
      </div>
      ${a.head !== 'none' ? headSizeHtml(a) : ''}
      ${rangeHtml('curve', '曲がり具合', -1, 1, 0.05, a.curve)}
      <div class="ed-actions">
        <button class="btn" data-act="reverse">向きを反転</button>
        <button class="btn danger" data-act="delete">削除</button>
      </div>`;
  } else if (ui.sel.type === 'line') {
    const l = obj;
    html = `${head(l.closed ? '図形' : '線')}
      <div class="note">頂点 ${l.coords.length} 個</div>
      <div class="field-label">ラベル</div>
      <input type="text" data-f="label" value="${esc(l.label)}" placeholder="なし">
      <div class="field-label"><span>${l.closed ? '面積' : '長さ'}の表示</span><span>${lineMeasureText(l).replace(/^\S+ /, '')}</span></div>
      ${segHtml('dist', [['false', '表示しない'], ['true', '表示する']], l.dist)}
      <div class="field-label">ラベルの位置${l.closed ? '（上下左右は図形の外側）' : ''}</div>
      ${segHtml('lpos', [['c', l.closed ? '中央' : '線上'], ['t', '上'], ['b', '下'], ['l', '左'], ['r', '右']], l.lpos)}
      <div class="field-label">色</div>
      ${swatchHtml('color', COLORS, l.color)}
      <div class="field-label">太さ</div>
      ${segHtml('width', [[2, '細'], [4, '中'], [6, '太'], [9, '極太']], l.width)}
      <div class="two-col">
        <div><div class="field-label">線の種類</div>${segHtml('dash', [['false', '実線'], ['true', '破線']], l.dash)}</div>
        <div><div class="field-label">形</div>${segHtml('closed', [['false', '線'], ['true', '図形']], l.closed)}</div>
      </div>
      ${l.closed
        ? `<div class="field-label">塗りつぶし</div>${segHtml('fill', [['false', 'なし'], ['true', 'あり']], l.fill)}`
        : `<div class="field-label">矢じり</div>${segHtml('head', [['none', 'なし'], ['end', '終点'], ['both', '両端']], l.head)}
           ${l.head !== 'none' ? headSizeHtml(l) : ''}`}
      <div class="ed-actions">
        <button class="btn danger" data-act="delete">削除</button>
      </div>`;
  } else {
    const p = obj;
    html = `${head('固定ラベル')}
      <div class="field-label">テキスト</div>
      <input type="text" data-f="text" value="${esc(p.text)}">
      <div class="field-label">文字色</div>
      ${swatchHtml('color', ['#222222', '#444444', '#1e5aa8', '#e53935', '#2e7d32', '#6d4c41'], p.color)}
      <div class="two-col">
        <div>${rangeHtml('fs', '文字サイズ', 9, 32, 1, p.fs)}</div>
        <div><div class="field-label">太さ</div>${segHtml('bold', [['false', '標準'], ['true', '太字']], p.bold)}</div>
      </div>
      <p class="note">地図上でドラッグすると位置を調整できます（選択・移動モード）。</p>
      <div class="ed-actions">
        <button class="btn danger" data-act="delete">固定を解除</button>
      </div>`;
  }
  el.innerHTML = `<div class="editor">${html}</div>`;
  if (opts.focusLabel && !isMobile()) {
    const ta = $('textarea[data-f="label"]', el);
    if (ta) { ta.focus(); ta.select(); }
  }
}

function renderLists() {
  const pointName = id => { const p = getPoint(id); return p ? (p.label || p.inner || '（ラベルなし）') : '?'; };
  const del = '<button class="del" data-item-del aria-label="削除">×</button>';
  const empty = msg => `<li class="empty">${msg}</li>`;

  $('#list-points').innerHTML = state.points.map(p => `
    <li data-t="point" data-id="${p.id}" class="${isSel('point', p.id) ? 'sel' : ''}">
      <span class="dot" style="--c:${p.shape === 'n' ? '#98a2b3' : p.color}">${esc(p.shape === 'c' ? p.inner : '')}</span>
      <span class="txt">${esc(p.label.replace(/\n/g, ' ') || '（ラベルなし）')}</span>${del}</li>`).join('')
    || empty('「ポイント」モードで地図をタップすると追加されます');

  $('#list-arrows').innerHTML = state.arrows.map(a => `
    <li data-t="arrow" data-id="${a.id}" class="${isSel('arrow', a.id) ? 'sel' : ''}">
      <span class="bar" style="--c:${a.color}"></span>
      <span class="txt">${esc(pointName(a.from))} → ${esc(pointName(a.to))}${arrowLabelText(a) ? `（${esc(arrowLabelText(a).replace(/\n/g, ' '))}）` : ''}</span>${del}</li>`).join('')
    || empty('「矢印」モードでポイントを順にタップします');

  $('#list-lines').innerHTML = state.lines.map(l => `
    <li data-t="line" data-id="${l.id}" class="${isSel('line', l.id) ? 'sel' : ''}">
      <span class="bar${l.closed ? ' shape' : ''}" style="--c:${l.color}"></span>
      <span class="txt">${esc(l.label || (l.closed ? '図形' : '線'))}（${esc(lineMeasureText(l))}）</span>${del}</li>`).join('')
    || empty('「線」モードでなぞるかタップして描きます');

  $('#list-pins').innerHTML = state.pins.map(p => `
    <li data-t="pin" data-id="${p.id}" class="${isSel('pin', p.id) ? 'sel' : ''}">
      <span class="tagicon">🏷</span>
      <span class="txt">${esc(p.text)}</span>${del}</li>`).join('')
    || empty('「ラベル固定」モードで地図の地名をタップします');

  $('#count-points').textContent = state.points.length ? `(${state.points.length})` : '';
  $('#count-arrows').textContent = state.arrows.length ? `(${state.arrows.length})` : '';
  $('#count-lines').textContent = state.lines.length ? `(${state.lines.length})` : '';
  $('#count-pins').textContent = state.pins.length ? `(${state.pins.length})` : '';
}

function syncGlobalControls() {
  $('#style-seg').innerHTML = Object.entries(STYLES).map(([k, s]) =>
    `<button type="button" data-g="style" data-v="${k}" class="${state.style === k ? 'on' : ''}">${s.name}</button>`).join('');
  $$('[data-g="lang"]').forEach(b => b.classList.toggle('on', b.dataset.v === state.lang));
  $('[data-g="fade"]').value = state.fade;
  const titleInput = $('[data-g="title"]');
  if (document.activeElement !== titleInput) titleInput.value = state.title;
  $('#label-cats').innerHTML = LABEL_CATS.map(c =>
    `<label class="check"><input type="checkbox" data-g="label" data-cat="${c.key}" ${state.labels[c.key] ? 'checked' : ''}> ${c.name}</label>`).join('');
  $$('#scale-seg button').forEach(b => b.classList.toggle('on', +b.dataset.scale === ui.scale));
  updateTitleOverlay();
}

function updateTitleOverlay() {
  const el = $('#title-overlay');
  el.textContent = state.title;
  el.hidden = !state.title.trim();
}

function renderTabs() {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === ui.tab));
  $$('section[data-section]').forEach(s => s.classList.toggle('active', s.dataset.section === ui.tab));
}

function renderPanel() {
  renderEditor();
  renderLists();
  syncGlobalControls();
  renderTabs();
}

function setPanelOpen(open) {
  ui.panelOpen = open;
  $('#panel').classList.toggle('closed', !open);
  $('[data-act="toggle-panel"].tb-btn').classList.toggle('active', open);
}

const HINTS = {
  select: 'タップで選択・編集／ポイントやラベルはドラッグで移動',
  point: '地図をタップしてポイントを追加',
  pin: '残したい地名・施設名のラベルをタップ（縮小しても消えなくなります）',
};
function updateHint() {
  let text = HINTS[ui.mode] || '';
  if (ui.mode === 'arrow') {
    text = ui.arrowFrom == null ? '矢印の始点になるポイントをタップ'
      : '終点のポイントをタップ（続けてタップで連続作成・空白タップで終了）';
  }
  if (ui.mode === 'draw') {
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (!ui.draft.length) {
      text = touch ? 'なぞって手描き／タップで直線をつなぐ（2本指で地図を移動）'
        : 'ドラッグで手描き／クリックで直線をつなぐ（右ドラッグで地図を移動）';
    } else {
      text = ui.draft.length >= 3 ? '最後の点をもう一度タップで完了／始点をタップで図形として閉じる'
        : '続けて描く／最後の点をもう一度タップで完了';
    }
  }
  $('#hint').textContent = text;
}

function setMode(mode) {
  if (ui.mode === 'draw' && mode !== 'draw' && ui.draft.length) finishDraft(false);
  stroke = null;
  ui.mode = mode;
  ui.arrowFrom = null;
  $$('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const m = $('#map');
  m.classList.remove('mode-select', 'mode-point', 'mode-arrow', 'mode-pin', 'mode-draw');
  m.classList.add(`mode-${mode}`);
  if (map) {
    if (mode === 'select') map.doubleClickZoom.enable(); else map.doubleClickZoom.disable();
  }
  updateHint();
  updateDrawBar();
  render();
}

// ============================================================
// 保存・読込・共有
// ============================================================
function openModal(html) {
  $('#modal .modal-card').innerHTML = html;
  $('#modal').hidden = false;
  return $('#modal .modal-card');
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modal .modal-card').innerHTML = '';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function urlWarningsHtml(len) {
  const warn = len > 8000
    ? `<div class="warn">URLが ${len.toLocaleString()} 文字あります。長すぎて開けないアプリが多いため、「JSONで保存」を使ってください。</div>`
    : len > 2000
      ? `<div class="warn">URLが ${len.toLocaleString()} 文字あります。チャットやメール、埋め込み先のサービスによっては途中で切れることがあります。</div>`
      : '';
  const local = location.protocol === 'file:'
    ? '<div class="warn">ファイルを直接開いているため、このURLは他の端末では開けません。Webサーバーに置くと共有できます。</div>' : '';
  return warn + local;
}

async function shareUrl() {
  const hash = await encodeDoc(toDoc());
  const url = `${location.origin}${location.pathname}#${hash}`;
  const len = url.length;
  const card = openModal(`<h2>共有URL</h2>
    <textarea readonly rows="4">${esc(url)}</textarea>
    <p class="note">${len.toLocaleString()} 文字。このURLを開くと、今の地図がそのまま再現されます。</p>${urlWarningsHtml(len)}
    <div class="modal-actions">
      ${navigator.share ? '<button class="btn" data-m="share">共有…</button>' : ''}
      <button class="btn primary" data-m="copy">コピー</button>
      <button class="btn" data-m="close">閉じる</button>
    </div>`);
  card.querySelector('textarea').addEventListener('focus', e => e.target.select());
  card.onclick = async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    if (b.dataset.m === 'copy') toast(await copyText(url) ? 'URLをコピーしました' : 'コピーできませんでした');
    if (b.dataset.m === 'share') navigator.share({ title: state.title || 'TemporaryMyMap', url }).catch(() => {});
    if (b.dataset.m === 'close') closeModal();
  };
}

// ------------------------------------------------------------
// 埋め込み（閲覧専用）: config.js の embed が true のときだけ使える
// ------------------------------------------------------------
function embedUrl(hash, opt) {
  const q = new URLSearchParams({ embed: '1' });
  if (!opt.fit) q.set('fit', '0');
  if (!opt.interactive) q.set('static', '1');
  if (!opt.link) q.set('link', '0');
  return `${location.origin}${location.pathname}?${q}#${hash}`;
}
function embedHtml(url, opt) {
  const width = opt.full ? '100%' : String(opt.width);
  const title = state.title.trim() || '地図';
  return `<iframe src="${esc(url)}" width="${width}" height="${opt.height}" style="border:0;max-width:100%" `
    + `loading="lazy" title="${esc(title)}" allowfullscreen></iframe>`;
}

async function openEmbedDialog() {
  if (!CONFIG.embed) return;
  const hash = await encodeDoc(toDoc());
  const opt = { width: 600, height: 450, full: false, fit: true, interactive: true, link: true };
  const card = openModal(`<h2>埋め込み（閲覧専用）</h2>
    <p class="note">他のサイトやブログに貼り付けて、この地図を閲覧専用で表示できます。貼り付けた後に地図を編集しても埋め込み側には反映されないので、変更したら作り直してください。</p>
    <div class="two-col">
      <label class="range-row">幅（px）<input type="number" data-em="width" min="200" max="2000" value="${opt.width}"></label>
      <label class="range-row">高さ（px）<input type="number" data-em="height" min="150" max="2000" value="${opt.height}"></label>
    </div>
    <label class="check"><input type="checkbox" data-em="full"> 幅を貼り付け先に合わせる（100%）</label>
    <div class="field-label">表示範囲</div>
    <div class="seg">
      <button type="button" data-em-seg="fit" data-v="true" class="on">全体が収まるように</button>
      <button type="button" data-em-seg="fit" data-v="false">今の表示範囲</button>
    </div>
    <div class="field-label">地図の操作</div>
    <div class="seg">
      <button type="button" data-em-seg="interactive" data-v="true" class="on">移動・拡大できる</button>
      <button type="button" data-em-seg="interactive" data-v="false">固定（画像のように表示）</button>
    </div>
    <label class="check"><input type="checkbox" data-em="link" checked> 「大きな地図で見る」リンクを表示</label>
    <div class="field-label">プレビュー</div>
    <iframe class="embed-preview" title="埋め込みプレビュー"></iframe>
    <div class="field-label">埋め込み用HTML</div>
    <textarea readonly rows="4" data-em-out="html"></textarea>
    <div class="field-label">閲覧専用URL</div>
    <textarea readonly rows="2" data-em-out="url"></textarea>
    <div data-em-out="warn"></div>
    <div class="modal-actions">
      <button class="btn" data-m="copy-url">URLをコピー</button>
      <button class="btn primary" data-m="copy-html">HTMLをコピー</button>
      <button class="btn" data-m="close">閉じる</button>
    </div>`);

  const preview = card.querySelector('.embed-preview');
  let previewTimer = 0;
  const update = () => {
    const url = embedUrl(hash, opt);
    card.querySelector('[data-em-out="url"]').value = url;
    card.querySelector('[data-em-out="html"]').value = embedHtml(url, opt);
    card.querySelector('[data-em-out="warn"]').innerHTML = urlWarningsHtml(url.length);
    $$('[data-em-seg]', card).forEach(b => b.classList.toggle('on', String(opt[b.dataset.emSeg]) === b.dataset.v));
    // プレビューは実際の高さに合わせる（モーダルに収まるよう上限あり）
    preview.style.height = `${Math.min(opt.height, 320)}px`;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { if (preview.src !== url) preview.src = url; }, 300);
  };
  card.addEventListener('input', (e) => {
    const key = e.target.dataset.em;
    if (!key) return;
    if (e.target.type === 'checkbox') opt[key] = e.target.checked;
    else opt[key] = clamp(Math.round(Number(e.target.value) || 0), 150, 2000);
    update();
  });
  $$('textarea', card).forEach(t => t.addEventListener('focus', () => t.select()));
  card.onclick = async (e) => {
    const seg = e.target.closest('[data-em-seg]');
    if (seg) { opt[seg.dataset.emSeg] = seg.dataset.v === 'true'; update(); return; }
    const b = e.target.closest('[data-m]');
    if (!b) return;
    if (b.dataset.m === 'copy-url') toast(await copyText(embedUrl(hash, opt)) ? 'URLをコピーしました' : 'コピーできませんでした');
    if (b.dataset.m === 'copy-html') toast(await copyText(embedHtml(embedUrl(hash, opt), opt)) ? '埋め込み用HTMLをコピーしました' : 'コピーできませんでした');
    if (b.dataset.m === 'close') closeModal();
  };
  update();
}

// 閲覧専用表示として起動する
async function initEmbed() {
  document.body.classList.add('embed');
  if (!CONFIG.embed) { showBlocked('このサイトでは地図の埋め込み表示が無効になっています。'); return; }
  let doc = null;
  try { doc = await decodeHash(location.hash); } catch (_) { /* 下で表示 */ }
  if (!doc) { showBlocked('地図データが見つかりません。埋め込み用HTMLを作り直してください。'); return; }
  try { state = stateFromDoc(doc); } catch (_) { showBlocked('地図データを読み込めませんでした。'); return; }
  const fit = EMBED_PARAMS.get('fit') !== '0';
  const interactive = EMBED_PARAMS.get('static') !== '1';
  ui.mode = 'view';
  ui.panelOpen = false;
  createMap(viewFromDoc(doc) || DEFAULT_VIEW, { interactive, embed: true });
  if (fit) fitAll(false);
  updateTitleOverlay();
  if (EMBED_PARAMS.get('link') !== '0') {
    const a = $('#embed-link');
    a.href = `${location.pathname}${location.hash}`;
    a.hidden = false;
  }
}

function showBlocked(message) {
  document.body.classList.add('blocked');
  $('#blocked-message').textContent = message;
  $('#blocked').hidden = false;
}

function saveJson() {
  const blob = new Blob([JSON.stringify(toDoc(), null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${fileBase()}.json`);
}

async function loadFile(file) {
  try {
    const doc = JSON.parse(await file.text());
    loadDoc(doc);
    toast(`「${file.name}」を読み込みました`);
  } catch (err) {
    toast(`読み込めませんでした: ${err.message}`, 4000);
  }
}

function loadDoc(doc, { recordUndo = true } = {}) {
  const next = stateFromDoc(doc);
  const prevStyle = state.style;
  if (recordUndo) pushUndo();
  state = next;
  ui.sel = null;
  ui.arrowFrom = null;
  ui.draft = [];
  applyStateToMap(prevStyle);
  const view = viewFromDoc(doc);
  if (view) map.jumpTo(view);
  else if (state.points.length || state.lines.length || state.pins.length) fitAll(false);
  updateDrawBar();
  renderPanel();
  scheduleSave();
}

function newMap() {
  if ((state.points.length || state.arrows.length || state.lines.length || state.pins.length || state.title) &&
      !confirm('ポイント・矢印・線・固定ラベル・タイトルをすべて消去します。よろしいですか？\n（「元に戻す」で復元できます）')) return;
  pushUndo();
  const keep = { style: state.style, lang: state.lang };
  state = { ...newState(), ...keep };
  ui.sel = null;
  ui.arrowFrom = null;
  cancelDraft();
  applyStateToMap(keep.style);
  renderPanel();
  scheduleSave();
}

// ------------------------------------------------------------
// 画像出力
// ------------------------------------------------------------
function waitIdle(timeout = 15000) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, timeout);
    map.once('idle', () => { clearTimeout(t); resolve(); });
    map.triggerRepaint();
  });
}

function drawTitle(ctx, text, k) {
  const fs = 20 * k, padX = 14 * k, padY = 9 * k, x = 12 * k, y = 12 * k;
  ctx.font = `bold ${fs}px ${CANVAS_FONT}`;
  const w = ctx.measureText(text).width + padX * 2, h = fs * 1.35 + padY * 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.25)';
  ctx.shadowBlur = 6 * k;
  roundRectPath(ctx, x, y, w, h, 8 * k);
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#1f2328';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2);
}

function drawScaleBar(ctx, k, H) {
  const lat = map.getCenter().lat;
  const mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * Math.pow(2, map.getZoom()));
  const maxM = mpp * 120;
  const pow = Math.pow(10, Math.floor(Math.log10(maxM)));
  const nice = [5, 2, 1].map(m => m * pow).find(v => v <= maxM) || pow;
  const px = nice / mpp * k;
  const label = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
  const x = 14 * k, y = H - 16 * k;
  ctx.font = `${11 * k}px ${CANVAS_FONT}`;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillRect(x - 6 * k, y - 22 * k, Math.max(px, tw) + 12 * k, 28 * k);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2 * k;
  ctx.beginPath();
  ctx.moveTo(x, y - 6 * k); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 6 * k);
  ctx.stroke();
  ctx.fillStyle = '#333';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, x, y - 9 * k);
}

// 画像に書き込む出典表記。画面の出典表示と同じく、config の出典とベース地図のスタイルに含まれる出典をまとめる
function attributionText() {
  const parts = [];
  if (CONFIG.attribution) parts.push(CONFIG.attribution);
  const style = map && map.getStyle();
  for (const [id, def] of Object.entries((style && style.sources) || {})) {
    // 出典はスタイル JSON ではなく TileJSON 側にあることが多いので、読み込み済みのソースから取る
    const src = map.getSource(id);
    const html = (src && src.attribution) || def.attribution;
    if (!html) continue;
    // 出典は HTML（リンク付き）なのでテキストだけ取り出す
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join(' / ') || FALLBACK_ATTRIBUTION;
}

function drawAttribution(ctx, k, W, H) {
  const text = attributionText();
  let fs = 10 * k;
  ctx.font = `${fs}px ${CANVAS_FONT}`;
  // 画像の幅に収まらない場合は文字を小さくする
  const maxW = W - 16 * k;
  if (ctx.measureText(text).width > maxW) {
    fs *= maxW / ctx.measureText(text).width;
    ctx.font = `${fs}px ${CANVAS_FONT}`;
  }
  const tw = ctx.measureText(text).width;
  const pad = 4 * k, h = fs + 6 * k;
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.fillRect(W - tw - pad * 2, H - h, tw + pad * 2, h);
  ctx.fillStyle = '#333';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W - tw - pad, H - h / 2);
}

let exporting = false;
async function renderImage(scale) {
  if (!styleReady) throw new Error('地図の読み込み中です');
  if (ui.draft.length) finishDraft(false); // 描きかけの線は確定してから出力する
  const prevSel = ui.sel, prevFrom = ui.arrowFrom;
  const prevPR = map.getPixelRatio();
  ui.sel = null; ui.arrowFrom = null; ui.exporting = true;
  setHitLayersVisible(false);
  render();
  map.setPixelRatio(scale);
  try {
    await waitIdle();
    const src = map.getCanvas();
    const k = src.width / map.getContainer().clientWidth;
    const [out, ctx] = makeCanvas(src.width, src.height);
    ctx.drawImage(src, 0, 0);
    if ($('#opt-title').checked && state.title.trim()) drawTitle(ctx, state.title.trim(), k);
    if ($('#opt-scalebar').checked) drawScaleBar(ctx, k, out.height);
    drawAttribution(ctx, k, out.width, out.height);
    return out;
  } finally {
    map.setPixelRatio(prevPR);
    ui.exporting = false;
    ui.sel = prevSel;
    ui.arrowFrom = prevFrom;
    setHitLayersVisible(true);
    render();
  }
}

async function exportPng() {
  if (exporting) return;
  exporting = true;
  toast('画像を作成しています…', 10000);
  try {
    const canvas = await renderImage(ui.scale);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('画像が大きすぎます。解像度を下げてください');
    $('#toast').hidden = true;
    const name = `${fileBase()}.png`;
    const url = URL.createObjectURL(blob);
    const file = new File([blob], name, { type: 'image/png' });
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    const card = openModal(`<h2>画像を保存</h2>
      <img class="preview" src="${url}" alt="地図のプレビュー">
      <p class="note">${canvas.width} × ${canvas.height} px。スマートフォンでは画像を長押しして保存することもできます。</p>
      <div class="modal-actions">
        ${canShare ? '<button class="btn" data-m="share">共有・写真に保存…</button>' : ''}
        <a class="btn primary" href="${url}" download="${esc(name)}">ダウンロード</a>
        <button class="btn" data-m="close">閉じる</button>
      </div>`);
    card.onclick = (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      if (b.dataset.m === 'share') navigator.share({ files: [file], title: state.title || name }).catch(() => {});
      if (b.dataset.m === 'close') { closeModal(); URL.revokeObjectURL(url); }
    };
  } catch (err) {
    toast(`画像を作成できませんでした: ${err.message}`, 4000);
  } finally {
    exporting = false;
  }
}

async function printMap() {
  if (exporting) return;
  exporting = true;
  toast('印刷用の画像を作成しています…', 10000);
  try {
    const canvas = await renderImage(Math.max(2, ui.scale));
    const img = $('#print-img');
    img.src = canvas.toDataURL('image/png');
    await img.decode().catch(() => {});
    $('#toast').hidden = true;
    window.print();
  } catch (err) {
    toast(`印刷できませんでした: ${err.message}`, 4000);
  } finally {
    exporting = false;
  }
}

// ============================================================
// イベント配線
// ============================================================
function bindUi() {
  // ツールバー・各種ボタン
  document.addEventListener('click', (e) => {
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) { setMode(modeBtn.dataset.mode); return; }

    const tab = e.target.closest('.tab');
    if (tab) {
      ui.tab = tab.dataset.tab;
      renderTabs();
      if (!ui.panelOpen) setPanelOpen(true);
      return;
    }

    const scaleBtn = e.target.closest('[data-scale]');
    if (scaleBtn) { ui.scale = +scaleBtn.dataset.scale; syncGlobalControls(); return; }

    const g = e.target.closest('button[data-g]');
    if (g) { setGlobal(g.dataset.g, g.dataset.v); return; }

    const act = e.target.closest('[data-act]');
    if (act) { runAction(act.dataset.act); return; }
  });

  // エディタ
  const editor = $('#editor');
  editor.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f][data-v]');
    if (b) setField(b.dataset.f, b.dataset.v, true);
  });
  editor.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset.f || t.tagName === 'BUTTON') return;
    setField(t.dataset.f, t.type === 'checkbox' ? t.checked : t.value, false);
  });
  editor.addEventListener('change', (e) => {
    if (e.target.type === 'color') renderEditor(); // スウォッチの選択状態を更新
  });

  // 一覧
  $('section[data-section="items"]').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-t]');
    if (!li) return;
    const type = li.dataset.t, id = +li.dataset.id;
    if (e.target.closest('[data-item-del]')) { deleteItem(type, id); return; }
    select({ type, id });
    revealItem(type, id);
  });

  // 表示タブの入力
  $('section[data-section="view"]').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.g === 'title') {
      pushUndoCoalesced('title');
      state.title = t.value;
      updateTitleOverlay();
      scheduleSave();
    } else if (t.dataset.g === 'fade') {
      pushUndoCoalesced('fade');
      state.fade = +t.value;
      applyBaseSettings();
      scheduleSave();
    } else if (t.dataset.g === 'label') {
      pushUndo();
      state.labels[t.dataset.cat] = t.checked;
      applyBaseSettings();
      scheduleSave();
    }
  });

  // ファイル読込
  const fileInput = $('#file-input');
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // モーダル
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  // キーボード
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) { closeModal(); return; }
      if (ui.draft.length) { cancelDraft(); return; }
      if (ui.arrowFrom != null) { ui.arrowFrom = null; render(); updateHint(); return; }
      if (ui.sel) { select(null); return; }
      setMode('select');
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    if (ui.draft.length) {
      if (e.key === 'Enter') { e.preventDefault(); finishDraft(false); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); undoDraftVertex(); return; }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && ui.sel) { e.preventDefault(); deleteSel(); return; }
    const keyModes = { v: 'select', p: 'point', a: 'arrow', d: 'draw', l: 'pin' };
    const k = e.key.toLowerCase();
    if (keyModes[k]) setMode(keyModes[k]);
    else if (k === 'f') fitAll();
  });

  window.addEventListener('hashchange', loadFromHash);
}

function setGlobal(key, value) {
  if (key === 'style') {
    if (state.style === value || !STYLES[value]) return;
    pushUndo();
    const prev = state.style;
    state.style = value;
    applyStateToMap(prev);
  } else if (key === 'lang') {
    if (state.lang === value) return;
    pushUndo();
    state.lang = value;
    applyBaseSettings();
  }
  syncGlobalControls();
  scheduleSave();
}

function runAction(act) {
  switch (act) {
    case 'fit': fitAll(); break;
    case 'undo': undo(); break;
    case 'export-png': exportPng(); break;
    case 'print': printMap(); break;
    case 'share-url': shareUrl(); break;
    case 'embed': openEmbedDialog(); break;
    case 'save-json': saveJson(); break;
    case 'load-json': $('#file-input').click(); break;
    case 'new-map': newMap(); break;
    case 'toggle-panel': setPanelOpen(!ui.panelOpen); break;
    case 'deselect': select(null); break;
    case 'delete': deleteSel(); break;
    case 'reverse': reverseArrow(); break;
    case 'number-points': numberPoints(); break;
    case 'pin-visible': pinVisiblePlaces(); break;
    case 'draft-done': finishDraft(false); break;
    case 'draft-close': finishDraft(true); break;
    case 'draft-undo': undoDraftVertex(); break;
    case 'draft-cancel': cancelDraft(); break;
    case 'arrow-from': {
      const id = ui.sel && ui.sel.id;
      setMode('arrow');
      ui.arrowFrom = id;
      render();
      updateHint();
      if (isMobile()) setPanelOpen(false);
      break;
    }
    case 'clear-pins':
      if (!state.pins.length) break;
      pushUndo();
      state.pins = [];
      if (ui.sel && ui.sel.type === 'pin') ui.sel = null;
      render(); renderPanel(); scheduleSave();
      break;
    case 'labels-none':
    case 'labels-all':
      pushUndo();
      for (const c of LABEL_CATS) state.labels[c.key] = act === 'labels-all';
      applyBaseSettings(); syncGlobalControls(); scheduleSave();
      break;
  }
}

// 一覧から選んだ要素が画面外なら地図を寄せる
function revealItem(type, id) {
  let lngLat;
  if (type === 'arrow') {
    const a = getArrow(id), p1 = a && getPoint(a.from), p2 = a && getPoint(a.to);
    if (!p1 || !p2) return;
    lngLat = [(p1.lng + p2.lng) / 2, (p1.lat + p2.lat) / 2];
  } else if (type === 'line') {
    const l = getLine(id);
    if (!l) return;
    lngLat = l.coords[Math.floor(l.coords.length / 2)];
  } else {
    const o = getObj({ type, id });
    if (!o) return;
    lngLat = [o.lng, o.lat];
  }
  const px = map.project(lngLat), c = map.getContainer();
  if (px.x < 40 || px.y < 40 || px.x > c.clientWidth - 40 || px.y > c.clientHeight - 40) {
    map.easeTo({ center: lngLat, duration: 500 });
  }
}

async function loadFromHash() {
  if (!/^#[mj]=/.test(location.hash)) return;
  try {
    const doc = await decodeHash(location.hash);
    loadDoc(doc);
    toast('URLから地図を読み込みました');
  } catch (err) {
    toast('URLの地図データを読み込めませんでした', 4000);
  }
  // 読み込み後は URL を素に戻す（以降の編集は自動保存される）
  history.replaceState(null, '', location.pathname + location.search);
}

// ============================================================
// 起動
// ============================================================
async function init() {
  if (IS_EMBED) { await initEmbed(); return; }
  if (IS_FRAMED && !CONFIG.embed) {
    document.body.classList.add('embed');
    showBlocked('このサイトでは地図の埋め込み表示が無効になっています。');
    return;
  }
  $('#embed-section').hidden = !CONFIG.embed;
  bindUi();
  let doc = null, fromHash = false;
  if (/^#[mj]=/.test(location.hash)) {
    try { doc = await decodeHash(location.hash); fromHash = true; } catch (_) { toast('URLの地図データを読み込めませんでした', 4000); }
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!doc) doc = readAutosave();
  let view = DEFAULT_VIEW;
  if (doc) {
    try {
      state = stateFromDoc(doc);
      view = viewFromDoc(doc) || DEFAULT_VIEW;
    } catch (_) { state = newState(); }
  }
  createMap(view);
  setMode('select');
  setPanelOpen(ui.panelOpen);
  renderPanel();
  if (fromHash) {
    scheduleSave(); // URL を消した後に再読込しても復元できるように
    toast('URLから地図を読み込みました');
  }
}

init();
})();

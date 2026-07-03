'use strict';

/* ═══════════════════════════════════════════════════
   Netometer — app.js
   Real-time network monitoring
═══════════════════════════════════════════════════ */

/* ── Config ──────────────────────────────────────── */
const CFG = {
  PING_EVERY_MS:   5_000,
  DL_EVERY_MS:    30_000,
  UL_EVERY_MS:    60_000,
  DNS_EVERY_MS:   30_000,
  WINDOW_MS:    5 * 60 * 1_000,   // 5-minute history

  PING_MAX:   500,   // gauge ceiling ms
  DL_MAX:    1000,   // gauge ceiling Mbps
  UL_MAX:     500,

  PING_GOOD:   50,
  PING_FAIR:  150,

  PING_URL: 'https://www.google.com/generate_204',
  DL_URL:   'https://speed.cloudflare.com/__down',
  UL_URL:   'https://speed.cloudflare.com/__up',
  DNS_URL:  'https://dns.google/resolve?name=google.com&type=A',
  IP_URL:   'https://ip-api.com/json?fields=status,country,regionName,city,isp,org,query',

  DL_BYTES: 25 * 1024 * 1024,   // 25 MB
  UL_BYTES:  2 * 1024 * 1024,   //  2 MB

  /* SVG gauge geometry */
  GCX: 100, GCY: 90, GR: 80,
  GSTART: 225, GTOTAL: 270,
};

/* ── State ───────────────────────────────────────── */
const S = {
  online:  navigator.onLine,

  /* Ping tracking */
  pings:   [],    // all successful ping (ms) values
  failed:  0,     // count of failed/timed-out pings
  total:   0,     // total ping attempts
  jitter:  0,     // avg |Δping|
  dnsMs:   0,

  /* Speed history */
  dl: { cur: 0, peak: 0, hist: [] },
  ul: { cur: 0, peak: 0, hist: [] },

  /* Chart data */
  chart:    [],   // [{ts, ping}]  ping=null → offline
  dlEvents: [],   // [{ts, mbps}]  markers on chart
  ulEvents: [],   // [{ts, mbps}]

  /* IP / ISP info */
  info: null,
};

/* ── Utility helpers ─────────────────────────────── */
const avg    = a  => a.length ? a.reduce((x,y) => x + y, 0) / a.length : 0;
const clamp  = (v,lo,hi) => Math.max(lo, Math.min(hi, v));
const fmt1   = v  => (+v).toFixed(1);
const sleep  = ms => new Promise(r => setTimeout(r, ms));

/** fetch with a hard timeout (AbortController fallback for older engines) */
function fetchTO(url, opts = {}, ms = 8_000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
}

/* ═══════════════════════════════════════════════════
   SVG GAUGE
═══════════════════════════════════════════════════ */
/** Clock-degrees → SVG {x, y} (0 = top, increases clockwise) */
function polar(cx, cy, r, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** Build an SVG arc path string, CW from a1° to a2° (clock convention) */
function arcD(cx, cy, r, a1, a2) {
  const span = a2 - a1;
  if (span < 0.5) return '';
  const s  = polar(cx, cy, r, a1);
  const e  = polar(cx, cy, r, a2);
  const lg = span > 180 ? 1 : 0;
  /* sweep = 1 → CW on screen; this traces the arc going over the top */
  return `M${s.x.toFixed(2)} ${s.y.toFixed(2)} A${r} ${r} 0 ${lg} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

function trackArcD()  { return arcD(CFG.GCX, CFG.GCY, CFG.GR, CFG.GSTART, CFG.GSTART + CFG.GTOTAL); }
function fillArcD(v, max) {
  if (!v || v <= 0) return '';
  return arcD(CFG.GCX, CFG.GCY, CFG.GR, CFG.GSTART, CFG.GSTART + CFG.GTOTAL * clamp(v / max, 0, 1));
}

function initTracks() {
  const d = trackArcD();
  ['ping-track','dl-track','ul-track'].forEach(id => { const el = qs(id); if(el) el.setAttribute('d', d); });
}

function setGauge(fillId, numId, val, max, isFloat) {
  const f = qs(fillId), n = qs(numId);
  if (f) f.setAttribute('d', fillArcD(val, max));
  if (n) n.textContent = val > 0 ? (isFloat ? fmt1(val) : Math.round(val)) : '—';
}

/* ═══════════════════════════════════════════════════
   CANVAS TIMELINE CHART
═══════════════════════════════════════════════════ */
let canvas, ctx;

function initChart() {
  canvas = document.getElementById('timeline-canvas');
  ctx    = canvas.getContext('2d');
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);
  requestAnimationFrame(drawLoop);
}

function sizeCanvas() {
  const wrap = canvas.parentElement;
  const dpr  = window.devicePixelRatio || 1;
  const w    = wrap.clientWidth;
  const h    = wrap.clientHeight;
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
}

function drawLoop() {
  requestAnimationFrame(drawLoop);
  if (!ctx) return;
  drawChart();
}

function pingColor(ping) {
  if (ping === null)           return '#ef4444';
  if (ping < CFG.PING_GOOD)   return '#22c55e';
  if (ping < CFG.PING_FAIR)   return '#f59e0b';
  return '#ef4444';
}

function drawChart() {
  const W   = canvas.width;
  const H   = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const now = Date.now();
  const win = CFG.WINDOW_MS;

  ctx.clearRect(0, 0, W, H);

  /* Background */
  ctx.fillStyle = 'rgba(4,7,14,1)';
  ctx.fillRect(0, 0, W, H);

  /* Dynamic Y scale */
  const validPings = S.chart.filter(p => p.ping != null).map(p => p.ping);
  const yMax = validPings.length ? Math.max(200, Math.max(...validPings) * 1.25) : 200;
  updateYAxis(yMax);

  const toX = ts  => W * (1 - (now - ts) / win);
  const toY = val => H * (1 - val / yMax);

  /* Pale zone bands */
  const zones = [
    [0,             CFG.PING_GOOD, 'rgba(34,197,94,0.025)'],
    [CFG.PING_GOOD, CFG.PING_FAIR, 'rgba(245,158,11,0.025)'],
    [CFG.PING_FAIR, yMax,          'rgba(239,68,68,0.025)'],
  ];
  for (const [lo, hi, col] of zones) {
    ctx.fillStyle = col;
    ctx.fillRect(0, toY(hi), W, toY(lo) - toY(hi));
  }

  /* Grid lines */
  ctx.setLineDash([]);
  const gridVals = [50, 100, 150, 200, 300, 400, 500].filter(v => v < yMax);
  ctx.lineWidth = dpr;
  for (const v of gridVals) {
    ctx.strokeStyle = 'rgba(255,255,255,0.032)';
    ctx.beginPath(); ctx.moveTo(0, toY(v)); ctx.lineTo(W, toY(v)); ctx.stroke();
  }

  /* Threshold dashed lines */
  for (const [v, col] of [[CFG.PING_GOOD,'rgba(34,197,94,0.22)'], [CFG.PING_FAIR,'rgba(239,68,68,0.22)']]) {
    if (v >= yMax) continue;
    ctx.strokeStyle = col; ctx.lineWidth = dpr;
    ctx.setLineDash([5 * dpr, 5 * dpr]);
    ctx.beginPath(); ctx.moveTo(0, toY(v)); ctx.lineTo(W, toY(v)); ctx.stroke();
  }
  ctx.setLineDash([]);

  /* Vertical time marks every minute */
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = dpr;
  for (let m = 1; m <= 5; m++) {
    const x = W * m / 5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillStyle = 'rgba(100,120,150,0.35)';
    ctx.font = `${9 * dpr}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`-${5 - m}m`, x, H - 4 * dpr);
  }

  /* Visible data within window */
  const vis = S.chart.filter(p => (now - p.ts) < win + 2000);
  if (vis.length === 0) {
    ctx.fillStyle = 'rgba(90,106,132,0.45)';
    ctx.font = `${12 * dpr}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Collecting data…', W / 2, H / 2);
    return;
  }

  /* Offline fill bands */
  for (let i = 1; i < vis.length; i++) {
    if (vis[i].ping === null) {
      const x1 = toX(vis[i - 1].ts);
      const x2 = Math.min(toX(vis[i].ts), W);
      ctx.fillStyle = 'rgba(58,16,16,0.55)';
      ctx.fillRect(x1, 0, x2 - x1, H);
    }
  }

  /* Ping line — colored by quality */
  ctx.lineWidth  = 2 * dpr;
  ctx.lineJoin   = 'round';
  ctx.lineCap    = 'round';

  for (let i = 1; i < vis.length; i++) {
    const p = vis[i - 1], q = vis[i];
    if (p.ping == null || q.ping == null) continue;
    const x1 = toX(p.ts), y1 = toY(p.ping);
    const x2 = toX(q.ts), y2 = toY(q.ping);
    const g  = ctx.createLinearGradient(x1, 0, x2, 0);
    g.addColorStop(0, pingColor(p.ping));
    g.addColorStop(1, pingColor(q.ping));
    ctx.strokeStyle  = g;
    ctx.shadowColor  = pingColor(q.ping);
    ctx.shadowBlur   = 5 * dpr;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.shadowBlur = 0;

  /* Dots at each sample */
  for (const p of vis) {
    if (p.ping == null) continue;
    const x = toX(p.ts), y = toY(p.ping);
    ctx.fillStyle = pingColor(p.ping);
    ctx.shadowColor = pingColor(p.ping);
    ctx.shadowBlur  = 3 * dpr;
    ctx.beginPath(); ctx.arc(x, y, 2.5 * dpr, 0, Math.PI * 2); ctx.fill();
  }
  ctx.shadowBlur = 0;

  /* Download event markers — small cyan triangle top */
  for (const ev of S.dlEvents) {
    if ((now - ev.ts) > win) continue;
    const x = toX(ev.ts);
    ctx.fillStyle = 'rgba(0,229,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(x, 10 * dpr);
    ctx.lineTo(x - 5 * dpr, 2 * dpr);
    ctx.lineTo(x + 5 * dpr, 2 * dpr);
    ctx.closePath(); ctx.fill();
  }

  /* Upload event markers — small purple triangle bottom */
  for (const ev of S.ulEvents) {
    if ((now - ev.ts) > win) continue;
    const x = toX(ev.ts);
    ctx.fillStyle = 'rgba(224,64,251,0.85)';
    ctx.beginPath();
    ctx.moveTo(x, H - 10 * dpr);
    ctx.lineTo(x - 5 * dpr, H - 2 * dpr);
    ctx.lineTo(x + 5 * dpr, H - 2 * dpr);
    ctx.closePath(); ctx.fill();
  }

  /* Count drops */
  const drops = vis.filter(p => p.ping === null).length;
  const dropEl = qs('chart-drop-count');
  if (dropEl) {
    dropEl.textContent = drops === 0 ? 'No drops detected' : `⚠ ${drops} drop${drops > 1 ? 's' : ''} detected`;
    dropEl.className   = drops > 0 ? 'has-drops' : '';
  }
}

let _lastYMax;
function updateYAxis(yMax) {
  if (_lastYMax === yMax) return;
  _lastYMax = yMax;
  const el = document.getElementById('chart-y-axis');
  if (!el) return;
  const steps = [1, 0.75, 0.5, 0.25, 0].map(f => Math.round(yMax * f));
  el.innerHTML = steps.map(v => `<div class="y-label">${v}</div>`).join('');
}

/* ═══════════════════════════════════════════════════
   NETWORK MEASUREMENTS
═══════════════════════════════════════════════════ */
async function measurePing() {
  S.total++;
  try {
    const t0 = performance.now();
    await fetchTO(CFG.PING_URL, { method:'HEAD', mode:'no-cors', cache:'no-store' }, 5_000);
    const ms = performance.now() - t0;

    /* Jitter = mean |Δping| */
    if (S.pings.length > 0) {
      const last = S.pings[S.pings.length - 1];
      const prev = S.jitter;
      S.jitter = prev * 0.8 + Math.abs(ms - last) * 0.2; // EWMA
    }

    S.pings.push(ms);
    S.chart.push({ ts: Date.now(), ping: ms });
    pruneOld();
    S.online = true;
    return ms;
  } catch {
    S.failed++;
    S.chart.push({ ts: Date.now(), ping: null });
    pruneOld();
    if (S.failed / S.total > 0.6) S.online = false;
    return null;
  }
}

async function measureDownload() {
  setCardTesting('card-download', true);
  setBadge('dl-status', 'Testing…', 'badge-spin');
  try {
    const url  = `${CFG.DL_URL}?bytes=${CFG.DL_BYTES}&_=${Date.now()}`;
    const t0   = performance.now();
    const resp = await fetchTO(url, { cache: 'no-store' }, 35_000);
    /* Stream-read to capture bytes actually received */
    const reader = resp.body.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
    const secs = (performance.now() - t0) / 1_000;
    const mbps = (received * 8) / secs / 1e6;
    S.dl.cur  = mbps;
    S.dl.peak = Math.max(S.dl.peak, mbps);
    S.dl.hist.push(mbps);
    S.dlEvents.push({ ts: Date.now(), mbps });
    setBadge('dl-status', 'Done', 'badge-good');
  } catch {
    setBadge('dl-status', 'Error', 'badge-poor');
  } finally {
    setCardTesting('card-download', false);
  }
}

async function measureUpload() {
  setCardTesting('card-upload', true);
  setBadge('ul-status', 'Testing…', 'badge-spin');
  const body = new Uint8Array(CFG.UL_BYTES);
  try {
    const t0 = performance.now();
    await fetchTO(CFG.UL_URL, {
      method: 'POST', body: body.buffer,
      headers: { 'Content-Type': 'application/octet-stream' },
      cache: 'no-store',
    }, 35_000);
    const secs = (performance.now() - t0) / 1_000;
    const mbps = (CFG.UL_BYTES * 8) / secs / 1e6;
    S.ul.cur  = mbps;
    S.ul.peak = Math.max(S.ul.peak, mbps);
    S.ul.hist.push(mbps);
    S.ulEvents.push({ ts: Date.now(), mbps });
    setBadge('ul-status', 'Done', 'badge-good');
  } catch {
    /* fallback: estimate via time-to-abort (upload was still partially sent) */
    setBadge('ul-status', 'Error', 'badge-poor');
  } finally {
    setCardTesting('card-upload', false);
  }
}

async function measureDNS() {
  try {
    const t0 = performance.now();
    const r  = await fetchTO(CFG.DNS_URL, { cache:'no-store' }, 8_000);
    await r.json();
    S.dnsMs = performance.now() - t0;
  } catch { /* ignore */ }
}

async function fetchUserInfo() {
  try {
    const r    = await fetchTO(CFG.IP_URL, {}, 10_000);
    const data = await r.json();
    if (data.status === 'success' || data.query) {
      S.info = data;
      paintInfoBar();
    }
  } catch { /* ignore */ }
}

function pruneOld() {
  const cutoff = Date.now() - CFG.WINDOW_MS - 6_000;
  S.chart    = S.chart.filter(p => p.ts > cutoff);
  S.dlEvents = S.dlEvents.filter(e => e.ts > cutoff);
  S.ulEvents = S.ulEvents.filter(e => e.ts > cutoff);
  /* Keep only last 200 ping values for stats */
  if (S.pings.length > 200) S.pings = S.pings.slice(-200);
}

/* ═══════════════════════════════════════════════════
   UI PAINT FUNCTIONS
═══════════════════════════════════════════════════ */
function paintAll(pingMs) {
  paintStatus();
  paintPing(pingMs);
  paintDownload();
  paintUpload();
  paintSecondary();
  setText('val-updated', new Date().toLocaleTimeString());
}

/* ── Status badge ──────────────────────────────── */
function paintStatus() {
  const dot  = qs('status-dot');
  const lbl  = qs('status-label');
  if (!dot || !lbl) return;
  dot.className = 'status-dot';
  if (!S.online) {
    dot.classList.add('s-offline'); lbl.textContent = 'Offline';
  } else {
    dot.classList.add('s-online');  lbl.textContent = 'Online';
  }
}

/* ── Info bar ──────────────────────────────────── */
function paintInfoBar() {
  if (!S.info) return;
  setText('val-ip',       S.info.query  || '—');
  setText('val-isp',      S.info.isp    || '—');
  setText('val-location', S.info.city   || '—');
  setText('val-region',   [S.info.regionName, S.info.country].filter(Boolean).join(', ') || '—');
}

function paintConnectionType() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    const t = conn.effectiveType || conn.type || '—';
    setText('val-type', t.toUpperCase());
  } else {
    setText('val-type', 'Broadband');
  }
}

/* ── Ping gauge ────────────────────────────────── */
function paintPing(ms) {
  if (ms == null) return;
  setGauge('ping-fill', 'ping-number', ms, CFG.PING_MAX, false);

  const mi = Math.min(...S.pings), mx = Math.max(...S.pings), av = avg(S.pings);
  setText('ping-min', Math.round(mi));
  setText('ping-avg', Math.round(av));
  setText('ping-max', Math.round(mx));

  /* Quality badge */
  const badge = qs('ping-badge');
  if (badge) {
    if (ms < CFG.PING_GOOD)       { badge.textContent='Excellent'; badge.className='gauge-badge badge-good'; }
    else if (ms < CFG.PING_FAIR)  { badge.textContent='Fair';      badge.className='gauge-badge badge-fair'; }
    else                           { badge.textContent='Poor';      badge.className='gauge-badge badge-poor'; }
  }
}

/* ── Download gauge ────────────────────────────── */
function paintDownload() {
  setGauge('dl-fill', 'dl-number', S.dl.cur, CFG.DL_MAX, true);
  setText('dl-last', S.dl.cur > 0 ? fmt1(S.dl.cur) : '—');
  setText('dl-avg',  S.dl.hist.length ? fmt1(avg(S.dl.hist)) : '—');
  setText('dl-peak', S.dl.peak > 0   ? fmt1(S.dl.peak) : '—');
}

/* ── Upload gauge ──────────────────────────────── */
function paintUpload() {
  setGauge('ul-fill', 'ul-number', S.ul.cur, CFG.UL_MAX, true);
  setText('ul-last', S.ul.cur > 0 ? fmt1(S.ul.cur) : '—');
  setText('ul-avg',  S.ul.hist.length ? fmt1(avg(S.ul.hist)) : '—');
  setText('ul-peak', S.ul.peak > 0   ? fmt1(S.ul.peak) : '—');
}

/* ── Secondary metrics ─────────────────────────── */
function paintSecondary() {
  /* Jitter */
  const jms = S.jitter;
  setText('val-jitter', jms > 0 ? fmt1(jms) + ' ms' : '— ms');
  setWidth('bar-jitter', clamp(jms / 100, 0, 1) * 100 + '%');

  /* Packet loss */
  const loss = S.total > 0 ? (S.failed / S.total) * 100 : 0;
  setText('val-loss', fmt1(loss) + ' %');
  setWidth('bar-loss', clamp(loss, 0, 100) + '%');

  /* DNS */
  setText('val-dns', S.dnsMs > 0 ? Math.round(S.dnsMs) + ' ms' : '— ms');
  setWidth('bar-dns', clamp(S.dnsMs / 600, 0, 1) * 100 + '%');

  /* RTT range */
  if (S.pings.length) {
    setText('val-rtt', Math.round(Math.min(...S.pings)) + ' / ' + Math.round(Math.max(...S.pings)));
  }

  /* Quality score */
  const score = computeScore();
  const sEl = qs('val-score'), dEl = qs('desc-score');
  if (sEl) { sEl.textContent = score.letter; sEl.style.color = score.color; }
  if (dEl) dEl.textContent = score.desc;

  /* Sample count */
  setText('val-samples', S.total);
}

function computeScore() {
  if (!S.pings.length) return { letter:'—', color:'#5a6a84', desc:'Waiting for data' };
  const pa   = avg(S.pings);
  const loss = S.total > 0 ? (S.failed / S.total) * 100 : 0;

  let pts = 100;
  if      (pa > 200) pts -= 40;
  else if (pa > 100) pts -= 22;
  else if (pa > 50)  pts -= 10;

  pts -= clamp(loss * 4, 0, 40);

  if      (S.jitter > 50)  pts -= 20;
  else if (S.jitter > 20)  pts -= 10;
  else if (S.jitter > 10)  pts -=  5;

  pts = clamp(pts, 0, 100);

  if (pts >= 92) return { letter:'A+', color:'#22c55e', desc:'Excellent connection' };
  if (pts >= 80) return { letter:'A',  color:'#4ade80', desc:'Great connection' };
  if (pts >= 70) return { letter:'B',  color:'#86efac', desc:'Good connection' };
  if (pts >= 58) return { letter:'C',  color:'#f59e0b', desc:'Fair — some latency' };
  if (pts >= 45) return { letter:'D',  color:'#fb923c', desc:'Poor — high latency' };
  return              { letter:'F',  color:'#ef4444', desc:'Very poor — check your ISP' };
}

/* ═══════════════════════════════════════════════════
   DOM HELPERS
═══════════════════════════════════════════════════ */
const qs = id => document.getElementById(id);

function setText(id, v) { const e = qs(id); if (e) e.textContent = v; }
function setWidth(id, v) { const e = qs(id); if (e) e.style.width = v; }

function setBadge(id, text, cls) {
  const e = qs(id);
  if (!e) return;
  e.textContent = text;
  e.className   = 'gauge-badge ' + cls;
}

function setCardTesting(id, on) {
  const e = qs(id);
  if (!e) return;
  on ? e.classList.add('is-testing') : e.classList.remove('is-testing');
}

/* ═══════════════════════════════════════════════════
   ASYNC MEASUREMENT LOOPS
═══════════════════════════════════════════════════ */
async function pingLoop() {
  while (true) {
    const ms = await measurePing();
    paintAll(ms);
    await sleep(CFG.PING_EVERY_MS);
  }
}

async function downloadLoop() {
  await sleep(2_000);  // slight delay so first ping runs first
  while (true) {
    await measureDownload();
    paintDownload();
    await sleep(CFG.DL_EVERY_MS);
  }
}

async function uploadLoop() {
  await sleep(6_000);
  while (true) {
    await measureUpload();
    paintUpload();
    await sleep(CFG.UL_EVERY_MS);
  }
}

async function dnsLoop() {
  while (true) {
    await measureDNS();
    await sleep(CFG.DNS_EVERY_MS);
  }
}

/* ═══════════════════════════════════════════════════
   ONLINE / OFFLINE BROWSER EVENTS
═══════════════════════════════════════════════════ */
window.addEventListener('online',  () => { S.online = true;  paintStatus(); });
window.addEventListener('offline', () => { S.online = false; paintStatus(); });

/* ═══════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════ */
function init() {
  initTracks();
  initChart();
  paintConnectionType();
  fetchUserInfo();

  pingLoop();
  downloadLoop();
  uploadLoop();
  dnsLoop();

  /* Refresh connection type + updated-time periodically */
  setInterval(paintConnectionType, 10_000);
}

document.addEventListener('DOMContentLoaded', init);

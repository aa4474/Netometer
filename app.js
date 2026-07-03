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
  UL_URLS:  [
    'https://speed.cloudflare.com/__up',
    'https://httpbin.org/post',
    'https://postman-echo.com/post',
  ],
  DNS_URL:  'https://dns.google/resolve?name=google.com&type=A',
  /* IP APIs — tried in order, first success wins
     1. ipinfo.io   — most accurate ISP/ASN globally (uses Probe Network)
     2. ipapi.co    — good city accuracy, free 1k/day
     3. ip-api.com  — reliable fallback                              */
  IP_APIS: [
    { url: 'https://ipinfo.io/json',                                            fmt: 'ipinfo'  },
    { url: 'https://ipapi.co/json/',                                            fmt: 'ipapiCo' },
    { url: 'https://ip-api.com/json?fields=status,country,regionName,city,isp,org,as,query', fmt: 'ipapi'   },
  ],

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

  /* Fill buffer with pseudo-random bytes (avoids compression skewing results) */
  const size = CFG.UL_BYTES;
  const data = new Uint8Array(size);
  try { crypto.getRandomValues(data); } catch { /* IE/old — leave zeroed */ }

  let mbps = 0;

  for (const url of CFG.UL_URLS) {
    try {
      mbps = await uploadXHR(url, data);
      if (mbps > 0) break;          // success — stop trying
    } catch (err) {
      console.warn('[upload] failed on', url, err.message);
    }
  }

  if (mbps > 0) {
    S.ul.cur  = mbps;
    S.ul.peak = Math.max(S.ul.peak, mbps);
    S.ul.hist.push(mbps);
    S.ulEvents.push({ ts: Date.now(), mbps });
    setBadge('ul-status', 'Done', 'badge-good');
  } else {
    setBadge('ul-status', 'Error', 'badge-poor');
  }

  setCardTesting('card-upload', false);
}

/** XHR-based upload so we get real upload-side timing */
function uploadXHR(url, data) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.timeout = 32_000;

    const t0 = performance.now();

    xhr.onload = () => {
      const secs = (performance.now() - t0) / 1_000;
      if (secs <= 0) return reject(new Error('zero time'));
      resolve((data.byteLength * 8) / secs / 1e6);
    };
    xhr.onerror   = () => reject(new Error('xhr error'));
    xhr.ontimeout = () => reject(new Error('xhr timeout'));

    xhr.send(data);
  });
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
  for (const api of CFG.IP_APIS) {
    try {
      const r    = await fetchTO(api.url, {}, 10_000);
      const d    = await r.json();
      const info = parseIPResponse(d, api.fmt);
      if (info) {
        S.info = info;
        paintInfoBar();
        console.log('[ip] resolved via', api.fmt, info);
        return;
      }
    } catch (e) {
      console.warn('[ip]', api.fmt, 'failed:', e.message);
    }
  }
  console.error('[ip] all APIs failed');
}

/**
 * Normalise each API’s response into a common object.
 * Returns null if the response looks invalid.
 */
function parseIPResponse(d, fmt) {
  if (!d) return null;

  if (fmt === 'ipinfo') {
    /* ipinfo.io: org = "AS39386 Saudi Telecom Company" */
    if (!d.ip) return null;
    const orgRaw = d.org || '';
    const asnMatch = orgRaw.match(/^(AS\d+)\s*(.*)$/);
    return {
      query:       d.ip,
      isp:         asnMatch ? asnMatch[2].trim() : orgRaw || '—',
      org:         orgRaw,
      asn:         asnMatch ? asnMatch[1] : '—',
      city:        d.city       || '—',
      regionName:  d.region     || '—',
      country:     countryName(d.country) || d.country || '—',
      countryCode: d.country    || '',
      timezone:    d.timezone   || '—',
      utc:         tzToUTC(d.timezone),
      source:      'ipinfo.io',
    };
  }

  if (fmt === 'ipapiCo') {
    /* ipapi.co: separate asn and org fields */
    if (!d.ip || d.error) return null;
    return {
      query:       d.ip,
      isp:         d.org        || d.asn || '—',
      org:         d.org        || '—',
      asn:         d.asn        || '—',
      city:        d.city       || '—',
      regionName:  d.region     || '—',
      country:     d.country_name || countryName(d.country_code) || '—',
      countryCode: d.country_code || '',
      timezone:    d.timezone   || '—',
      utc:         d.utc_offset || '',
      source:      'ipapi.co',
    };
  }

  if (fmt === 'ipapi') {
    /* ip-api.com: isp and as fields */
    if (d.status !== 'success' && !d.query) return null;
    return {
      query:       d.query,
      isp:         d.isp        || d.org || '—',
      org:         d.org        || '—',
      asn:         d.as ? d.as.split(' ')[0] : '—',
      city:        d.city       || '—',
      regionName:  d.regionName || '—',
      country:     d.country    || '—',
      countryCode: d.countryCode || '',
      timezone:    '—',
      utc:         '',
      source:      'ip-api.com',
    };
  }

  return null;
}

/** Best-effort country code → name (covers the most common codes) */
function countryName(cc) {
  const MAP = {
    SA:'Saudi Arabia', AE:'UAE', KW:'Kuwait', QA:'Qatar', BH:'Bahrain',
    OM:'Oman', JO:'Jordan', IQ:'Iraq', EG:'Egypt', LB:'Lebanon',
    YE:'Yemen', SY:'Syria', PS:'Palestine',
    US:'United States', GB:'United Kingdom', DE:'Germany', FR:'France',
    IN:'India', PK:'Pakistan', CN:'China', JP:'Japan', SG:'Singapore',
    TR:'Turkey', RU:'Russia', NG:'Nigeria', ZA:'South Africa',
  };
  return MAP[cc] || cc;
}

/** IANA timezone → UTC offset string (approximate, good enough for display) */
function tzToUTC(tz) {
  if (!tz) return '';
  try {
    const fmt = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'short' });
    const parts = fmt.formatToParts(new Date());
    const gmt = parts.find(p => p.type === 'timeZoneName');
    return gmt ? gmt.value : '';
  } catch { return ''; }
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

/* ── Info bar ──────────────────────────────────────── */
function paintInfoBar() {
  if (!S.info) return;
  const i = S.info;

  /* Store real IP in dataset — display is controlled by eye toggle */
  const ipEl = qs('val-ip');
  if (ipEl && i.query) {
    ipEl.dataset.ip = i.query;
    if (!ipEl.dataset.revealed) {
      ipEl.textContent = '••••••••••';
    } else {
      ipEl.textContent = i.query;
    }
  }

  /* ISP — if isp === org, show just one; else "ISP (Org)" */
  const ispLabel = (i.isp && i.org && i.isp !== i.org && !i.org.startsWith('AS'))
    ? `${i.isp}`
    : (i.isp || '—');
  setText('val-isp', ispLabel);

  /* Location: City, Country */
  setText('val-location', [i.city, i.country].filter(v => v && v !== '—').join(', ') || '—');

  /* ASN + timezone */
  const asnLabel = i.asn !== '—' && i.utc
    ? `${i.asn}  ·  ${i.utc}`
    : (i.asn || '—');
  setText('val-asn', asnLabel);

  /* Server Select */
  const cc = (i.countryCode || '').toUpperCase();
  initServerSelect(cc);
}

/** Initialize the dropdown with 3 servers closest to the region */
function initServerSelect(cc) {
  const select = qs('server-select');
  if (!select) return;
  
  /* If already initialized, don't rebuild (preserves user selection) */
  if (select.options.length > 1) return;

  const ME  = ['SA','AE','KW','QA','BH','OM','JO','IQ','YE','EG','LB','SY','PS'];
  const EU  = ['DE','FR','GB','NL','PL','ES','IT','SE','NO','DK','FI','CH','AT','BE','CZ','PT'];
  const AS  = ['IN','PK','BD','LK','NP','SG','MY','TH','ID','PH','VN','CN','JP','KR','TW','HK'];
  
  let options = [];
  if (ME.includes(cc)) {
    options = [
      { name: 'Cloudflare (Anycast)', url: 'https://cp.cloudflare.com/generate_204' },
      { name: 'AWS (Bahrain)',        url: 'https://dynamodb.me-south-1.amazonaws.com/ping' },
      { name: 'AWS (UAE)',            url: 'https://dynamodb.me-central-1.amazonaws.com/ping' }
    ];
  } else if (EU.includes(cc)) {
    options = [
      { name: 'Cloudflare (Anycast)', url: 'https://cp.cloudflare.com/generate_204' },
      { name: 'AWS (Frankfurt)',      url: 'https://dynamodb.eu-central-1.amazonaws.com/ping' },
      { name: 'AWS (London)',         url: 'https://dynamodb.eu-west-2.amazonaws.com/ping' }
    ];
  } else if (AS.includes(cc)) {
    options = [
      { name: 'Cloudflare (Anycast)', url: 'https://cp.cloudflare.com/generate_204' },
      { name: 'AWS (Singapore)',      url: 'https://dynamodb.ap-southeast-1.amazonaws.com/ping' },
      { name: 'AWS (Tokyo)',          url: 'https://dynamodb.ap-northeast-1.amazonaws.com/ping' }
    ];
  } else {
    options = [
      { name: 'Cloudflare (Anycast)', url: 'https://cp.cloudflare.com/generate_204' },
      { name: 'Google (Anycast)',     url: 'https://www.google.com/generate_204' },
      { name: 'AWS (N. Virginia)',    url: 'https://dynamodb.us-east-1.amazonaws.com/ping' }
    ];
  }

  select.innerHTML = options.map(o => `<option value="${o.url}">${o.name}</option>`).join('');
  
  /* Update PING_URL on change and reset charts */
  select.addEventListener('change', (e) => {
    CFG.PING_URL = e.target.value;
    S.pings = [];
    S.chart = [];
    S.failed = 0;
    S.total = 0;
    S.jitter = 0;
    paintPing(0);
  });
  
  /* Set initial to first option */
  CFG.PING_URL = options[0].url;
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
   IP EYE TOGGLE
═══════════════════════════════════════════════════ */
const SVG_EYE_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function initIPToggle() {
  const btn  = qs('ip-eye-btn');
  const ipEl = qs('val-ip');
  if (!btn || !ipEl) return;

  btn.addEventListener('click', () => {
    const revealed = ipEl.dataset.revealed === '1';
    if (!revealed) {
      /* Reveal IP */
      ipEl.textContent      = ipEl.dataset.ip || '—';
      ipEl.dataset.revealed = '1';
      btn.innerHTML         = SVG_EYE_OFF;
      btn.title             = 'Hide IP address';
      btn.setAttribute('aria-label', 'Hide IP address');
    } else {
      /* Mask IP */
      ipEl.textContent      = '••••••••••';
      ipEl.dataset.revealed = '0';
      btn.innerHTML         = SVG_EYE_OPEN;
      btn.title             = 'Show IP address';
      btn.setAttribute('aria-label', 'Show IP address');
    }
  });
}


/* ═══════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════ */
function init() {
  initTracks();
  initChart();
  initIPToggle();
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

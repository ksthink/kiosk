const LABEL = { open: '접수중', upcoming: '접수예정', waiting: '대기접수', closed: '마감', unknown: '' };
const RESUME_AFTER_TOUCH_MS = 20000; // 사람이 조작하면 이 시간 동안 자동 넘김을 멈춤

const $ = (s) => document.querySelector(s);
const layers = [...document.querySelectorAll('.slide')];
const panel = $('#panel');
const strip = $('#strip');
const badge = $('#badge');
const titleEl = $('#title');
const progress = $('#progress');
const root = document.documentElement;

let settings = { slideSeconds: 8 };
let list = [];
let index = 0;
let front = 0; // 지금 보이는 레이어
let listSig = '';
let timer = null;
let holdUntil = 0;
let showToken = 0;
const tones = new Map(); // imageSrc → 가장자리 색

// ---------- 색 분석 ----------
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const shade = (c, k) => c.map((v) => Math.round(v * k));

function analyze(img) {
  const key = img.currentSrc || img.src;
  if (tones.has(key)) return tones.get(key);
  const w = 48;
  const h = Math.max(8, Math.round((w * img.naturalHeight) / img.naturalWidth));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // 색을 못 읽으면 기본 배경
  }
  const avg = (x0, y0, x1, y1) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 16) continue; // 투명 픽셀 제외
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    return n ? [r / n, g / n, b / n].map(Math.round) : [14, 14, 16];
  };
  const band = Math.max(1, Math.round(h * 0.02));
  const side = Math.max(1, Math.round(w * 0.02));
  const t = {
    top: avg(0, 0, w, band),
    bottom: avg(0, h - band, w, h),
    left: avg(0, 0, side, h),
    right: avg(w - side, 0, w, h),
  };
  tones.set(key, t);
  return t;
}

// ---------- 배치 ----------
// 포스터를 하단 패널 위 영역에 비율대로 꽉 채우고, 남는 위/아래(또는 좌/우)는 가장자리 색 그라데이션
function layout(layer) {
  const img = layer.querySelector('img');
  if (!img.naturalWidth) return;
  const W = window.innerWidth;
  const H = window.innerHeight - panel.offsetHeight; // 포스터 하단 정보가 패널에 가리지 않게
  const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
  const pw = img.naturalWidth * s;
  const ph = img.naturalHeight * s;
  const left = (W - pw) / 2;
  const top = Math.max(0, (H - ph) / 2);
  Object.assign(img.style, { width: `${pw}px`, height: `${ph}px`, left: `${left}px`, top: `${top}px` });

  const t = analyze(img);
  const sideBars = W - pw > H - ph;
  // 여백이 생기는 쪽 포스터 가장자리를 살짝 투명하게 → 배경 그라데이션과 이음새 없이 섞임
  const fade = (len) => `${Math.min(18, len * 0.025)}px`;
  img.style.webkitMaskImage = !t || Math.abs(sideBars ? W - pw : H - ph) < 2 ? '' : sideBars
    ? `linear-gradient(to right, transparent, #000 ${fade(pw)}, #000 calc(100% - ${fade(pw)}), transparent)`
    : `linear-gradient(to bottom, transparent, #000 ${fade(ph)}, #000 calc(100% - ${fade(ph)}), transparent)`;
  if (!t) {
    layer.style.background = '';
    return;
  }
  const end = window.innerHeight;
  if (sideBars) {
    // 좌우 여백
    layer.style.background = `linear-gradient(to right, ${rgb(shade(t.left, 0.55))} 0, ${rgb(t.left)} ${left}px, ${rgb(t.right)} ${left + pw}px, ${rgb(shade(t.right, 0.55))} 100%)`;
  } else {
    // 위아래 여백: 포스터 경계에서는 가장자리 색 그대로, 화면 끝으로 갈수록 살짝 어둡게
    layer.style.background = `linear-gradient(to bottom, ${rgb(shade(t.top, 0.6))} 0, ${rgb(t.top)} ${top}px, ${rgb(t.bottom)} ${top + ph}px, ${rgb(shade(t.bottom, 0.45))} ${end}px)`;
  }
}

// ---------- 전환 ----------
async function show(i, { instant = false } = {}) {
  if (!list.length) return;
  index = (i + list.length) % list.length;
  const b = list[index];
  const token = ++showToken;

  const back = layers[1 - front];
  const img = back.querySelector('img');
  img.src = b.imageSrc;
  try { await img.decode(); } catch {}
  if (token !== showToken) return; // 그 사이 다른 포스터로 이동함

  layout(back);
  if (instant) back.style.transition = 'none';
  back.classList.add('on');
  layers[front].classList.remove('on');
  if (instant) { void back.offsetWidth; back.style.transition = ''; }
  front = 1 - front;

  updateInfo();
  markThumb();
  schedule();
}

function updateInfo() {
  const b = list[index];
  if (!b) return;
  const s = LABEL[b.status] !== undefined ? b.status : 'unknown';
  const raw = (b.statusText || '').trim();
  badge.dataset.s = s;
  badge.textContent = raw && raw.length <= 16 ? raw : LABEL[s];
  titleEl.textContent = b.title || '';
}

function schedule() {
  clearTimeout(timer);
  progress.classList.remove('run');
  if (list.length < 2) return;
  const wait = Math.max(0, holdUntil - Date.now());
  const dur = settings.slideSeconds * 1000;
  timer = setTimeout(() => {
    progress.style.setProperty('--dur', `${dur}ms`);
    void progress.offsetWidth;
    progress.classList.add('run');
    timer = setTimeout(() => show(index + 1), dur);
  }, wait);
}

function userMove(i) {
  holdUntil = Date.now() + RESUME_AFTER_TOUCH_MS;
  show(i);
}

// ---------- 썸네일 ----------
function buildThumbs() {
  strip.replaceChildren(
    ...list.map((b, i) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'thumb';
      t.dataset.i = i;
      t.innerHTML = '<img alt="" draggable="false">';
      t.querySelector('img').src = b.imageSrc;
      return t;
    }),
  );
  markThumb();
}

function markThumb() {
  strip.querySelectorAll('.thumb').forEach((t, i) => {
    const b = list[i];
    t.classList.toggle('on', i === index);
    if (b) t.dataset.s = LABEL[b.status] !== undefined ? b.status : 'unknown';
  });
  const on = strip.children[index];
  if (on) strip.scrollTo({ left: on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2 });
}

strip.addEventListener('click', (e) => {
  const t = e.target.closest('.thumb');
  if (t) userMove(+t.dataset.i);
});
$('#prevBtn').addEventListener('click', () => userMove(index - 1));
$('#nextBtn').addEventListener('click', () => userMove(index + 1));

// 스와이프
let downX = null;
$('#slides').addEventListener('pointerdown', (e) => (downX = e.clientX));
window.addEventListener('pointerup', (e) => {
  if (downX == null) return;
  const dx = e.clientX - downX;
  downX = null;
  if (Math.abs(dx) > 60) userMove(index + (dx < 0 ? 1 : -1));
});

// ---------- 상태 반영 ----------
function render(state) {
  settings = state.settings;
  const prevId = list[index]?.id;
  list = state.banners.filter((b) => b.active !== false && b.imageSrc);
  root.style.setProperty('--panel-h', `${panel.offsetHeight}px`);
  document.body.classList.toggle('no-items', !list.length);
  $('#empty').hidden = list.length > 0;

  const sig = JSON.stringify(list.map((b) => [b.id, b.imageSrc]));
  if (sig !== listSig) {
    listSig = sig;
    const keep = list.findIndex((b) => b.id === prevId);
    buildThumbs();
    if (!list.length) {
      layers.forEach((l) => l.classList.remove('on'));
      clearTimeout(timer);
      return;
    }
    show(keep >= 0 ? keep : Math.min(index, list.length - 1), { instant: !prevId });
  } else {
    updateInfo();
    markThumb();
  }
}

// ---------- 키보드·도구막대 ----------
$('#adminBtn').addEventListener('click', () => window.api.openAdmin());
$('#emptyAdd').addEventListener('click', () => window.api.openAdmin());
$('#fsBtn').addEventListener('click', () => window.api.setFullscreen());

window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') { e.preventDefault(); window.api.setFullscreen(); }
  else if (e.key === 'Escape') window.api.setFullscreen(false);
  else if (e.key === 'ArrowRight') userMove(index + 1);
  else if (e.key === 'ArrowLeft') userMove(index - 1);
  else if (e.ctrlKey && e.key === ',') { e.preventDefault(); window.api.openAdmin(); }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => layout(layers[front]), 150);
});

let idleTimer;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
}
window.addEventListener('pointermove', wake);
wake();

// 이미지 요청이 CORS 허용되어야 캔버스로 색을 읽을 수 있음
layers.forEach((l) => (l.querySelector('img').crossOrigin = 'anonymous'));

window.api.onState(render);
window.api.getState().then(render);

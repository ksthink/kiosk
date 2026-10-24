const LABEL = { open: '접수중', upcoming: '접수예정', waiting: '대기접수', closed: '마감', unknown: '확인중' };
const GAP = 28;

const track = document.getElementById('track');
const empty = document.getElementById('empty');
const root = document.documentElement;

let current = { settings: { speed: 40, cardWidth: 320, ratio: '4/3' }, banners: [] };
let layoutSig = '';

function makeCard(b, clone) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = b.id;
  el.dataset.link = b.link;
  if (clone) el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="thumb"><img alt="" draggable="false"></div><div class="meta"><span class="badge"></span><span class="title"></span></div>';
  el.querySelector('img').src = b.imageSrc;
  el.querySelector('img').alt = clone ? '' : b.title || '';
  el.querySelector('.title').textContent = b.title || '';
  return el;
}

function flowMode(s) {
  if (s.direction === 'horizontal' || s.direction === 'vertical') return s.direction;
  return window.innerHeight > window.innerWidth ? 'vertical' : 'horizontal';
}

function makeSet(list, clone) {
  const set = document.createElement('div');
  set.className = 'set';
  if (clone) set.setAttribute('aria-hidden', 'true');
  set.append(...list.map((b) => makeCard(b, clone)));
  return set;
}

function build(list, s) {
  const mode = flowMode(s);
  document.body.dataset.mode = mode;
  track.style.animation = 'none';
  track.replaceChildren();
  if (!list.length) return;

  // 세로 흐름에서 배너 수가 한 줄 개수로 나눠떨어지지 않으면 줄 끝에 빈칸이 생기므로, 세트를 반복해 채움
  const vertical = mode === 'vertical';
  const cols = Math.max(1, s.columns || 2);
  let setList = list;
  while (vertical && setList.length % cols) setList = setList.concat(list);

  // 한 세트만큼 이동하면 다음 세트가 정확히 같은 자리에 오도록 → 끊김 없는 무한 흐름
  const first = makeSet(setList, false);
  track.append(first);
  const step = (vertical ? first.offsetHeight : first.offsetWidth) + GAP;
  const view = vertical ? window.innerHeight : window.innerWidth;
  const copies = Math.ceil(view / step) + 1;
  for (let c = 1; c < copies; c++) track.append(makeSet(setList, true));

  track.style.setProperty('--shift', `${step}px`);
  track.style.setProperty('--dur', `${step / s.speed}s`);
  void track.offsetWidth; // 애니메이션 재시작
  track.style.animation = '';
}

function updateStatuses(list) {
  for (const b of list) {
    const s = LABEL[b.status] ? b.status : 'unknown';
    for (const card of track.querySelectorAll(`.card[data-id="${b.id}"]`)) {
      card.dataset.s = s;
      const badge = card.querySelector('.badge');
      badge.dataset.s = s;
      // 사이트에 적힌 문구를 그대로 보여주고, 색은 판정된 상태로. 너무 길면 판정 라벨로 대체
      const raw = (b.statusText || '').trim();
      badge.textContent = raw && raw.length <= 16 ? raw : LABEL[s];
      badge.title = b.error ? `확인 실패: ${b.error}` : b.checkedAt ? `확인: ${new Date(b.checkedAt).toLocaleString('ko-KR')}` : '';
    }
  }
}

function render(state) {
  current = state;
  const s = state.settings;
  const list = state.banners.filter((b) => b.active !== false);

  root.style.setProperty('--w', `${s.cardWidth}px`);
  root.style.setProperty('--ratio', s.ratio);
  root.style.setProperty('--cols', s.columns || 2);
  empty.hidden = list.length > 0;

  const sig = JSON.stringify([list.map((b) => [b.id, b.imageSrc, b.title, b.link]), s, window.innerWidth, window.innerHeight]);
  if (sig !== layoutSig) {
    layoutSig = sig;
    build(list, s);
  }
  updateStatuses(list);
}

// ----- 이벤트 -----
track.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) window.api.openLink(card.dataset.link);
});

document.getElementById('adminBtn').addEventListener('click', () => window.api.openAdmin());
document.getElementById('emptyAdd').addEventListener('click', () => window.api.openAdmin());
document.getElementById('fsBtn').addEventListener('click', () => window.api.setFullscreen());

window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') { e.preventDefault(); window.api.setFullscreen(); }
  else if (e.key === 'Escape') window.api.setFullscreen(false);
  else if (e.ctrlKey && e.key === ',') { e.preventDefault(); window.api.openAdmin(); }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => render(current), 200);
});

// 마우스를 안 움직이면 도구막대와 커서 숨김 (사이니지용)
let idleTimer;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
}
window.addEventListener('mousemove', wake);
wake();

window.api.onState(render);
window.api.getState().then(render);

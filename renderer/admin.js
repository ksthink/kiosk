const LABEL = { open: '접수중', upcoming: '접수예정', waiting: '대기접수', closed: '마감', unknown: '확인 전' };
const $ = (s) => document.querySelector(s);

const list = $('#list');
const dlg = $('#dlg');
const drop = $('#drop');
const urlInput = $('#url');
const err = $('#err');
const settingsForm = $('#settings');

let state = { settings: {}, banners: [] };
let editing = null; // 수정 중인 행사 id
let imagePath = null; // 새로 고른 이미지 경로
let dragging = null;

const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };

// ---------- 목록 ----------
function statusOf(b) {
  if (b.checking) return ['checking', '확인 중…'];
  if (b.error && !b.statusText) return ['error', '확인 실패']; // 한 번도 못 읽은 경우만 (읽은 적 있으면 마지막 상태 유지)
  const raw = (b.statusText || '').trim();
  return [b.status || 'unknown', raw && raw.length <= 16 ? raw : LABEL[b.status] || LABEL.unknown];
}

function renderList() {
  if (dragging) return; // 끄는 중에는 다시 그리지 않음
  const items = state.banners;
  $('#count').textContent = items.length ? items.length : '';
  $('#emptyMsg').hidden = items.length > 0;
  $('#hint').hidden = items.length < 2;
  list.replaceChildren(
    ...items.map((b, i) => {
      const [s, text] = statusOf(b);
      const li = document.createElement('li');
      li.className = 'item' + (b.active === false ? ' off' : '');
      li.draggable = true;
      li.dataset.id = b.id;
      li.title = b.error ? `확인 실패: ${b.error}` : b.link;
      li.innerHTML = `<img alt=""><span class="num"></span><div class="meta"><span class="badge"></span><span class="host"></span></div>`;
      li.querySelector('img').src = b.imageSrc;
      li.querySelector('.num').textContent = i + 1;
      const badge = li.querySelector('.badge');
      badge.dataset.s = s;
      badge.textContent = text;
      li.querySelector('.host').textContent = host(b.link);
      return li;
    }),
  );
}

function renumber() {
  list.querySelectorAll('.item .num').forEach((n, i) => (n.textContent = i + 1));
}

// 끌어서 순서 바꾸기
list.addEventListener('dragstart', (e) => {
  const li = e.target.closest('.item');
  if (!li) return;
  dragging = li;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', li.dataset.id);
});

list.addEventListener('dragover', (e) => {
  if (!dragging) return;
  e.preventDefault();
  const over = e.target.closest('.item');
  if (!over || over === dragging) return;
  const r = over.getBoundingClientRect();
  const after = e.clientX > r.left + r.width / 2;
  list.insertBefore(dragging, after ? over.nextSibling : over);
  renumber();
});

list.addEventListener('drop', (e) => e.preventDefault());

list.addEventListener('dragend', async () => {
  if (!dragging) return;
  dragging.classList.remove('dragging');
  dragging = null;
  const ids = [...list.querySelectorAll('.item')].map((li) => li.dataset.id);
  const before = state.banners.map((b) => b.id);
  if (ids.join() !== before.join()) await window.api.reorderBanners(ids);
  else renderList();
});

list.addEventListener('click', (e) => {
  const li = e.target.closest('.item');
  if (li) openDialog(state.banners.find((b) => b.id === li.dataset.id));
});

// ---------- 등록/수정 창 ----------
function setDrop(src) {
  drop.style.backgroundImage = src ? `url("${src}")` : '';
  drop.classList.toggle('has', !!src);
}

function openDialog(b) {
  editing = b ? b.id : null;
  imagePath = null;
  err.hidden = true;
  urlInput.value = b ? b.link : '';
  setDrop(b ? b.imageSrc : '');
  $('#dlgTitle').textContent = b ? '행사 수정' : '행사 등록';
  $('#okBtn').textContent = b ? '저장' : '등록';
  $('#delBtn').hidden = !b;
  dlg.showModal();
  if (b) urlInput.focus();
}

async function pick() {
  const r = await window.api.pickImage();
  if (!r) return;
  imagePath = r.path;
  setDrop(r.src);
}

drop.addEventListener('click', pick);
$('#emptyAdd').addEventListener('click', () => openDialog(null));
$('#addBtn').addEventListener('click', () => openDialog(null));
$('#cancelBtn').addEventListener('click', () => dlg.close());

// 이미지 파일을 끌어다 놓기
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  imagePath = window.api.pathForFile(file);
  setDrop(URL.createObjectURL(file));
});
// 창 아무 데나 떨어뜨려도 브라우저가 파일을 열지 않게
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  if (!editing && !imagePath) {
    err.textContent = '포스터 이미지를 넣어 주세요.';
    err.hidden = false;
    return;
  }
  const b = editing && state.banners.find((x) => x.id === editing);
  try {
    await window.api.saveBanner({
      id: editing,
      imagePath,
      link: urlInput.value,
      title: b?.title || '',
      active: b ? b.active !== false : true,
    });
    dlg.close();
  } catch (ex) {
    err.textContent = cleanErr(ex);
    err.hidden = false;
  }
});

$('#delBtn').addEventListener('click', async () => {
  if (!editing || !confirm('이 행사를 삭제할까요?')) return;
  await window.api.removeBanner(editing);
  dlg.close();
});

// ---------- 설정 ----------
function renderSettings() {
  const s = state.settings;
  if (document.activeElement?.form !== settingsForm) {
    settingsForm.slideSeconds.value = s.slideSeconds;
    settingsForm.startFullscreen.checked = !!s.startFullscreen;
    settingsForm.defaultSelector.value = s.defaultSelector || '';
  }
  $('#secOut').textContent = `${settingsForm.slideSeconds.value}초`;
}

settingsForm.addEventListener('input', () => {
  renderSettings();
  window.api.saveSettings({
    slideSeconds: settingsForm.slideSeconds.value,
    startFullscreen: settingsForm.startFullscreen.checked,
    defaultSelector: settingsForm.defaultSelector.value,
  });
});
$('#crawlAll').addEventListener('click', () => window.api.crawlNow());

// ---------- 시작 ----------
function render(s) {
  state = s;
  renderList();
  renderSettings();
}
window.api.onState(render);
window.api.getState().then(render);

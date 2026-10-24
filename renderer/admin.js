const LABEL = { open: '접수중', upcoming: '접수예정', waiting: '대기접수', closed: '마감', unknown: '확인 전', checking: '확인 중…' };
const $ = (s) => document.querySelector(s);

const form = $('#form');
const preview = $('#preview');
const testOut = $('#testOut');
const formErr = $('#formErr');
const list = $('#list');
const settingsForm = $('#settings');

let state = { settings: {}, banners: [], interval: 300000 };
let pickedImage = null;
let editingId = null;

const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ago(iso) {
  if (!iso) return '아직 확인 안 함';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? '방금 확인' : m < 60 ? `${m}분 전 확인` : `${Math.round(m / 60)}시간 전 확인`;
}

// ----- 목록 -----
function renderList() {
  $('#count').textContent = state.banners.length ? `${state.banners.length}개` : '';
  list.innerHTML = state.banners
    .map((b, i) => {
      const s = b.checking ? 'checking' : b.status || 'unknown';
      return `<li class="item ${b.active === false ? 'off' : ''}" data-id="${b.id}">
        <img src="${esc(b.imageSrc)}" alt="">
        <div class="info">
          <div class="name"><span class="badge" data-s="${s}">${LABEL[s] || LABEL.unknown}</span>${esc(b.title || '(제목 없음)')}</div>
          <div class="url">${esc(b.crawlUrl || b.link)}${b.selector ? ` · <code>${esc(b.selector)}</code>` : ''}${b.render ? ' · JS 렌더링' : ''}</div>
          ${b.statusText ? `<div class="read">읽은 글자: ${esc(b.statusText)}</div>` : ''}
          <div class="when">${ago(b.checkedAt)}</div>
          ${b.error ? `<div class="error">확인 실패: ${esc(b.error)}</div>` : ''}
        </div>
        <div class="btns">
          <button data-act="up" ${i === 0 ? 'disabled' : ''} title="앞으로">↑</button>
          <button data-act="down" ${i === state.banners.length - 1 ? 'disabled' : ''} title="뒤로">↓</button>
          <button data-act="check" ${b.checking ? 'disabled' : ''}>지금 확인</button>
          <button data-act="edit">수정</button>
          <button data-act="del">삭제</button>
        </div>
      </li>`;
    })
    .join('');
}

list.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const b = state.banners.find((x) => x.id === id);
  switch (btn.dataset.act) {
    case 'up': return window.api.moveBanner(id, -1);
    case 'down': return window.api.moveBanner(id, 1);
    case 'check': return window.api.crawlNow(id);
    case 'edit': return startEdit(b);
    case 'del':
      if (confirm(`"${b.title || '이 배너'}"를 삭제할까요?`)) {
        if (editingId === id) resetForm();
        await window.api.removeBanner(id);
      }
  }
});

// ----- 등록/수정 폼 -----
function setPreview(src) {
  preview.style.backgroundImage = src ? `url("${src}")` : '';
  preview.classList.toggle('has', !!src);
}

function resetForm() {
  form.reset();
  form.id.value = '';
  editingId = null;
  pickedImage = null;
  setPreview('');
  $('#formTitle').textContent = '새 배너';
  $('#saveBtn').textContent = '추가';
  $('#cancelBtn').hidden = true;
  testOut.hidden = true;
  formErr.hidden = true;
}

function startEdit(b) {
  resetForm();
  editingId = b.id;
  form.id.value = b.id;
  form.title.value = b.title || '';
  form.link.value = b.link || '';
  form.crawlUrl.value = b.crawlUrl || '';
  form.selector.value = b.selector || '';
  form.render.checked = !!b.render;
  form.active.checked = b.active !== false;
  form.querySelector('.adv').open = !!(b.crawlUrl || b.selector);
  setPreview(b.imageSrc);
  $('#formTitle').textContent = '배너 수정';
  $('#saveBtn').textContent = '저장';
  $('#cancelBtn').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

preview.addEventListener('click', async () => {
  const r = await window.api.pickImage();
  if (!r) return;
  pickedImage = r.path;
  setPreview(r.src);
});

$('#cancelBtn').addEventListener('click', resetForm);

$('#testBtn').addEventListener('click', async () => {
  const url = form.crawlUrl.value.trim() || form.link.value.trim();
  testOut.hidden = false;
  testOut.className = 'testout';
  testOut.textContent = '확인 중…';
  const r = await window.api.testCrawl({ crawlUrl: url, selector: form.selector.value.trim(), render: form.render.checked });
  if (r.ok) {
    testOut.textContent = `읽은 문구: ${r.text || '(비어 있음)'}\n색상 판정: ${LABEL[r.status]}${r.status === 'unknown' ? ' (키워드를 찾지 못해 회색으로 표시)' : ''}`;
  } else {
    testOut.className = 'testout bad';
    testOut.textContent = `실패: ${r.error}`;
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formErr.hidden = true;
  try {
    await window.api.saveBanner({
      id: form.id.value || null,
      imagePath: pickedImage,
      title: form.title.value,
      link: form.link.value,
      crawlUrl: form.crawlUrl.value,
      selector: form.selector.value,
      render: form.render.checked,
      active: form.active.checked,
    });
    resetForm();
  } catch (err) {
    formErr.textContent = cleanErr(err);
    formErr.hidden = false;
  }
});

// ----- 표시 설정 -----
function renderSettings() {
  const s = state.settings;
  if (document.activeElement?.form !== settingsForm) {
    settingsForm.speed.value = s.speed;
    settingsForm.cardWidth.value = s.cardWidth;
    settingsForm.ratio.value = s.ratio;
    settingsForm.defaultSelector.value = s.defaultSelector || '';
  }
  $('#speedOut').textContent = `${settingsForm.speed.value}px/초`;
  $('#widthOut').textContent = `${settingsForm.cardWidth.value}px`;
}

settingsForm.addEventListener('input', () => {
  renderSettings();
  window.api.saveSettings({
    speed: settingsForm.speed.value,
    cardWidth: settingsForm.cardWidth.value,
    ratio: settingsForm.ratio.value,
    defaultSelector: settingsForm.defaultSelector.value,
  });
});

$('#crawlAll').addEventListener('click', () => window.api.crawlNow());

function render(s) {
  state = s;
  renderList();
  renderSettings();
}

window.api.onState(render);
window.api.getState().then(render);
setInterval(renderList, 30000); // "n분 전" 갱신

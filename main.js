const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { checkBanner } = require('./crawler');

const CRAWL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SETTINGS = {
  speed: 40,
  cardWidth: 320,
  ratio: '4/3',
  direction: 'auto', // auto: 세로로 긴 화면이면 위로 흐름, 가로로 긴 화면이면 옆으로 흐름
  columns: 2, // 세로 흐름일 때 한 줄에 놓을 배너 수
  startFullscreen: true,
  // 배너별 선택자를 비워두면 이 선택자로 읽음 (영등포구립도서관 강좌 상세 페이지의 접수 상태 칸)
  defaultSelector: '#contents > div.boardWrap > table > tbody > tr:nth-child(8) > td > span',
};
const effective = (b) => ({ ...b, selector: b.selector || state.settings.defaultSelector || '' });

let dataDir, dataFile, imgDir;
let state = { settings: { ...DEFAULT_SETTINGS }, banners: [] };
let galleryWin = null;
let adminWin = null;
let crawlingAll = false;

// ---------- 저장 ----------
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    state = {
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
      banners: Array.isArray(raw.banners) ? raw.banners : [],
    };
  } catch {
    /* 첫 실행 */
  }
}

function saveState() {
  const tmp = dataFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, (k, v) => (k === 'checking' ? undefined : v), 2), 'utf8');
  fs.renameSync(tmp, dataFile);
}

const toView = (b) => ({ ...b, imageSrc: b.image ? pathToFileURL(path.join(imgDir, b.image)).href : '' });
const snapshot = () => ({ settings: state.settings, banners: state.banners.map(toView), interval: CRAWL_INTERVAL_MS });

function broadcast() {
  const snap = snapshot();
  for (const w of [galleryWin, adminWin]) if (w && !w.isDestroyed()) w.webContents.send('state:changed', snap);
}

// ---------- 크롤링 ----------
async function crawlOne(id) {
  const target = state.banners.find((b) => b.id === id);
  if (!target || target.checking) return;
  target.checking = true;
  broadcast();
  const r = await checkBanner(effective(target));
  const b = state.banners.find((x) => x.id === id);
  if (!b) return;
  delete b.checking;
  b.checkedAt = new Date().toISOString();
  if (r.ok) {
    b.status = r.status;
    b.statusText = r.text;
    b.error = null;
  } else {
    b.error = r.error; // 실패 시 마지막으로 확인된 상태는 유지
  }
  saveState();
  broadcast();
}

async function crawlAll() {
  if (crawlingAll) return;
  crawlingAll = true;
  try {
    for (const { id, active } of [...state.banners]) if (active !== false) await crawlOne(id);
  } finally {
    crawlingAll = false;
  }
}

// ---------- 창 ----------
function lockDown(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createGallery() {
  galleryWin = new BrowserWindow({
    width: 540, // 전체화면이 아닐 때는 9:16 미리보기 크기
    height: 960,
    title: '배너 갤러리',
    backgroundColor: '#111214',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  galleryWin.setMenuBarVisibility(false);
  lockDown(galleryWin);
  galleryWin.loadFile(path.join(__dirname, 'renderer', 'gallery.html'));
  galleryWin.on('closed', () => {
    galleryWin = null;
    app.quit();
  });
}

function openAdmin() {
  if (adminWin && !adminWin.isDestroyed()) return adminWin.focus();
  adminWin = new BrowserWindow({
    width: 1120,
    height: 860,
    title: '배너 관리',
    backgroundColor: '#f5f4f0',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  adminWin.setMenuBarVisibility(false);
  lockDown(adminWin);
  adminWin.loadFile(path.join(__dirname, 'renderer', 'admin.html'));
  adminWin.on('closed', () => (adminWin = null));
}

// ---------- IPC ----------
const isHttp = (u) => /^https?:\/\/\S+$/i.test(u);

ipcMain.handle('state:get', () => snapshot());

ipcMain.handle('banner:save', (_e, input) => {
  let b = input.id ? state.banners.find((x) => x.id === input.id) : null;
  const isNew = !b;
  if (isNew && !input.imagePath) throw new Error('배너 이미지를 선택하세요.');

  const link = String(input.link || '').trim();
  const crawlUrl = String(input.crawlUrl || '').trim();
  if (!isHttp(link)) throw new Error('링크 URL은 http:// 또는 https:// 로 시작해야 합니다.');
  if (crawlUrl && !isHttp(crawlUrl)) throw new Error('상태 확인 URL이 올바르지 않습니다.');

  if (isNew) b = { id: crypto.randomUUID(), status: 'unknown', createdAt: new Date().toISOString() };

  if (input.imagePath) {
    const ext = (path.extname(input.imagePath) || '.png').toLowerCase();
    const name = `${b.id}-${Date.now()}${ext}`;
    fs.copyFileSync(input.imagePath, path.join(imgDir, name));
    if (b.image) fs.rmSync(path.join(imgDir, b.image), { force: true });
    b.image = name;
  }

  const urlChanged = !isNew && (b.link !== link || b.crawlUrl !== crawlUrl || b.selector !== input.selector || b.render !== !!input.render);
  Object.assign(b, {
    title: String(input.title || '').trim(),
    link,
    crawlUrl,
    selector: String(input.selector || '').trim(),
    render: !!input.render,
    active: input.active !== false,
  });
  if (isNew) state.banners.push(b);
  saveState();
  broadcast();
  if (isNew || urlChanged) crawlOne(b.id);
  return toView(b);
});

ipcMain.handle('banner:remove', (_e, id) => {
  const i = state.banners.findIndex((b) => b.id === id);
  if (i < 0) return;
  const [b] = state.banners.splice(i, 1);
  if (b.image) fs.rmSync(path.join(imgDir, b.image), { force: true });
  saveState();
  broadcast();
});

ipcMain.handle('banner:move', (_e, id, delta) => {
  const i = state.banners.findIndex((b) => b.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.banners.length) return;
  [state.banners[i], state.banners[j]] = [state.banners[j], state.banners[i]];
  saveState();
  broadcast();
});

let recrawlTimer;
ipcMain.handle('settings:save', (_e, s) => {
  const prevSelector = state.settings.defaultSelector;
  const n = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  state.settings = {
    speed: n(s.speed, 5, 400, DEFAULT_SETTINGS.speed),
    cardWidth: n(s.cardWidth, 120, 1200, DEFAULT_SETTINGS.cardWidth),
    ratio: ['16/9', '4/3', '1/1', '3/4', '1/1.414'].includes(s.ratio) ? s.ratio : DEFAULT_SETTINGS.ratio,
    direction: ['auto', 'horizontal', 'vertical'].includes(s.direction) ? s.direction : DEFAULT_SETTINGS.direction,
    columns: Math.round(n(s.columns, 1, 4, DEFAULT_SETTINGS.columns)),
    startFullscreen: s.startFullscreen !== undefined ? !!s.startFullscreen : state.settings.startFullscreen,
    defaultSelector: typeof s.defaultSelector === 'string' ? s.defaultSelector.trim() : state.settings.defaultSelector,
  };
  const selectorChanged = state.settings.defaultSelector !== prevSelector;
  saveState();
  broadcast();
  if (selectorChanged) {
    clearTimeout(recrawlTimer);
    recrawlTimer = setTimeout(crawlAll, 1500); // 기본 선택자를 바꾸면 잠시 뒤 전체 다시 확인
  }
});

ipcMain.handle('crawl:now', (_e, id) => (id ? crawlOne(id) : crawlAll()));
ipcMain.handle('crawl:test', (_e, input) => checkBanner(effective(input)));

ipcMain.handle('image:pick', async () => {
  const r = await dialog.showOpenDialog(adminWin || galleryWin, {
    title: '배너 이미지 선택',
    properties: ['openFile'],
    filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], src: pathToFileURL(r.filePaths[0]).href };
});

ipcMain.on('link:open', (_e, url) => {
  if (isHttp(url)) shell.openExternal(url);
});
ipcMain.on('admin:open', () => openAdmin());
ipcMain.on('gallery:fullscreen', (_e, value) => {
  if (!galleryWin) return;
  galleryWin.setFullScreen(typeof value === 'boolean' ? value : !galleryWin.isFullScreen());
});

// ---------- 시작 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (galleryWin) {
      if (galleryWin.isMinimized()) galleryWin.restore();
      galleryWin.focus();
    }
  });

  app.whenReady().then(() => {
    // exe 옆 폴더에 저장 → 폴더째 다른 PC로 옮기기 쉬움 (쓰기 권한이 없으면 AppData로)
    const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(process.execPath) : null);
    let base = app.getPath('userData');
    if (exeDir) {
      try {
        fs.accessSync(exeDir, fs.constants.W_OK);
        base = exeDir;
      } catch {}
    }
    dataDir = path.join(base, 'banner-data');
    imgDir = path.join(dataDir, 'images');
    dataFile = path.join(dataDir, 'banners.json');
    fs.mkdirSync(imgDir, { recursive: true });
    loadState();

    createGallery();
    if (state.settings.startFullscreen) galleryWin.setFullScreen(true);
    if (!state.banners.length) openAdmin();

    crawlAll();
    setInterval(crawlAll, CRAWL_INTERVAL_MS);
  });

  app.on('window-all-closed', () => app.quit());
}

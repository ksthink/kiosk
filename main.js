const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { checkBanner } = require('./crawler');

const CRAWL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SETTINGS = {
  slideSeconds: 8, // 포스터 한 장을 보여주는 시간
  startFullscreen: true,
  // 행사 페이지에서 상태 문구를 읽을 위치 (영등포구립도서관 강좌 상세의 접수 상태 칸)
  defaultSelector: '#contents > div.boardWrap > table > tbody > tr:nth-child(8) > td > span',
};

let dataDir, dataFile, imgDir;
let state = { settings: { ...DEFAULT_SETTINGS }, banners: [] };
let galleryWin = null;
let adminWin = null;
let crawlingAll = false;

// 포스터 이미지는 banner:// 로 제공 → 갤러리가 캔버스로 가장자리 색을 읽을 수 있음(CORS 허용)
protocol.registerSchemesAsPrivileged([
  { scheme: 'banner', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

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

const toView = (b) => ({ ...b, imageSrc: b.image ? `banner://img/${encodeURIComponent(b.image)}` : '' });
const snapshot = () => ({ settings: state.settings, banners: state.banners.map(toView) });
const effective = (b) => ({ ...b, selector: b.selector || state.settings.defaultSelector || '' });

function broadcast() {
  const snap = snapshot();
  for (const w of [galleryWin, adminWin]) if (w && !w.isDestroyed()) w.webContents.send('state:changed', snap);
}

// ---------- 상태 확인 ----------
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
    b.error = r.error; // 실패하면 마지막으로 읽은 상태를 그대로 둠
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
    backgroundColor: '#0e0e10',
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
    width: 980,
    height: 820,
    title: '행사 관리',
    backgroundColor: '#f4f3ef',
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
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

ipcMain.handle('state:get', () => snapshot());

ipcMain.handle('banner:save', (_e, input) => {
  let b = input.id ? state.banners.find((x) => x.id === input.id) : null;
  const isNew = !b;
  if (isNew && !input.imagePath) throw new Error('포스터 이미지를 넣어 주세요.');

  const link = String(input.link || '').trim();
  if (!isHttp(link)) throw new Error('주소는 http:// 또는 https:// 로 시작해야 해요.');

  if (isNew) b = { id: crypto.randomUUID(), status: 'unknown', createdAt: new Date().toISOString() };

  if (input.imagePath) {
    const ext = (path.extname(input.imagePath) || '.png').toLowerCase();
    if (!IMAGE_EXT.includes(ext)) throw new Error('이미지 파일(png, jpg, webp 등)만 넣을 수 있어요.');
    const name = `${b.id}-${Date.now()}${ext}`;
    fs.copyFileSync(input.imagePath, path.join(imgDir, name));
    if (b.image) fs.rmSync(path.join(imgDir, b.image), { force: true });
    b.image = name;
  }

  const linkChanged = b.link !== link;
  b.link = link;
  if (input.title !== undefined) b.title = String(input.title || '').trim();
  if (input.active !== undefined) b.active = input.active !== false;
  if (isNew) state.banners.push(b);
  if (linkChanged) {
    b.status = 'unknown';
    b.statusText = '';
    b.error = null;
  }
  saveState();
  broadcast();
  if (linkChanged) crawlOne(b.id);
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

ipcMain.handle('banner:reorder', (_e, ids) => {
  const byId = new Map(state.banners.map((b) => [b.id, b]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const rest = state.banners.filter((b) => !ids.includes(b.id));
  state.banners = [...ordered, ...rest];
  saveState();
  broadcast();
});

let recrawlTimer;
ipcMain.handle('settings:save', (_e, s) => {
  const prevSelector = state.settings.defaultSelector;
  const sec = Number(s.slideSeconds);
  state.settings = {
    ...state.settings,
    slideSeconds: Number.isFinite(sec) ? Math.min(60, Math.max(2, Math.round(sec))) : state.settings.slideSeconds,
    startFullscreen: s.startFullscreen !== undefined ? !!s.startFullscreen : state.settings.startFullscreen,
    defaultSelector: typeof s.defaultSelector === 'string' ? s.defaultSelector.trim() : state.settings.defaultSelector,
  };
  saveState();
  broadcast();
  if (state.settings.defaultSelector !== prevSelector) {
    clearTimeout(recrawlTimer);
    recrawlTimer = setTimeout(crawlAll, 1500); // 읽는 위치를 바꾸면 잠시 뒤 전체 다시 확인
  }
});

ipcMain.handle('crawl:now', (_e, id) => (id ? crawlOne(id) : crawlAll()));
ipcMain.handle('crawl:test', (_e, input) => checkBanner(effective(input)));

ipcMain.handle('image:pick', async () => {
  const r = await dialog.showOpenDialog(adminWin || galleryWin, {
    title: '포스터 이미지 선택',
    properties: ['openFile'],
    filters: [{ name: '이미지', extensions: IMAGE_EXT.map((e) => e.slice(1)) }],
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
    // exe 옆 banner-data 폴더에 저장 → 폴더째 다른 PC로 옮기기 쉬움 (쓰기 불가면 AppData)
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

    protocol.handle('banner', async (req) => {
      const name = path.basename(decodeURIComponent(new URL(req.url).pathname));
      const res = await net.fetch(pathToFileURL(path.join(imgDir, name)).href);
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(res.body, { status: res.status, headers });
    });

    createGallery();
    if (state.settings.startFullscreen) galleryWin.setFullScreen(true);
    if (!state.banners.length) openAdmin();

    crawlAll();
    setInterval(crawlAll, CRAWL_INTERVAL_MS);
  });

  app.on('window-all-closed', () => app.quit());
}

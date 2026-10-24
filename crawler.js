// 사이트에서 상태 텍스트를 읽어 접수중/예정/대기/마감으로 판정
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 텍스트에서 가장 먼저 등장하는 키워드의 상태를 채택
// (예: "대기접수중" → 대기, "마감임박" → 접수중)
const RULES = {
  closed: [/접수\s*마감/, /신청\s*마감/, /모집\s*마감/, /마감(?!\s*임박)/, /종료/, /매진/],
  waiting: [/대기/],
  upcoming: [/예정/, /준비\s*중/, /오픈\s*전/, /접수\s*전/],
  open: [/접수\s*중/, /신청\s*중/, /모집\s*중/, /신청\s*가능/, /접수\s*가능/, /예약\s*가능/, /진행\s*중/, /마감\s*임박/],
};

function classify(text) {
  let best = { status: 'unknown', index: Infinity };
  for (const [status, patterns] of Object.entries(RULES)) {
    for (const re of patterns) {
      const m = re.exec(text);
      if (m && m.index < best.index) best = { status, index: m.index };
    }
  }
  return best.status;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // 공공기관 사이트에 흔한 EUC-KR 처리
  let cs = (res.headers.get('content-type') || '').match(/charset=["']?([\w-]+)/i)?.[1];
  if (!cs) cs = buf.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  cs = (cs || 'utf-8').toLowerCase();
  if (cs === 'ks_c_5601-1987' || cs === 'euc_kr' || cs === 'ksc5601') cs = 'euc-kr';
  return iconv.encodingExists(cs) ? iconv.decode(buf, cs) : buf.toString('utf8');
}

function extract(html, selector) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  if (selector) {
    const el = $(selector).first();
    if (!el.length) throw new Error('선택자에 해당하는 요소가 없습니다 (JS 렌더링 옵션을 켜 보세요)');
    return clean(el.text());
  }
  return clean($('body').text());
}

// 자바스크립트로 그려지는 페이지: 숨겨진 창에서 실제로 렌더링한 뒤 읽기
async function renderText(url, selector) {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { images: false, sandbox: true, contextIsolation: true },
  });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('렌더링 시간 초과')), 30000));
  try {
    const run = (async () => {
      await win.loadURL(url, { userAgent: UA }).catch((e) => {
        // 리다이렉트 등으로 생기는 ERR_ABORTED는 무시하고 진행
        if (!/ERR_ABORTED/.test(String(e))) throw e;
      });
      const js = `new Promise((resolve) => {
        const sel = ${JSON.stringify(selector || '')};
        const t0 = Date.now();
        (function tick() {
          const el = sel ? document.querySelector(sel) : document.body;
          const txt = el && el.innerText ? el.innerText.trim() : '';
          if (txt) resolve(txt);
          else if (Date.now() - t0 > 12000) resolve(null);
          else setTimeout(tick, 400);
        })();
      })`;
      const text = await win.webContents.executeJavaScript(js, true);
      if (text == null) throw new Error(selector ? '렌더링 후에도 선택자 요소를 찾지 못했습니다' : '본문이 비어 있습니다');
      return clean(text);
    })();
    return await Promise.race([run, timeout]);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function checkBanner(b) {
  const url = (b.crawlUrl || b.link || '').trim();
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('확인할 URL이 올바르지 않습니다');
    const text = b.render ? await renderText(url, b.selector) : extract(await fetchHtml(url), b.selector);
    return { ok: true, status: classify(text), text: text.slice(0, 300) };
  } catch (e) {
    const msg = e?.name === 'TimeoutError' ? '응답 시간 초과' : e?.cause?.code || e?.message || String(e);
    return { ok: false, error: msg };
  }
}

module.exports = { checkBanner, classify, extract };

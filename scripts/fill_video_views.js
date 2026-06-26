const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const FANPAGES = [
  { name: 'SunLife Vietnam',       url: 'https://www.facebook.com/SunLifeVietnam' },
  { name: 'Chubb Life Vietnam',    url: 'https://www.facebook.com/BaohiemChubbLifeVietnam' },
  { name: 'FWD Vietnam',           url: 'https://www.facebook.com/BaohiemFWDVietnam' },
  { name: 'Dai-ichi Life Vietnam', url: 'https://www.facebook.com/DaiichiLife.Vietnam' },
  { name: 'AIA Vietnam',           url: 'https://www.facebook.com/AIAVietnamLifeInsurance' },
  { name: 'Bảo Việt Nhân Thọ',    url: 'https://www.facebook.com/www.BaoVietNhanTho.com.vn' },
  { name: 'Prudential Vietnam',    url: 'https://www.facebook.com/Prudential.pva' },
  { name: 'Manulife Vietnam',      url: 'https://www.facebook.com/ManulifeVietnam' },
  { name: 'Generali Vietnam',      url: 'https://www.facebook.com/GeneraliVietnam' },
];

const DATA_DIR = process.env.DATA_DIR || 'data';
const SESSION_FILE = process.env.SESSION_FILE || 'session.json';
const MAX_REEL_SCROLLS = Number(process.env.MAX_REEL_SCROLLS || 80);
const STALE_SCROLL_LIMIT = Number(process.env.STALE_SCROLL_LIMIT || 8);
const PAGE_CONCURRENCY = Number(process.env.VIEW_PAGE_CONCURRENCY || 2);
const DETAIL_CONCURRENCY = Number(process.env.VIEW_DETAIL_CONCURRENCY || 4);
const PAGE_TIMEOUT = Number(process.env.PAGE_TIMEOUT || 30000);
const FANPAGE_FILTER = (process.env.FANPAGE_FILTER || '').trim().toLowerCase();

function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_');
}

function toReelsUrl(pageUrl) {
  const url = new URL(pageUrl);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') + '/reels/';
  return url.toString();
}

function normalizeFacebookVideoUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl, 'https://www.facebook.com');
    parsed.hostname = 'www.facebook.com';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');

    const reelMatch = parsed.pathname.match(/\/reels?\/(\d+)/i);
    if (reelMatch) {
      parsed.pathname = `/reel/${reelMatch[1]}`;
      return parsed.toString();
    }

    const videoMatch = parsed.pathname.match(/^\/([^/]+)\/videos\/(?:[^/]+\/)*(\d+)$/i);
    if (videoMatch) {
      parsed.pathname = `/${videoMatch[1]}/videos/${videoMatch[2]}`;
      return parsed.toString();
    }

    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function extractVideoIdFromUrl(url) {
  if (!url) return '';
  const reelMatch = String(url).match(/\/reels?\/(\d+)/i);
  if (reelMatch) return reelMatch[1];

  const videoMatch = String(url).match(/\/videos\/(?:[^/?#]+\/)*(\d+)(?:[/?#]|$)/i);
  if (videoMatch) return videoMatch[1];

  return '';
}

function parseCount(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  const million = s.match(/^([\d.,]+)\s*(m|tri[eệ]u)/);
  if (million) {
    const n = parseFloat(million[1].replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 1_000_000) : null;
  }

  const thousand = s.match(/^([\d.,]+)\s*(k|ngh[iì]n|ngàn)/);
  if (thousand) {
    const n = parseFloat(thousand[1].replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 1_000) : null;
  }

  const billion = s.match(/^([\d.,]+)\s*b/);
  if (billion) {
    const n = parseFloat(billion[1].replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 1_000_000_000) : null;
  }

  const clean = s.replace(/\s/g, '');
  if (!/^[\d.,]+$/.test(clean)) return null;

  const dots = (clean.match(/\./g) || []).length;
  const commas = (clean.match(/,/g) || []).length;

  if (dots > 0 && commas > 0) {
    const lastDot = clean.lastIndexOf('.');
    const lastComma = clean.lastIndexOf(',');
    const normalized = lastComma > lastDot
      ? clean.replace(/\./g, '').replace(',', '.')
      : clean.replace(/,/g, '');
    const n = parseFloat(normalized);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  if (dots === 1 && commas === 0) {
    const afterDot = clean.split('.')[1];
    return afterDot.length === 3
      ? parseInt(clean.replace(/\./g, ''), 10)
      : Math.round(parseFloat(clean));
  }

  if (commas === 1 && dots === 0) {
    const afterComma = clean.split(',')[1];
    return afterComma.length === 3
      ? parseInt(clean.replace(/,/g, ''), 10)
      : Math.round(parseFloat(clean.replace(',', '.')));
  }

  const n = parseInt(clean.replace(/[.,]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parseInlineViewText(text) {
  if (!text) return null;
  const viewKeywords = /lượt xem|lượt\s*phát|lượt\s*play|views?|plays?/i;
  if (!viewKeywords.test(text) && !/^\d[\d.,]*\s*(k|m|b|triệu|nghìn|ngàn)?$/i.test(text.trim())) {
    return null;
  }

  const matches = [...String(text).matchAll(/[\d.,]+\s*(?:[KkMmBb]|triệu|nghìn|ngàn)?\b/g)];
  for (const match of matches) {
    const raw = match[0].trim();
    const parsed = parseCount(raw);
    if (parsed == null) continue;
    if (/^\d{4}$/.test(raw) && parsed >= 1900 && parsed <= 2100) continue;
    if (parsed >= 100 && parsed <= 500_000_000) return parsed;
  }

  return null;
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function readCsv(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  const header = rows.shift() || [];
  const records = rows
    .filter(row => row.some(cell => String(cell || '').trim()))
    .map(row => Object.fromEntries(header.map((key, i) => [key, row[i] || ''])));
  return { header, records };
}

function writeCsv(filePath, header, records) {
  const lines = [
    header.map(csvEscape).join(','),
    ...records.map(record => header.map(key => csvEscape(record[key] || '')).join(',')),
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

async function collectReelCards(page) {
  return page.evaluate(() => {
    const parseInlineCount = (txt = '') => {
      const m = txt.trim().match(/^([\d.,]+)\s*(k|m|b|triệu|nghìn|ngàn)?(?:\s*(?:lượt xem|views?|plays?))?$/i);
      if (!m) return null;
      let n = Number.parseFloat(m[1].replace(/\./g, '').replace(/,/g, '.'));
      if (Number.isNaN(n)) return null;
      const suffix = (m[2] || '').toLowerCase();
      if (suffix === 'k' || suffix === 'nghìn' || suffix === 'ngàn') n *= 1e3;
      if (suffix === 'm' || suffix === 'triệu') n *= 1e6;
      if (suffix === 'b') n *= 1e9;
      return Math.round(n);
    };

    const isVideoHref = href => /(\/reels?\/\d+|\/videos\/(?:[^/?#]+\/)*\d+)/.test(href || '');

    const findCard = (anchor) => {
      let card = anchor;
      let best = anchor;
      for (let i = 0; i < 10 && card.parentElement; i++) {
        card = card.parentElement;
        const rect = card.getBoundingClientRect();
        const text = card.innerText || '';
        if (rect.width > 100 && rect.width < 900 && rect.height > 80) best = card;
        if (isVideoHref(text) || text.length > 1200) break;
      }
      return best;
    };

    const rows = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!isVideoHref(href)) return;

      let abs;
      try {
        abs = new URL(href, 'https://www.facebook.com').toString();
      } catch {
        return;
      }

      const container = findCard(a);
      const candidates = [];
      const textElements = container?.querySelectorAll('span, div') || [];
      textElements.forEach(el => {
        if (el.children.length > 0) return;
        const raw = el.textContent?.trim() || '';
        if (!/^\d[\d.,]*\s*(k|m|b|triệu|nghìn|ngàn)?(?:\s*(?:lượt xem|views?|plays?))?$/i.test(raw)) return;
        const views = parseInlineCount(raw);
        if (views == null || views < 100) return;
        const className = typeof el.className === 'string' && el.className.trim()
          ? el.className
          : '(no-class)';
        const hasViewKeyword = /lượt xem|views?|plays?/i.test(raw);
        candidates.push({ views, raw, className, hasViewKeyword });
      });

      rows.push({ reel_url: abs, candidates });
    });

    const classFreq = new Map();
    rows.forEach(row => {
      row.candidates.forEach(candidate => {
        classFreq.set(candidate.className, (classFreq.get(candidate.className) || 0) + 1);
      });
    });

    let viewClass = null;
    let maxCount = 0;
    classFreq.forEach((count, className) => {
      if (count > maxCount) {
        maxCount = count;
        viewClass = className;
      }
    });

    return rows.map(row => {
      const keywordCandidate = row.candidates.find(candidate => candidate.hasViewKeyword);
      const classCandidate = row.candidates.find(candidate => candidate.className === viewClass);
      const chosen = keywordCandidate || classCandidate || [...row.candidates].sort((a, b) => b.views - a.views)[0] || null;
      return {
        reel_url: row.reel_url,
        raw_views: chosen?.raw || '',
        views: chosen?.views || null,
      };
    });
  });
}

async function extractViewsFromDetailPage(page) {
  const candidates = await page.evaluate(() => {
    const results = [];
    const keyword = /lượt xem|lượt\s*phát|lượt\s*play|views?|plays?/i;

    function pushText(text) {
      const value = String(text || '').trim();
      if (!value || value.length > 250) return;
      if (keyword.test(value)) results.push(value);
    }

    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) pushText(node.textContent);
      for (const child of node.childNodes || []) walk(child);
    }

    const areas = [
      ...document.querySelectorAll('video'),
      ...document.querySelectorAll('[role="main"]'),
      ...document.querySelectorAll('[data-pagelet]'),
      document.body,
    ];

    const walked = new Set();
    for (const area of areas) {
      if (!area || walked.has(area)) continue;
      walked.add(area);
      walk(area);
      if (results.length > 0) break;
    }

    document.querySelectorAll('[aria-label], [title]').forEach(el => {
      pushText(el.getAttribute('aria-label'));
      pushText(el.getAttribute('title'));
    });

    return [...new Set(results)];
  });

  for (const text of candidates) {
    const parsed = parseInlineViewText(text);
    if (parsed != null) return parsed;
  }
  return null;
}

async function fetchDetailViews(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForSelector('video', { timeout: 3000 }).catch(() => {});
    return await extractViewsFromDetailPage(page);
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function crawlPageReels(context, fanpage, wantedIds) {
  const page = await context.newPage();
  const found = new Map();
  const reelsUrl = toReelsUrl(fanpage.url);
  let staleCount = 0;

  try {
    console.log(`\n🎞️  ${fanpage.name}`);
    console.log(`   ${reelsUrl}`);
    await page.goto(reelsUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForTimeout(3000);

    for (let scroll = 1; scroll <= MAX_REEL_SCROLLS && staleCount < STALE_SCROLL_LIMIT; scroll++) {
      const before = found.size;
      const cards = await collectReelCards(page);

      for (const card of cards) {
        const normalizedUrl = normalizeFacebookVideoUrl(card.reel_url);
        const id = extractVideoIdFromUrl(normalizedUrl);
        if (!id || !wantedIds.has(id)) continue;
        if (!found.has(id)) {
          const views = card.views != null ? card.views : null;
          found.set(id, { id, url: normalizedUrl, views });
        }
      }

      const missing = [...wantedIds].filter(id => !found.has(id) || found.get(id).views == null);
      if (missing.length === 0) break;

      const added = found.size - before;
      staleCount = added === 0 ? staleCount + 1 : 0;
      if (scroll % 5 === 0 || added > 0) {
        console.log(`   scroll ${scroll}: matched ${found.size}/${wantedIds.size}`);
      }

      await page.mouse.wheel(0, 1200).catch(() => {});
      await page.waitForTimeout(500);
      await page.mouse.wheel(0, 1200).catch(() => {});
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
  } finally {
    await page.close().catch(() => {});
  }

  const detailTargets = [...found.values()].filter(item => item.views == null);
  if (detailTargets.length) {
    console.log(`   detail fallback: ${detailTargets.length} reel/video`);
    await runWithConcurrency(detailTargets, DETAIL_CONCURRENCY, async (item) => {
      const views = await fetchDetailViews(context, item.url);
      if (views != null) item.views = views;
      return item;
    });
  }

  return found;
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const results = new Array(items.length);
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

function collectWantedIds(records) {
  const ids = new Set();
  for (const record of records) {
    const id = extractVideoIdFromUrl(record.post_url);
    if (id) ids.add(id);
  }
  return ids;
}

async function updateFanpageCsv(context, fanpage) {
  const filePath = path.join(DATA_DIR, `${sanitizeFilename(fanpage.name)}.csv`);
  if (!fs.existsSync(filePath)) return { matched: 0, updated: 0 };

  const { header, records } = readCsv(filePath);
  if (!header.includes('video_view')) header.push('video_view');

  const wantedIds = collectWantedIds(records);
  if (!wantedIds.size) {
    console.log(`\n${fanpage.name}: không có reel/video URL trong CSV`);
    writeCsv(filePath, header, records);
    return { matched: 0, updated: 0 };
  }

  const viewsById = await crawlPageReels(context, fanpage, wantedIds);
  let updated = 0;

  for (const record of records) {
    const id = extractVideoIdFromUrl(record.post_url);
    if (!id) continue;
    const item = viewsById.get(id);
    if (!item || item.views == null) continue;
    record.video_view = String(item.views);
    updated++;
  }

  writeCsv(filePath, header, records);
  console.log(`   wrote ${updated}/${wantedIds.size} video_view values`);
  return { matched: wantedIds.size, updated };
}

async function main() {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Missing ${SESSION_FILE}. Run npm start/login flow first.`);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    storageState: SESSION_FILE,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'vi-VN',
  });

  let totalMatched = 0;
  let totalUpdated = 0;

  try {
    const fanpages = FANPAGE_FILTER
      ? FANPAGES.filter(fanpage => (
        fanpage.name.toLowerCase().includes(FANPAGE_FILTER)
        || fanpage.url.toLowerCase().includes(FANPAGE_FILTER)
      ))
      : FANPAGES;

    if (!fanpages.length) {
      throw new Error(`No fanpage matched FANPAGE_FILTER="${process.env.FANPAGE_FILTER}"`);
    }

    if (FANPAGE_FILTER) {
      console.log(`Filtering fanpages by: ${process.env.FANPAGE_FILTER}`);
    }

    const results = await runWithConcurrency(fanpages, PAGE_CONCURRENCY, fanpage => updateFanpageCsv(context, fanpage));
    for (const result of results) {
      totalMatched += result.matched;
      totalUpdated += result.updated;
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log(`\n✅ Done. Updated ${totalUpdated}/${totalMatched} video_view values by reel/video ID.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

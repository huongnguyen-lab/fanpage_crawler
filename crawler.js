const { chromium } = require('playwright');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');

// ============================================================
// CONFIG — FANPAGES
// ============================================================
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

// ============================================================
// DATE RANGE — chỉnh tại đây
// Format: 'YYYY-MM-DD' | null = không giới hạn
// ============================================================
const DATE_FROM = '2026-06-01';
const DATE_TO   = '2026-06-26';

// ============================================================
// FILES
// ============================================================
const DATA_DIR        = 'data'; // mỗi fanpage 1 file CSV trong đây
const SESSION_FILE    = 'session.json';
const INITIAL_FEED_WAIT_MS = 2500;
const INITIAL_FEED_PARSE_RETRIES = 4;
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY || 2);
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 30);
const SCROLL_WAIT_MIN_MS = Number(process.env.SCROLL_WAIT_MIN_MS || 1200);
const SCROLL_WAIT_MAX_MS = Number(process.env.SCROLL_WAIT_MAX_MS || 2200);
const BLOCK_HEAVY_RESOURCES = process.env.BLOCK_HEAVY_RESOURCES !== '0';

function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_');
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// ============================================================
// DEBUG DUMP — tạm thời để điều tra vì sao thiếu like/comment/share
// Ghi vài response GraphQL thô ra ./debug để soi cấu trúc thật.
// Tắt (false) sau khi xong điều tra.
// ============================================================
const DEBUG_DUMP = false;
const DEBUG_DIR = 'debug';
const MAX_DEBUG_DUMPS = 40;
let debugDumpCount = 0;

// ============================================================
// SAFE DEEP GET
// ============================================================
function get(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

// ============================================================
// EXTRACT CONTENT — tries every known path
// ============================================================
function extractContent(node) {
  const candidates = [
    get(node, 'message', 'text'),
    get(node, 'comet_sections', 'content', 'story', 'comet_sections', 'message_container', 'story', 'message', 'text'),
    get(node, 'comet_sections', 'content', 'story', 'comet_sections', 'message', 'story', 'message', 'text'),
    get(node, 'seo_title'),
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return '';
}

// ============================================================
// EXTRACT CREATION TIME
// ============================================================
function extractCreationTime(node) {
  const t1 = get(node, 'comet_sections', 'context_layout', 'story', 'comet_sections', 'metadata', 0, 'story', 'creation_time');
  if (t1) return t1;

  const t2 = get(node, 'comet_sections', 'timestamp', 'story', 'creation_time');
  if (t2) return t2;

  try {
    if (node.tracking) {
      const t = JSON.parse(node.tracking);
      const insights = t?.page_insights;
      if (insights) {
        const pt = Object.values(insights)[0]?.post_context?.publish_time;
        if (pt) return pt;
      }
    }
  } catch {}

  return null;
}

// ============================================================
// EXTRACT FEEDBACK — reaction/share/comment counts
//
// Thực tế (verified từ debug dump 24/06): các số liệu này KHÔNG nằm trực
// tiếp trong object feedback, mà rải trong từng phần tử của
// `adaptive_ufi_action_renderers[]` (mỗi phần tử ứng với 1 nút Like/
// Comment/Share ở UFI bar, mỗi phần tử có `feedback` riêng chỉ chứa đúng
// 1 loại số liệu). Duyệt cả mảng và gom lại, không giả định thứ tự index.
// ============================================================
function extractFeedback(node) {
  const ctx = get(node,
    'comet_sections', 'feedback', 'story',
    'story_ufi_container', 'story',
    'feedback_context', 'feedback_target_with_context');
  if (!ctx) return { reactionCount: 0, shareCount: 0, commentCount: 0 };

  const renderers = get(ctx, 'comet_ufi_summary_and_actions_renderer', 'feedback', 'adaptive_ufi_action_renderers') || [];

  let reactionCount = 0, shareCount = 0, commentCount = 0;
  for (const r of renderers) {
    const fb = r?.feedback;
    if (!fb) continue;
    if (fb.reaction_count?.count != null) reactionCount = fb.reaction_count.count;
    if (fb.share_count?.count != null) shareCount = fb.share_count.count;
    if (fb.comment_rendering_instance?.comments?.total_count != null) {
      commentCount = fb.comment_rendering_instance.comments.total_count;
    }
  }

  // Fallback: comment count cũng có path trực tiếp ở feedback_target_with_context
  if (!commentCount) {
    commentCount = get(ctx, 'comment_rendering_instance', 'comments', 'total_count') ?? 0;
  }

  return { reactionCount, shareCount, commentCount };
}

// ============================================================
// EXTRACT IMAGE URLs
// ============================================================
function isLikelyFacebookImageUrl(value) {
  if (typeof value !== 'string') return false;
  if (!/^https?:\/\//.test(value)) return false;

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const isFacebookCdn =
      host.includes('fbcdn.net') ||
      host.includes('fbsbx.com') ||
      host.includes('facebook.com');
    const looksLikeImage =
      path.includes('/v/t') ||
      path.includes('/safe_image.php') ||
      /\.(jpg|jpeg|png|webp|gif)(\?|$)/.test(path);
    return isFacebookCdn && looksLikeImage;
  } catch {
    return false;
  }
}

function shouldSkipImagePath(path) {
  return path.some(key =>
    /actor|avatar|badge|icon|profile|reaction|sprout|sticker|ufi/i.test(String(key))
  );
}

function collectImageUrls(obj, urls, path = [], depth = 0) {
  if (depth > 50 || obj == null) return;

  if (typeof obj === 'string') {
    if (!shouldSkipImagePath(path) && isLikelyFacebookImageUrl(obj)) {
      urls.add(obj);
    }
    return;
  }

  if (typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      collectImageUrls(obj[i], urls, path.concat(i), depth + 1);
    }
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    collectImageUrls(value, urls, path.concat(key), depth + 1);
  }
}

function extractImageUrls(node) {
  const urls = new Set();
  for (const att of (node.attachments || [])) {
    const uri = get(att, 'styles', 'attachment', 'media', 'photo_image', 'uri');
    if (uri) urls.add(uri);
    for (const sub of (get(att, 'all_subattachments', 'nodes') || [])) {
      const subUri = get(sub, 'media', 'photo_image', 'uri');
      if (subUri) urls.add(subUri);
    }
  }
  collectImageUrls(node.attachments || [], urls, ['attachments']);
  collectImageUrls(get(node, 'comet_sections', 'content') || {}, urls, ['comet_sections', 'content']);
  collectImageUrls(node.attached_story || {}, urls, ['attached_story']);
  return [...urls];
}

// ============================================================
// EXTRACT VIDEO URL
// ============================================================
function extractVideoUrl(node) {
  for (const att of (node.attachments || [])) {
    const media = get(att, 'styles', 'attachment', 'media');
    if (media?.__typename === 'Video') {
      return media.playable_url || media.browser_native_hd_url || media.url || '';
    }
  }
  return '';
}

// ============================================================
// SCORE A NODE — higher = more complete data
// Used to pick best version when same post_id appears multiple times
// ============================================================
function scoreNode(node) {
  let score = 0;
  if (node.comet_sections) score += 10;   // has full structure
  if (extractContent(node))  score += 5;   // has text
  const fb = extractFeedback(node);
  score += fb.reactionCount > 0 ? 3 : 0;
  score += fb.shareCount    > 0 ? 2 : 0;
  score += fb.commentCount  > 0 ? 2 : 0;
  score += Math.min(extractImageUrls(node).length, 5);
  if (extractVideoUrl(node)) score += 2;
  if (extractCreationTime(node)) score += 3;
  return score;
}

// ============================================================
// PARSE ONE STORY NODE → post object
// ============================================================
function parseStoryNode(node, pageName, pageUrl) {
  if (!node || node.__typename !== 'Story') return null;
  const postId = node.post_id;
  if (!postId) return null;

  const content = extractContent(node);
  const creationTime = extractCreationTime(node);
  const postDate = creationTime
    ? new Date(creationTime * 1000).toISOString().split('T')[0]
    : '';

  const actor = get(node, 'actors', 0);
  const resolvedName = actor?.name || pageName;
  const resolvedUrl  = actor?.url  || pageUrl;

  const fb = extractFeedback(node);
  const reactions = fb.reactionCount;
  const comments  = fb.commentCount;
  const shares    = fb.shareCount;

  return {
    post_date:    postDate,
    content:      content.replace(/\r?\n/g, ' '),
    fanpage_name: resolvedName,
    reaction:     reactions,
    share:        shares,
    comment:      comments,
    fanpage_url:  resolvedUrl,
    post_url:     node.url || node.wwwURL || node.permalink_url || '',
    image_urls:   extractImageUrls(node).join(' | '),
    video_url:    extractVideoUrl(node),
    _postId:      postId,
    _score:       scoreNode(node),
    _creationTime: creationTime,
  };
}

// ============================================================
// PARSE RESPONSE BODY → array of posts
// KEY FIX: merge duplicate post_ids, keep highest-scored version
// ============================================================
function parseResponseBody(rawBody, pageName, pageUrl) {
  // Map: postId → best post seen so far
  const bestByPostId = new Map();

  const lines = rawBody.split('\n').filter(l => l.trim().startsWith('{'));
  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }

    const nodesToTry = [];

    // FORMAT A: first chunk with edges[]
    const edges = get(parsed, 'data', 'node', 'timeline_list_feed_units', 'edges');
    if (Array.isArray(edges)) {
      for (const edge of edges) {
        if (edge?.node) nodesToTry.push(edge.node);
      }
    }

    // FORMAT B: stream chunk with label+path
    if (parsed.label && Array.isArray(parsed.path)) {
      const streamNode = get(parsed, 'data', 'node');
      if (streamNode) nodesToTry.push(streamNode);
    }

    for (const rawNode of nodesToTry) {
      const post = parseStoryNode(rawNode, pageName, pageUrl);
      if (!post) continue;

      mergePost(bestByPostId, post);
    }
  }

  return [...bestByPostId.values()];
}

// ============================================================
// EXTRACT POSTS EMBEDDED IN INITIAL PAGE HTML
//
// Bài viết mới nhất (top of feed) thường được Facebook nhúng sẵn
// (server-side render) trực tiếp vào HTML ban đầu trong các thẻ
// <script type="application/json" data-sjs>, KHÔNG đi qua GraphQL XHR
// nào — nên page.on('response') không bắt được, dẫn tới crawler luôn
// thiếu mất bài mới nhất. Quét toàn bộ các thẻ script này, tìm mọi
// Story node (không phụ thuộc path cụ thể, vì path lồng rất sâu và
// có thể đổi giữa các lần load — vd "data.user...." thay vì
// "data.node....") rồi parse như post thường.
// ============================================================
function findStoryNodes(obj, results = [], depth = 0) {
  if (depth > 60 || obj == null || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    for (const item of obj) findStoryNodes(item, results, depth + 1);
    return results;
  }
  if (obj.__typename === 'Story' && obj.post_id) {
    results.push(obj);
  }
  for (const key of Object.keys(obj)) {
    findStoryNodes(obj[key], results, depth + 1);
  }
  return results;
}

function parseEmbeddedHtmlPosts(html, pageName, pageUrl) {
  const bestByPostId = new Map();
  const re = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;

    for (const rawNode of findStoryNodes(parsed)) {
      const post = parseStoryNode(rawNode, pageName, pageUrl);
      if (!post) continue;
      mergePost(bestByPostId, post);
    }
  }
  return [...bestByPostId.values()];
}

function mergePost(bestByPostId, post) {
  const existing = bestByPostId.get(post._postId);
  if (!existing || isBetterPost(post, existing)) {
    bestByPostId.set(post._postId, post);
    return true;
  }
  return false;
}

function mediaCount(post) {
  const imageCount = post.image_urls ? post.image_urls.split(' | ').filter(Boolean).length : 0;
  return imageCount + (post.video_url ? 1 : 0);
}

function isBetterPost(candidate, existing) {
  if (candidate._score !== existing._score) return candidate._score > existing._score;

  const candidateMedia = mediaCount(candidate);
  const existingMedia = mediaCount(existing);
  if (candidateMedia !== existingMedia) return candidateMedia > existingMedia;

  return (candidate.content || '').length > (existing.content || '').length;
}

async function captureEmbeddedPosts(page, fanpage, bestByPostId) {
  const before = bestByPostId.size;
  const html = await page.content();
  const embeddedPosts = parseEmbeddedHtmlPosts(html, fanpage.name, fanpage.url);
  for (const post of embeddedPosts) {
    mergePost(bestByPostId, post);
  }
  return {
    found: embeddedPosts.length,
    added: bestByPostId.size - before,
    html,
  };
}

// ============================================================
// DATE RANGE HELPERS
// ============================================================
function isInDateRange(postDate) {
  if (!postDate) return true;
  const d = new Date(postDate);
  if (DATE_FROM && d < new Date(DATE_FROM)) return false;
  if (DATE_TO   && d > new Date(DATE_TO))   return false;
  return true;
}

function isPastDateFrom(postDate) {
  if (!DATE_FROM || !postDate) return false;
  return new Date(postDate) < new Date(DATE_FROM);
}

// ============================================================
// CSV WRITER — 1 file riêng cho mỗi fanpage, trong DATA_DIR.
// Mỗi lần crawl ghi lại snapshot mới, không append vào dữ liệu cũ.
// ============================================================
function makeCsvWriter(filePath) {
  return createObjectCsvWriter({
    path: filePath,
    header: [
      { id: 'post_date',    title: 'post_date' },
      { id: 'content',      title: 'content' },
      { id: 'fanpage_name', title: 'fanpage_name' },
      { id: 'reaction',     title: 'reaction' },
      { id: 'share',        title: 'share' },
      { id: 'comment',      title: 'comment' },
      { id: 'fanpage_url',  title: 'fanpage_url' },
      { id: 'post_url',     title: 'post_url' },
      { id: 'image_urls',   title: 'image_urls' },
      { id: 'video_url',    title: 'video_url' },
    ],
    append: false,
  });
}

// ============================================================
// CRAWL ONE PAGE
// ============================================================
async function crawlPage(page, fanpage, csvWriter) {
  console.log(`\n📄 ${fanpage.name}`);
  console.log(`   ${fanpage.url}`);

  // postId → best post accumulated across ALL responses for this page
  const bestByPostId = new Map();

  const handler = async (response) => {
    if (!response.url().includes('api/graphql')) return;
    try {
      const body = await response.text();

      if (DEBUG_DUMP) {
        const postData = response.request().postData() || '';
        const nameMatch = postData.match(/fb_api_req_friendly_name=([^&]+)/);
        const friendlyName = nameMatch ? decodeURIComponent(nameMatch[1]) : '(unknown)';
        const hasReaction = body.includes('reaction_count');
        console.log(`  🐛 [${friendlyName}] reaction_count=${hasReaction} size=${body.length}`);

        if (debugDumpCount < MAX_DEBUG_DUMPS) {
          fs.mkdirSync(DEBUG_DIR, { recursive: true });
          const safeName = friendlyName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const file = `${DEBUG_DIR}/dump_${debugDumpCount}_${safeName}.json`;
          fs.writeFileSync(file, body);
          debugDumpCount++;
        }
      }

      const posts = parseResponseBody(body, fanpage.name, fanpage.url);
      for (const post of posts) {
        mergePost(bestByPostId, post);
      }
    } catch { /* ignore */ }
  };

  page.on('response', handler);

  try {
    await page.goto(fanpage.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    console.log('  ⚠️  Navigation timeout (continuing)');
  }

  // Bài mới nhất có thể được nhúng sẵn trong HTML (SSR), không qua GraphQL.
  // Facebook hydrate feed sau domcontentloaded khá chậm, nên retry vài lần
  // trước khi scroll để không chụp HTML quá sớm và mất bài đầu tiên.
  let html = '';
  let embeddedFound = 0;
  for (let i = 0; i < INITIAL_FEED_PARSE_RETRIES; i++) {
    await page.waitForTimeout(INITIAL_FEED_WAIT_MS);
    const result = await captureEmbeddedPosts(page, fanpage, bestByPostId);
    html = result.html;
    embeddedFound = result.found;
    if (result.added > 0 || result.found > 0) break;
  }
  if (DEBUG_DUMP) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(`${DEBUG_DIR}/page_content.html`, html);
    console.log(`  🐛 dumped page HTML, embedded posts found: ${embeddedFound}`);
  }

  let scrolls = 0;
  let noNewCount = 0;
  let lastCount = 0;

  while (scrolls < MAX_SCROLLS) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(randomBetween(SCROLL_WAIT_MIN_MS, SCROLL_WAIT_MAX_MS));
    await captureEmbeddedPosts(page, fanpage, bestByPostId);
    scrolls++;

    const currentCount = bestByPostId.size;
    if (currentCount === lastCount) {
      noNewCount++;
      if (noNewCount >= 3) { console.log('  ⏹  No new posts'); break; }
    } else {
      noNewCount = 0;
      lastCount = currentCount;
    }

    // Stop if oldest post is past DATE_FROM
    const dates = [...bestByPostId.values()]
      .map(p => p.post_date).filter(Boolean).sort();
    if (dates.length && isPastDateFrom(dates[0])) {
      console.log(`  ⏹  Reached ${dates[0]} (before ${DATE_FROM})`);
      break;
    }

    if (scrolls % 5 === 0) {
      console.log(`  📜 scroll ${scrolls}, posts seen: ${currentCount}`);
    }
  }

  page.off('response', handler);

  // Filter by date range, then rewrite the fanpage CSV as a fresh snapshot.
  const filtered = [...bestByPostId.values()]
    .filter(p => isInDateRange(p.post_date))
    .sort((a, b) => {
      const ta = a._creationTime || 0;
      const tb = b._creationTime || 0;
      if (tb !== ta) return tb - ta;
      return (b.post_date || '').localeCompare(a.post_date || '');
    });

  // Log results
  for (const p of filtered) {
    const preview = p.content ? p.content.substring(0, 50) : '(no content)';
    console.log(`  ✅ ${p.post_date} | 👍${p.reaction} 💬${p.comment} 🔁${p.share} | ${preview}`);
  }

  const records = filtered.map(({ _postId, _score, _creationTime, ...rest }) => rest);
  await csvWriter.writeRecords(records);

  if (records.length > 0) {
    console.log(`  💾 Wrote ${records.length} posts`);
  } else {
    console.log(`  ℹ️  No posts in date range`);
  }

  return records.length;
}

async function crawlFanpage(context, fanpage) {
  const page = await context.newPage();
  try {
    const filePath = `${DATA_DIR}/${sanitizeFilename(fanpage.name)}.csv`;
    const csvWriter = makeCsvWriter(filePath);
    return await crawlPage(page, fanpage, csvWriter);
  } finally {
    await page.close().catch(() => {});
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const results = [];
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

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('🚀 Facebook Fanpage Crawler');
  console.log(`📅 ${DATE_FROM || '∞'} → ${DATE_TO || 'today'}`);
  console.log(`📁 Output dir: ${DATA_DIR}/`);
  console.log(`⚡ Parallel pages: ${PAGE_CONCURRENCY}`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('');

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState: fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'vi-VN',
  });

  const page = await context.newPage();

  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const loggedIn = await page.evaluate(() =>
    !document.querySelector('input[name="email"]') &&
    !document.querySelector('[data-testid="royal_login_button"]')
  );

  if (!loggedIn) {
    console.log('⚠️  Chưa đăng nhập. Đăng nhập vào Chrome đang mở,');
    console.log('   rồi nhấn ENTER ở đây để tiếp tục...\n');
    await new Promise(r => process.stdin.once('data', r));
    await context.storageState({ path: SESSION_FILE });
    console.log('✅ Đã lưu session\n');
  } else {
    console.log('✅ Đã đăng nhập\n');
  }

  await page.close().catch(() => {});

  if (BLOCK_HEAVY_RESOURCES) {
    await context.route('**/*', route => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        return route.abort();
      }
      return route.continue();
    });
  }

  const totals = await runWithConcurrency(FANPAGES, PAGE_CONCURRENCY, async (fanpage) => {
    try {
      return await crawlFanpage(context, fanpage);
    } catch (err) {
      console.error(`  ❌ ${fanpage.name}: ${err.message}`);
      return 0;
    }
  });

  const total = totals.reduce((sum, count) => sum + count, 0);

  await browser.close();
  console.log(`\n✅ Xong! Tổng ${total} bài → ${DATA_DIR}/`);
}

main().catch(console.error);

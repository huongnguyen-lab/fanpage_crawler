const { chromium } = require('playwright');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');

// ============================================================
// CONFIG — FANPAGES
// ============================================================
const FANPAGES = [
  { name: 'SunLife Vietnam',       url: 'https://www.facebook.com/SunLifeVietnam' },
//   { name: 'Chubb Life Vietnam',    url: 'https://www.facebook.com/BaohiemChubbLifeVietnam' },
//   { name: 'FWD Vietnam',           url: 'https://www.facebook.com/BaohiemFWDVietnam' },
//   { name: 'Dai-ichi Life Vietnam', url: 'https://www.facebook.com/DaiichiLife.Vietnam' },
//   { name: 'AIA Vietnam',           url: 'https://www.facebook.com/AIAVietnamLifeInsurance' },
//   { name: 'Bảo Việt Nhân Thọ',    url: 'https://www.facebook.com/www.BaoVietNhanTho.com.vn' },
//   { name: 'Prudential Vietnam',    url: 'https://www.facebook.com/Prudential.pva' },
//   { name: 'Manulife Vietnam',      url: 'https://www.facebook.com/ManulifeVietnam' },
//   { name: 'Generali Vietnam',      url: 'https://www.facebook.com/GeneraliVietnam' },
];

// ============================================================
// DATE RANGE — chỉnh tại đây
// Format: 'YYYY-MM-DD' | null = không giới hạn
// ============================================================
const DATE_FROM = '2026-06-01';
const DATE_TO   = null;

// ============================================================
// FILES
// ============================================================
const OUTPUT_FILE    = 'posts.csv';
const SESSION_FILE   = 'session.json';
const KNOWN_IDS_FILE = 'known_posts.json';

// ============================================================
// DEBUG DUMP — tạm thời để điều tra vì sao thiếu like/comment/share
// Ghi vài response GraphQL thô ra ./debug để soi cấu trúc thật.
// Tắt (false) sau khi xong điều tra.
// ============================================================
const DEBUG_DUMP = true;
const DEBUG_DIR = 'debug';
const MAX_DEBUG_DUMPS = 8;
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
// EXTRACT FEEDBACK — returns object with reaction/share/comment counts
// KEY FIX: tries all paths, returns the one with actual numbers > 0
// ============================================================
function extractFeedback(node) {
  const candidates = [];

  // Path A — main path via story_ufi_container
  const a = get(node,
    'comet_sections', 'feedback', 'story',
    'story_ufi_container', 'story',
    'feedback_context', 'feedback_target_with_context',
    'comet_ufi_summary_and_actions_renderer', 'feedback');
  if (a) candidates.push(a);

  // Path B — top-level feedback (has reaction_count directly)
  if (node.feedback && node.feedback.reaction_count) candidates.push(node.feedback);

  // Path C — shareable_from_perspective_of_feed_ufi (sometimes populated)
  const c = get(node, 'shareable_from_perspective_of_feed_ufi');
  if (c && c.reaction_count) candidates.push(c);

  // Return the candidate with the highest reaction count (most complete data)
  let best = null;
  let bestCount = -1;
  for (const fb of candidates) {
    const count = get(fb, 'reaction_count', 'count') ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = fb;
    }
  }

  // If no candidate has reaction_count, return first non-null
  return best || candidates[0] || null;
}

// ============================================================
// EXTRACT IMAGE URLs
// ============================================================
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
  if (fb) {
    score += get(fb, 'reaction_count', 'count') > 0 ? 3 : 0;
    score += get(fb, 'share_count', 'count') > 0 ? 2 : 0;
    score += get(fb, 'comment_rendering_instance', 'comments', 'total_count') > 0 ? 2 : 0;
  }
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
  const reactions = get(fb, 'reaction_count', 'count') ?? 0;
  const comments  = get(fb, 'comment_rendering_instance', 'comments', 'total_count') ?? 0;
  const shares    = get(fb, 'share_count', 'count') ?? 0;

  return {
    post_date:    postDate,
    content:      content.replace(/\r?\n/g, ' '),
    fanpage_name: resolvedName,
    like:         reactions,
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

      const existing = bestByPostId.get(post._postId);
      // Keep whichever version has higher score (more complete data)
      if (!existing || post._score > existing._score) {
        bestByPostId.set(post._postId, post);
      }
    }
  }

  return [...bestByPostId.values()];
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
// KNOWN IDS
// ============================================================
function loadKnownIds() {
  try { return JSON.parse(fs.readFileSync(KNOWN_IDS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveKnownIds(ids) {
  fs.writeFileSync(KNOWN_IDS_FILE, JSON.stringify(ids, null, 2));
}

// ============================================================
// CSV WRITER
// ============================================================
function makeCsvWriter() {
  return createObjectCsvWriter({
    path: OUTPUT_FILE,
    header: [
      { id: 'post_date',    title: 'post_date' },
      { id: 'content',      title: 'content' },
      { id: 'fanpage_name', title: 'fanpage_name' },
      { id: 'like',         title: 'like' },
      { id: 'share',        title: 'share' },
      { id: 'comment',      title: 'comment' },
      { id: 'fanpage_url',  title: 'fanpage_url' },
      { id: 'post_url',     title: 'post_url' },
      { id: 'image_urls',   title: 'image_urls' },
      { id: 'video_url',    title: 'video_url' },
    ],
    append: fs.existsSync(OUTPUT_FILE),
  });
}

// ============================================================
// CRAWL ONE PAGE
// ============================================================
async function crawlPage(page, fanpage, knownIds, csvWriter) {
  console.log(`\n📄 ${fanpage.name}`);
  console.log(`   ${fanpage.url}`);

  // postId → best post accumulated across ALL responses for this page
  const bestByPostId = new Map();

  const handler = async (response) => {
    if (!response.url().includes('api/graphql')) return;
    try {
      const body = await response.text();

      if (DEBUG_DUMP && debugDumpCount < MAX_DEBUG_DUMPS) {
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const file = `${DEBUG_DIR}/dump_${debugDumpCount}.json`;
        fs.writeFileSync(file, body);
        console.log(`  🐛 debug dump → ${file}`);
        debugDumpCount++;
      }

      const posts = parseResponseBody(body, fanpage.name, fanpage.url);
      for (const post of posts) {
        const existing = bestByPostId.get(post._postId);
        if (!existing || post._score > existing._score) {
          bestByPostId.set(post._postId, post);
        }
      }
    } catch { /* ignore */ }
  };

  page.on('response', handler);

  try {
    await page.goto(fanpage.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    console.log('  ⚠️  Navigation timeout (continuing)');
  }
  await page.waitForTimeout(3000);

  let scrolls = 0;
  let noNewCount = 0;
  let lastCount = 0;

  while (scrolls < 30) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(2000 + Math.random() * 1000);
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

  // Filter by date range and exclude already-known posts
  const filtered = [...bestByPostId.values()].filter(p => isInDateRange(p.post_date));
  const newPosts  = filtered.filter(p => !knownIds[p._postId]);

  // Log results
  for (const p of filtered) {
    const isNew = !knownIds[p._postId] ? '✅' : '⏭ ';
    const preview = p.content ? p.content.substring(0, 50) : '(no content)';
    console.log(`  ${isNew} ${p.post_date} | 👍${p.like} 💬${p.comment} 🔁${p.share} | ${preview}`);
  }

  if (newPosts.length > 0) {
    const records = newPosts.map(({ _postId, _score, _creationTime, ...rest }) => rest);
    await csvWriter.writeRecords(records);
    for (const p of newPosts) {
      knownIds[p._postId] = new Date().toISOString();
    }
    console.log(`  💾 Saved ${newPosts.length} new posts`);
  } else {
    console.log(`  ℹ️  No new posts`);
  }

  return newPosts.length;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('🚀 Facebook Fanpage Crawler');
  console.log(`📅 ${DATE_FROM || '∞'} → ${DATE_TO || 'today'}`);
  console.log(`📁 Output: ${OUTPUT_FILE}`);

  const knownIds = loadKnownIds();
  console.log(`📋 Known posts: ${Object.keys(knownIds).length}\n`);

  const csvWriter = makeCsvWriter();

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

  let total = 0;
  for (const fanpage of FANPAGES) {
    try {
      total += await crawlPage(page, fanpage, knownIds, csvWriter);
      saveKnownIds(knownIds);
      await page.waitForTimeout(3000 + Math.random() * 2000);
    } catch (err) {
      console.error(`  ❌ ${fanpage.name}: ${err.message}`);
    }
  }

  await browser.close();
  console.log(`\n✅ Xong! Tổng ${total} bài mới → ${OUTPUT_FILE}`);
}

main().catch(console.error);
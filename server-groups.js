'use strict';

const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const { chromium } = require('playwright');
const config = require('./playwright-groups.config');
const { GROUP_LIST, resolveGroup } = require('./groups.config');

const COLLECTOR_VERSION = 'groups-feed-1.0.0';
const COLLECTION_MODE = 'group_feed';
const app = express();
app.use(express.json({ limit: '2mb' }));

let browser = null;
let activeCollectors = 0;
const waitQueue = [];

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function requestId() {
  return crypto.randomBytes(8).toString('hex');
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex');
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

async function acquireSlot() {
  if (activeCollectors < config.collector.maxConcurrent) {
    activeCollectors += 1;
    return;
  }
  await new Promise((resolve) => waitQueue.push(resolve));
  activeCollectors += 1;
}

function releaseSlot() {
  activeCollectors = Math.max(0, activeCollectors - 1);
  const next = waitQueue.shift();
  if (next) next();
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch(config.browser.launchOptions);
  browser.on('disconnected', () => {
    browser = null;
  });
  return browser;
}

function storageStateExists() {
  return fs.existsSync(config.storageStatePath);
}

async function createContext() {
  if (!storageStateExists()) {
    const err = new Error(`storage_state_missing:${config.storageStatePath}`);
    err.code = 'storage_state_missing';
    throw err;
  }

  const browserInstance = await getBrowser();
  const context = await browserInstance.newContext({
    storageState: config.storageStatePath,
    locale: config.context.locale,
    timezoneId: config.context.timezoneId,
    viewport: config.context.viewport,
    extraHTTPHeaders: config.context.extraHTTPHeaders,
  });

  context.setDefaultTimeout(config.timeout.actionMs);
  context.setDefaultNavigationTimeout(config.timeout.navigationMs);
  return context;
}

function isFacebookAuthFailureUrl(url) {
  const value = lower(url);
  return value.includes('/login') || value.includes('/checkpoint') || value.includes('/recover/');
}

async function assertSessionOnPage(page) {
  const currentUrl = page.url();
  if (isFacebookAuthFailureUrl(currentUrl)) {
    const err = new Error(`facebook_session_invalid:${currentUrl}`);
    err.code = 'facebook_session_invalid';
    throw err;
  }

  const loginInputVisible = await page
    .locator('input[name="email"], input[name="pass"]')
    .first()
    .isVisible()
    .catch(() => false);

  if (loginInputVisible) {
    const err = new Error('facebook_session_invalid:login_form_visible');
    err.code = 'facebook_session_invalid';
    throw err;
  }
}

async function openGroupFeed(page, group) {
  await page.goto(group.source_url, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeout.navigationMs,
  });
  await sleep(config.collector.initialWaitMs);
  await assertSessionOnPage(page);

  return {
    current_url: page.url(),
    title: await page.title().catch(() => ''),
  };
}

async function locateArticleContainer(page) {
  const candidates = [
    'div[role="feed"] div[role="article"]',
    '[role="feed"] [role="article"]',
    'div[role="article"]',
    '[role="article"]',
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) return { selector, locator, count };
  }

  return { selector: candidates[0], locator: page.locator(candidates[0]), count: 0 };
}

function canonicalFacebookUrl(rawHref) {
  const href = clean(rawHref);
  if (!href) return '';

  try {
    const url = new URL(href, 'https://www.facebook.com');
    if (!/facebook\.com$/i.test(url.hostname) && !/\.facebook\.com$/i.test(url.hostname)) return '';

    const keep = new URL(`${url.protocol}//${url.hostname}${url.pathname}`);
    return keep.toString();
  } catch {
    return '';
  }
}

function postIdFromUrl(url, groupId) {
  const value = clean(url);
  const escaped = String(groupId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    value.match(new RegExp(`/groups/${escaped}/posts/(\\d+)`, 'i'))?.[1] ||
    value.match(new RegExp(`/groups/${escaped}/permalink/(\\d+)`, 'i'))?.[1] ||
    ''
  );
}

function looksLikeRelativeTime(text) {
  const value = lower(text);
  return (
    value === 'vừa xong' ||
    value === 'just now' ||
    /^\d+\s*(phút|ph|mins?|minutes?)$/i.test(value) ||
    /^\d+\s*(giờ|g|hrs?|hours?)$/i.test(value) ||
    /^\d+\s*(ngày|days?)$/i.test(value) ||
    /^\d+\s*(tuần|weeks?)$/i.test(value)
  );
}

function parseRelativePublishedAt(raw, collectedAt = new Date()) {
  const text = lower(raw);
  if (!text) return null;

  if (text === 'vừa xong' || text === 'just now') return new Date(collectedAt.getTime());

  let m = text.match(/^(\d+)\s*(phút|ph|mins?|minutes?)$/i);
  if (m) return new Date(collectedAt.getTime() - Number(m[1]) * 60 * 1000);

  m = text.match(/^(\d+)\s*(giờ|g|hrs?|hours?)$/i);
  if (m) return new Date(collectedAt.getTime() - Number(m[1]) * 60 * 60 * 1000);

  m = text.match(/^(\d+)\s*(ngày|days?)$/i);
  if (m) return new Date(collectedAt.getTime() - Number(m[1]) * 24 * 60 * 60 * 1000);

  m = text.match(/^(\d+)\s*(tuần|weeks?)$/i);
  if (m) return new Date(collectedAt.getTime() - Number(m[1]) * 7 * 24 * 60 * 60 * 1000);

  return null;
}

function parseExactDateCandidate(raw) {
  const value = clean(raw);
  if (!value) return null;

  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return new Date(direct);

  // Common vi-VN style: HH:mm DD/MM/YYYY or DD/MM/YYYY HH:mm.
  let m = value.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    return new Date(Date.UTC(Number(m[5]), Number(m[4]) - 1, Number(m[3]), Number(m[1]) - 7, Number(m[2])));
  }

  m = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]) - 7, Number(m[5])));
  }

  return null;
}

function classifyTime({ publishedAt, windowStart, windowEnd }) {
  if (!publishedAt) {
    return {
      time_status: 'TIME_UNRESOLVED',
      time_confidence: 'unresolved',
      window_keep_recommended: true,
    };
  }

  const timestamp = publishedAt.getTime();
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return {
      time_status: 'EXACT_PRIMARY',
      time_confidence: 'resolved',
      window_keep_recommended: true,
    };
  }

  const inside = timestamp >= start && timestamp <= end;
  return {
    time_status: inside ? 'EXACT_PRIMARY' : 'EXACT_OUTSIDE',
    time_confidence: 'resolved',
    window_keep_recommended: inside,
  };
}

async function extractCardSnapshot(card, groupId) {
  return card.evaluate((node, expectedGroupId) => {
    const normalize = (v) => String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const articleRect = node.getBoundingClientRect();
    const anchors = Array.from(node.querySelectorAll('a[href]')).map((a) => {
      const rect = a.getBoundingClientRect();
      return {
        text: normalize(a.innerText || a.textContent || ''),
        href: a.getAttribute('href') || '',
        title: a.getAttribute('title') || '',
        ariaLabel: a.getAttribute('aria-label') || '',
        y: rect.top - articleRect.top,
      };
    });

    const images = Array.from(node.querySelectorAll('img[src]'))
      .map((img) => ({
        src: img.currentSrc || img.getAttribute('src') || '',
        alt: normalize(img.getAttribute('alt') || ''),
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
      }))
      .filter((img) => img.src && (img.width >= 150 || img.height >= 150))
      .slice(0, 20);

    const directCandidates = anchors.filter((a) => {
      const href = a.href || '';
      return href.includes(`/groups/${expectedGroupId}/posts/`) || href.includes(`/groups/${expectedGroupId}/permalink/`);
    });

    const upperBound = Math.max(220, articleRect.height * 0.38);
    const upperAnchors = anchors.filter((a) => a.y >= -10 && a.y <= upperBound);

    return {
      innerText: normalize(node.innerText || node.textContent || ''),
      anchors,
      directCandidates,
      upperAnchors,
      images,
      isNestedArticle: Boolean(node.parentElement && node.parentElement.closest('[role="article"]')),
      nestedArticleCount: node.querySelectorAll('[role="article"]').length,
      ariaText: Array.from(node.querySelectorAll('[aria-label]'))
        .map((el) => normalize(el.getAttribute('aria-label') || ''))
        .filter(Boolean)
        .slice(0, 100),
    };
  }, groupId);
}

function chooseDirectPostUrl(snapshot, groupId) {
  for (const candidate of snapshot.directCandidates || []) {
    const canonical = canonicalFacebookUrl(candidate.href);
    if (!canonical) continue;
    if (postIdFromUrl(canonical, groupId)) return canonical;
  }
  return '';
}

function chooseTimestamp(snapshot, postUrl) {
  const postPath = (() => {
    try { return new URL(postUrl).pathname; } catch { return ''; }
  })();

  const candidates = snapshot.upperAnchors || [];

  // Strongest signal: timestamp-looking anchor that points to the same direct post URL.
  for (const a of candidates) {
    const href = canonicalFacebookUrl(a.href);
    const text = clean(a.text);
    const exact = clean(a.title || a.ariaLabel);
    if (postPath && href && (() => { try { return new URL(href).pathname === postPath; } catch { return false; } })()) {
      if (looksLikeRelativeTime(text) || exact) {
        return { raw: text || exact, exact_hint: exact, source: 'OUTER_POST_LINK' };
      }
    }
  }

  // Fallback: a relative-time looking anchor in the upper/header portion of the outer article.
  for (const a of candidates) {
    const text = clean(a.text);
    if (looksLikeRelativeTime(text)) {
      return {
        raw: text,
        exact_hint: clean(a.title || a.ariaLabel),
        source: 'OUTER_HEADER_RELATIVE_TIME',
      };
    }
  }

  return { raw: '', exact_hint: '', source: 'UNRESOLVED' };
}

function chooseAuthor(snapshot, groupId) {
  const candidates = snapshot.upperAnchors || [];
  for (const a of candidates) {
    const text = clean(a.text);
    if (!text || looksLikeRelativeTime(text)) continue;

    const href = canonicalFacebookUrl(a.href);
    if (!href) continue;
    if (href.includes(`/groups/${groupId}/posts/`) || href.includes(`/groups/${groupId}/permalink/`)) continue;
    if (href.includes(`/groups/${groupId}/`)) continue;
    if (href.includes('/photo') || href.includes('/story') || href.includes('/watch')) continue;

    return { author_name: text, author_url: href };
  }
  return { author_name: '', author_url: '' };
}

function extractCounts(snapshot) {
  const labels = (snapshot.ariaText || []).join(' | ');
  const text = `${labels} | ${snapshot.innerText || ''}`;

  const reaction =
    text.match(/([\d.,]+)\s*(?:lượt\s*)?(?:cảm xúc|reactions?)/i)?.[1] ||
    text.match(/(?:cảm xúc|reactions?)\s*[:·-]?\s*([\d.,]+)/i)?.[1] ||
    '';

  const comment =
    text.match(/([\d.,]+)\s*(?:bình luận|comments?)/i)?.[1] ||
    text.match(/(?:bình luận|comments?)\s*[:·-]?\s*([\d.,]+)/i)?.[1] ||
    '';

  return { reaction_count: reaction, comment_count: comment };
}

function buildContentKey({ groupId, postId, postUrl, authorName, postText }) {
  if (postId) return `group:${groupId}:post:${postId}`;
  if (postUrl) return `group:${groupId}:url:${postUrl}`;
  return `group:${groupId}:content:${sha1(`${lower(authorName)}|${lower(postText).slice(0, 500)}`)}`;
}

async function parseArticle(card, { group, collectedAt, windowStart, windowEnd }) {
  const snapshot = await extractCardSnapshot(card, group.group_id).catch(() => null);
  if (!snapshot || snapshot.isNestedArticle) return null;

  const postText = clean(snapshot.innerText);
  if (!postText) return null;

  const candidateUrl = chooseDirectPostUrl(snapshot, group.group_id);
  const postId = postIdFromUrl(candidateUrl, group.group_id);
  const timestamp = chooseTimestamp(snapshot, candidateUrl);
  const author = chooseAuthor(snapshot, group.group_id);

  const relative = parseRelativePublishedAt(timestamp.raw, collectedAt);
  const exact = parseExactDateCandidate(timestamp.exact_hint);
  const publishedDate = exact || relative;
  const time = classifyTime({ publishedAt: publishedDate, windowStart, windowEnd });
  const counts = extractCounts(snapshot);

  return {
    collected_at: collectedAt.toISOString(),
    published_at: publishedDate ? publishedDate.toISOString() : '',
    posted_at_raw: timestamp.raw || timestamp.exact_hint || '',
    timestamp_source: timestamp.source,
    time_status: time.time_status,
    time_confidence: time.time_confidence,
    window_keep_recommended: time.window_keep_recommended,

    post_id: postId,
    post_url_candidate: candidateUrl,
    post_url: '',
    post_link: '',
    link_validation_status: candidateUrl ? 'PENDING_VERIFY' : 'NO_DIRECT_LINK',
    link_validation_reason: candidateUrl ? 'direct_group_feed_anchor' : 'no_direct_group_feed_anchor',

    author_name: author.author_name,
    author_url: author.author_url,
    post_text: postText,
    image_urls: (snapshot.images || []).map((img) => img.src),
    reaction_count: counts.reaction_count,
    comment_count: counts.comment_count,

    content_type: snapshot.nestedArticleCount > 1 ? 'share' : 'post',
    is_shared: snapshot.nestedArticleCount > 1,
    content_key: buildContentKey({
      groupId: group.group_id,
      postId,
      postUrl: candidateUrl,
      authorName: author.author_name,
      postText,
    }),
    fallback_post_id: false,
    search_queries: [],
    query_keyword: 'group_feed',
  };
}

function dedupePosts(posts) {
  const map = new Map();
  for (const post of posts) {
    const key = post.content_key || buildContentKey({
      groupId: '',
      postId: post.post_id,
      postUrl: post.post_url_candidate,
      authorName: post.author_name,
      postText: post.post_text,
    });
    if (!map.has(key)) map.set(key, post);
  }
  return Array.from(map.values());
}

async function verifyDirectPostUrl(context, group, url) {
  if (!url) return { verified: false, reason: 'empty_url', final_url: '' };

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeout.linkVerifyMs });
    await sleep(600);
    await assertSessionOnPage(page);

    const finalUrl = canonicalFacebookUrl(page.url());
    const finalPostId = postIdFromUrl(finalUrl, group.group_id);
    const originalPostId = postIdFromUrl(url, group.group_id);
    const verified = Boolean(finalPostId && originalPostId && finalPostId === originalPostId);

    return {
      verified,
      reason: verified ? 'live_verified_same_group_post' : 'redirect_or_post_id_mismatch',
      final_url: verified ? finalUrl : '',
    };
  } catch (error) {
    return { verified: false, reason: `verify_error:${clean(error.message)}`, final_url: '' };
  } finally {
    await page.close().catch(() => {});
  }
}

async function verifyPostLinks(context, group, posts, limit) {
  let attempted = 0;
  let verifiedCount = 0;

  for (const post of posts) {
    if (!post.post_url_candidate || attempted >= limit) {
      if (post.post_url_candidate && attempted >= limit) {
        post.link_validation_status = 'NOT_VERIFIED_LIMIT';
        post.link_validation_reason = 'link_verify_limit_reached';
      }
      continue;
    }

    attempted += 1;
    const result = await verifyDirectPostUrl(context, group, post.post_url_candidate);
    if (result.verified) {
      post.post_url = result.final_url || post.post_url_candidate;
      post.post_link = post.post_url;
      post.link_validation_status = 'VERIFIED';
      post.link_validation_reason = result.reason;
      verifiedCount += 1;
    } else {
      // Preserve the listing but keep Group post_url blank unless the link was live-verified.
      post.post_url = '';
      post.post_link = '';
      post.link_validation_status = 'UNVERIFIED';
      post.link_validation_reason = result.reason;
    }
  }

  return { attempted, verifiedCount };
}

async function collectGroupFeed({ group, windowStart, windowEnd, maxPosts, maxScrolls, linkVerifyLimit }) {
  const context = await createContext();
  const page = await context.newPage();
  const startedAt = Date.now();
  const collectedAt = new Date();

  let selectorUsed = '';
  let scrollCount = 0;
  let articlesSeenPeak = 0;
  let stableRounds = 0;
  let previousCount = 0;

  try {
    const navigation = await openGroupFeed(page, group);

    for (let round = 0; round <= maxScrolls; round += 1) {
      const found = await locateArticleContainer(page);
      selectorUsed = found.selector;
      articlesSeenPeak = Math.max(articlesSeenPeak, found.count);

      if (found.count >= maxPosts) break;
      if (round >= maxScrolls) break;

      if (round >= config.collector.minScrolls) {
        if (found.count <= previousCount) stableRounds += 1;
        else stableRounds = 0;
        if (stableRounds >= config.collector.stableScrollRoundsToStop) break;
      }

      previousCount = found.count;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await sleep(randomBetween(config.collector.scrollDelayMinMs, config.collector.scrollDelayMaxMs));
      scrollCount += 1;
      await assertSessionOnPage(page);
    }

    const finalFound = await locateArticleContainer(page);
    selectorUsed = finalFound.selector;
    const totalCards = Math.min(await finalFound.locator.count(), maxPosts);
    articlesSeenPeak = Math.max(articlesSeenPeak, totalCards);

    const parsed = [];
    for (let i = 0; i < totalCards; i += 1) {
      const post = await parseArticle(finalFound.locator.nth(i), {
        group,
        collectedAt,
        windowStart,
        windowEnd,
      }).catch(() => null);
      if (post) parsed.push(post);
    }

    const deduped = dedupePosts(parsed);
    const linkStats = await verifyPostLinks(context, group, deduped, linkVerifyLimit);

    const postsInWindow = deduped.filter((p) => p.time_status !== 'EXACT_OUTSIDE').length;
    const postsOutsideWindow = deduped.filter((p) => p.time_status === 'EXACT_OUTSIDE').length;
    const unresolved = deduped.filter((p) => p.time_status === 'TIME_UNRESOLVED').length;

    return {
      posts: deduped,
      diagnostics: {
        articles_seen: articlesSeenPeak,
        posts_parsed: parsed.length,
        unique_posts_collected: deduped.length,
        posts_in_window: postsInWindow,
        posts_outside_window: postsOutsideWindow,
        unresolved_time_count: unresolved,
        verified_links: linkStats.verifiedCount,
        link_verify_attempted: linkStats.attempted,
        rows_returned: deduped.length,
        scroll_count: scrollCount,
        selector_used: selectorUsed,
        page_url: navigation.current_url,
        page_title: navigation.title,
        elapsed_ms: Date.now() - startedAt,
      },
    };
  } finally {
    await context.close().catch(() => {});
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'facebook-groups-collector',
    collector_version: COLLECTOR_VERSION,
    collection_mode: COLLECTION_MODE,
    port: config.port,
    storage_state_exists: storageStateExists(),
    active_collectors: activeCollectors,
    queued_collectors: waitQueue.length,
    allowed_groups: GROUP_LIST.map((g) => ({ code: g.code, group_id: g.group_id, source_key: g.source_key })),
    time: nowIso(),
  });
});

app.get('/session/check', async (_req, res) => {
  if (!storageStateExists()) {
    return res.status(503).json({
      ok: false,
      session_valid: false,
      error: 'storage_state_missing',
      storage_state_path: config.storageStatePath,
      time: nowIso(),
    });
  }

  let context;
  try {
    context = await createContext();
    const page = await context.newPage();
    await page.goto('https://www.facebook.com/', {
      waitUntil: 'domcontentloaded',
      timeout: config.timeout.navigationMs,
    });
    await sleep(1200);
    await assertSessionOnPage(page);

    return res.json({
      ok: true,
      session_valid: true,
      current_url: page.url(),
      title: await page.title().catch(() => ''),
      time: nowIso(),
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      session_valid: false,
      error: clean(error.message),
      time: nowIso(),
    });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

app.post('/collect', async (req, res) => {
  const id = requestId();
  const startedAt = Date.now();
  const body = req.body || {};

  if (clean(body.source_type || 'group') !== 'group') {
    return res.status(400).json({
      error: 'invalid_source_type',
      required: 'group',
      request_id: id,
    });
  }

  const requestedMode = clean(body.collection_mode || COLLECTION_MODE);
  if (requestedMode !== COLLECTION_MODE) {
    return res.status(400).json({
      error: 'invalid_collection_mode',
      required: COLLECTION_MODE,
      request_id: id,
    });
  }

  let group;
  try {
    group = resolveGroup(body);
  } catch (error) {
    return res.status(400).json({
      error: error.code || 'invalid_group',
      request_id: id,
      allowed: error.allowed || [],
    });
  }

  const windowStart = clean(body.window_start);
  const windowEnd = clean(body.window_end);
  const maxPosts = clampNumber(
    body.max_posts_per_run ?? body.max_posts,
    config.collector.maxPostsPerRun,
    1,
    config.collector.maxPostsPerRun
  );
  const maxScrolls = clampNumber(
    body.max_scrolls,
    config.collector.maxScrolls,
    1,
    config.collector.maxScrolls
  );
  const linkVerifyLimit = clampNumber(
    body.link_verify_limit ?? body.link_rescue_limit,
    config.collector.linkVerifyLimit,
    0,
    config.collector.linkVerifyLimit
  );

  await acquireSlot();
  try {
    const result = await collectGroupFeed({
      group,
      windowStart,
      windowEnd,
      maxPosts,
      maxScrolls,
      linkVerifyLimit,
    });

    return res.json({
      meta: {
        request_id: id,
        collector_version: COLLECTOR_VERSION,
        architecture: 'dedicated-meta-groups-collector',
        source_type: 'group',
        collection_mode: COLLECTION_MODE,
        source_key: group.source_key,
        source_name: group.source_name,
        source_url: group.source_url,
        group_id: group.group_id,
        window_start: windowStart,
        window_end: windowEnd,
        collected_at: nowIso(),
        diagnostics: result.diagnostics,
      },
      diagnostics: result.diagnostics,
      posts: result.posts,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (error) {
    const status = ['facebook_session_invalid', 'storage_state_missing'].includes(error.code) ? 503 : 500;
    return res.status(status).json({
      error: error.code || 'collector_error',
      message: clean(error.message),
      request_id: id,
      collector_version: COLLECTOR_VERSION,
      source_type: 'group',
      collection_mode: COLLECTION_MODE,
      source_key: group.source_key,
      group_id: group.group_id,
      elapsed_ms: Date.now() - startedAt,
    });
  } finally {
    releaseSlot();
  }
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'server_started',
    service: 'facebook-groups-collector',
    collector_version: COLLECTOR_VERSION,
    port: config.port,
    collection_mode: COLLECTION_MODE,
    storage_state_path: config.storageStatePath,
    allowed_groups: GROUP_LIST.map((g) => g.code),
    time: nowIso(),
  }));
});

async function shutdown(signal) {
  console.log(JSON.stringify({ event: 'shutdown', signal, time: nowIso() }));
  server.close(async () => {
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

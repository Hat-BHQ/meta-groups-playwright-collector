'use strict';

const path = require('path');

function envNumber(name, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function envBoolean(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function envString(name, fallback = '') {
  const value = String(process.env[name] ?? '').trim();
  return value || fallback;
}

const storageStatePath = envString(
  'GROUPS_STORAGE_STATE',
  path.join(__dirname, 'data', 'groups-storageState.json')
);

module.exports = Object.freeze({
  port: envNumber('PORT', 3001, 1, 65535),
  storageStatePath,

  browser: Object.freeze({
    headless: envBoolean('GROUPS_HEADLESS', true),
    launchOptions: Object.freeze({
      headless: envBoolean('GROUPS_HEADLESS', true),
      args: Object.freeze([
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ]),
    }),
  }),

  context: Object.freeze({
    locale: envString('GROUPS_LOCALE', 'vi-VN'),
    timezoneId: envString('GROUPS_TIMEZONE', 'Asia/Ho_Chi_Minh'),
    viewport: Object.freeze({ width: 1440, height: 1100 }),
    extraHTTPHeaders: Object.freeze({
      'Accept-Language': envString(
        'GROUPS_ACCEPT_LANGUAGE',
        'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
      ),
    }),
  }),

  timeout: Object.freeze({
    navigationMs: envNumber('GROUPS_NAVIGATION_TIMEOUT_MS', 90000, 10000, 300000),
    actionMs: envNumber('GROUPS_ACTION_TIMEOUT_MS', 30000, 5000, 120000),
    linkVerifyMs: envNumber('GROUPS_LINK_VERIFY_TIMEOUT_MS', 30000, 5000, 90000),
  }),

  collector: Object.freeze({
    maxConcurrent: envNumber('GROUPS_MAX_CONCURRENT', 1, 1, 4),
    maxPostsPerRun: envNumber('GROUPS_MAX_POSTS_PER_RUN', 300, 1, 1000),
    minScrolls: envNumber('GROUPS_MIN_SCROLLS', 8, 0, 100),
    maxScrolls: envNumber('GROUPS_MAX_SCROLLS', 30, 1, 200),
    scrollDelayMinMs: envNumber('GROUPS_SCROLL_DELAY_MIN_MS', 1200, 250, 10000),
    scrollDelayMaxMs: envNumber('GROUPS_SCROLL_DELAY_MAX_MS', 2500, 250, 15000),
    stableScrollRoundsToStop: envNumber('GROUPS_STABLE_SCROLL_ROUNDS', 3, 1, 10),
    linkVerifyLimit: envNumber('GROUPS_LINK_VERIFY_LIMIT', 40, 0, 300),
    initialWaitMs: envNumber('GROUPS_INITIAL_WAIT_MS', 3500, 500, 20000),
  }),
});

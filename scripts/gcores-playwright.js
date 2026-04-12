const fs = require('fs');
const path = require('path');
const process = require('process');
const readline = require('readline/promises');
const { chromium } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'gcores-playwright.config.json');
const LOCAL_CONFIG_PATH = path.join(PROJECT_ROOT, 'gcores-playwright.local.json');
const FEEDS_URL = 'https://www.gcores.com/feeds';
const PROCESSED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = {
  headless: true,
  storage: {
    userDataDir: '.gcores-playwright/profile',
    stateFile: '.gcores-playwright/state.json',
    errorScreenshotFile: '.gcores-playwright/last-error.png',
  },
  browser: {
    viewport: { width: 1600, height: 2200 },
  },
  run: {
    navigationTimeoutMs: 45000,
    waitForFeedMs: 15000,
    clickTimeoutMs: 8000,
    maxConsecutiveErrors: 3,
  },
  limits: {
    maxLikesPerRun: 0,
    maxLikesPerDay: 0,
  },
  timing: {
    actionDelayMsRange: [2500, 7000],
    cooldownAfterBlockMs: 60 * 60 * 1000,
  },
  filters: {
    allowAuthors: [],
    allowTopics: [],
    allowKeywords: [],
    allowEntryTypes: [],
    denyAuthors: [],
    denyTopics: [],
    denyKeywords: [],
    maxAgeHours: 0,
    onlyUnliked: true,
  },
};

const DEFAULT_STATE = {
  processed: {},
  dailyCounter: {
    date: '',
    likes: 0,
  },
  cooldown: {
    blockedUntil: 0,
  },
  lastError: null,
  lastRun: null,
};

class BlockedRequestError extends Error {
  constructor(status, message) {
    super(message || `vote request blocked with HTTP ${status}`);
    this.name = 'BlockedRequestError';
    this.status = status;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, override) {
  if (!isObject(base)) {
    return deepClone(override);
  }
  const output = deepClone(base);
  if (!isObject(override)) {
    return output;
  }
  Object.keys(override).forEach((key) => {
    const nextValue = override[key];
    if (Array.isArray(nextValue)) {
      output[key] = nextValue.slice();
      return;
    }
    if (isObject(nextValue) && isObject(output[key])) {
      output[key] = deepMerge(output[key], nextValue);
      return;
    }
    output[key] = nextValue;
  });
  return output;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeToken(value) {
  return cleanText(value).toLowerCase();
}

function normalizeStringList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return Array.from(new Set(list.map((item) => normalizeToken(item)).filter(Boolean)));
}

function clampNumber(value, fallback, minValue) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  if (typeof minValue === 'number' && number < minValue) {
    return minValue;
  }
  return number;
}

function sanitizeRange(value, fallback) {
  const range = Array.isArray(value) ? value.slice(0, 2) : fallback.slice();
  const minValue = clampNumber(range[0], fallback[0], 0);
  const maxValue = clampNumber(range[1], fallback[1], minValue);
  return [Math.min(minValue, maxValue), Math.max(minValue, maxValue)];
}

function sanitizeConfig(config) {
  const merged = deepMerge(DEFAULT_CONFIG, isObject(config) ? config : {});
  merged.headless = Boolean(merged.headless);
  merged.storage.userDataDir = cleanText(merged.storage.userDataDir || DEFAULT_CONFIG.storage.userDataDir);
  merged.storage.stateFile = cleanText(merged.storage.stateFile || DEFAULT_CONFIG.storage.stateFile);
  merged.storage.errorScreenshotFile = cleanText(
    merged.storage.errorScreenshotFile || DEFAULT_CONFIG.storage.errorScreenshotFile
  );
  merged.browser.viewport.width = clampNumber(merged.browser.viewport.width, DEFAULT_CONFIG.browser.viewport.width, 800);
  merged.browser.viewport.height = clampNumber(merged.browser.viewport.height, DEFAULT_CONFIG.browser.viewport.height, 600);
  merged.run.navigationTimeoutMs = clampNumber(merged.run.navigationTimeoutMs, DEFAULT_CONFIG.run.navigationTimeoutMs, 5000);
  merged.run.waitForFeedMs = clampNumber(merged.run.waitForFeedMs, DEFAULT_CONFIG.run.waitForFeedMs, 5000);
  merged.run.clickTimeoutMs = clampNumber(merged.run.clickTimeoutMs, DEFAULT_CONFIG.run.clickTimeoutMs, 1000);
  merged.run.maxConsecutiveErrors = clampNumber(merged.run.maxConsecutiveErrors, DEFAULT_CONFIG.run.maxConsecutiveErrors, 1);
  merged.limits.maxLikesPerRun = clampNumber(merged.limits.maxLikesPerRun, DEFAULT_CONFIG.limits.maxLikesPerRun, 0);
  merged.limits.maxLikesPerDay = clampNumber(merged.limits.maxLikesPerDay, DEFAULT_CONFIG.limits.maxLikesPerDay, 0);
  merged.timing.actionDelayMsRange = sanitizeRange(merged.timing.actionDelayMsRange, DEFAULT_CONFIG.timing.actionDelayMsRange);
  merged.timing.cooldownAfterBlockMs = clampNumber(
    merged.timing.cooldownAfterBlockMs,
    DEFAULT_CONFIG.timing.cooldownAfterBlockMs,
    1000
  );
  merged.filters.allowAuthors = normalizeStringList(merged.filters.allowAuthors);
  merged.filters.allowTopics = normalizeStringList(merged.filters.allowTopics);
  merged.filters.allowKeywords = normalizeStringList(merged.filters.allowKeywords);
  merged.filters.allowEntryTypes = normalizeStringList(merged.filters.allowEntryTypes);
  merged.filters.denyAuthors = normalizeStringList(merged.filters.denyAuthors);
  merged.filters.denyTopics = normalizeStringList(merged.filters.denyTopics);
  merged.filters.denyKeywords = normalizeStringList(merged.filters.denyKeywords);
  merged.filters.maxAgeHours = clampNumber(merged.filters.maxAgeHours, DEFAULT_CONFIG.filters.maxAgeHours, 0);
  merged.filters.onlyUnliked = Boolean(merged.filters.onlyUnliked);
  return merged;
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resetDailyCounter(counter, now = Date.now()) {
  const date = localDateKey(now);
  if (!counter || counter.date !== date) {
    return { date, likes: 0 };
  }
  return { date, likes: clampNumber(counter.likes, 0, 0) };
}

function trimProcessedCache(processed, now = Date.now()) {
  const next = {};
  if (!isObject(processed)) {
    return next;
  }
  Object.keys(processed).forEach((key) => {
    const entry = processed[key];
    const ts = clampNumber(entry && (entry.ts || entry.timestamp || entry), 0, 0);
    if (!ts || now - ts > PROCESSED_CACHE_TTL_MS) {
      return;
    }
    next[key] = { ts, status: cleanText(entry.status || 'processed') };
  });
  return next;
}

function sanitizeState(state) {
  const merged = deepMerge(DEFAULT_STATE, isObject(state) ? state : {});
  merged.processed = trimProcessedCache(merged.processed);
  merged.dailyCounter = resetDailyCounter(merged.dailyCounter);
  merged.cooldown.blockedUntil = clampNumber(merged.cooldown.blockedUntil, 0, 0);
  merged.lastError = merged.lastError && typeof merged.lastError.message === 'string' ? merged.lastError : null;
  merged.lastRun = merged.lastRun && typeof merged.lastRun === 'object' ? merged.lastRun : null;
  return merged;
}

function projectPath(relativePath) {
  return path.resolve(PROJECT_ROOT, relativePath);
}

function ensureDir(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    writeJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
  }
  const baseConfig = readJsonFile(CONFIG_PATH);
  const localConfig = fs.existsSync(LOCAL_CONFIG_PATH) ? readJsonFile(LOCAL_CONFIG_PATH) : {};
  return sanitizeConfig(deepMerge(baseConfig, localConfig));
}

function loadState(config) {
  const stateFile = projectPath(config.storage.stateFile);
  if (!fs.existsSync(stateFile)) {
    writeJsonFile(stateFile, DEFAULT_STATE);
  }
  return sanitizeState(readJsonFile(stateFile));
}

function saveState(config, state) {
  writeJsonFile(projectPath(config.storage.stateFile), sanitizeState(state));
}

function logLine(message) {
  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(minValue, maxValue) {
  if (maxValue <= minValue) {
    return minValue;
  }
  return Math.floor(minValue + Math.random() * (maxValue - minValue + 1));
}

function isPositiveLimit(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function remainingDailyLikes(state, config) {
  state.dailyCounter = resetDailyCounter(state.dailyCounter);
  if (!isPositiveLimit(config.limits.maxLikesPerDay)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, config.limits.maxLikesPerDay - state.dailyCounter.likes);
}

function hasReachedDailyLimit(state, config) {
  return isPositiveLimit(config.limits.maxLikesPerDay) && remainingDailyLikes(state, config) <= 0;
}

function hasReachedRunLimit(stats, config) {
  return isPositiveLimit(config.limits.maxLikesPerRun) && stats.liked >= config.limits.maxLikesPerRun;
}

function markProcessed(state, itemKey, status) {
  state.processed[itemKey] = { ts: Date.now(), status: cleanText(status || 'processed') };
}

function wasProcessed(state, itemKey) {
  state.processed = trimProcessedCache(state.processed);
  return Boolean(state.processed[itemKey]);
}

function incrementDailyLikes(state) {
  state.dailyCounter = resetDailyCounter(state.dailyCounter);
  state.dailyCounter.likes += 1;
}

function setLastError(state, message, extra) {
  state.lastError = {
    message: cleanText(message),
    at: Date.now(),
    ...(isObject(extra) ? extra : {}),
  };
}

function clearLastError(state) {
  state.lastError = null;
}

function hasAnyAllowRules(filters) {
  return [filters.allowAuthors, filters.allowTopics, filters.allowKeywords, filters.allowEntryTypes].some(
    (list) => Array.isArray(list) && list.length > 0
  );
}

function matchesAnyToken(sourceValues, filterValues) {
  const sourceSet = new Set(sourceValues.map((item) => normalizeToken(item)).filter(Boolean));
  return filterValues.some((value) => sourceSet.has(normalizeToken(value)));
}

function matchesAnyKeyword(text, keywords) {
  const normalizedText = normalizeToken(text);
  return keywords.some((keyword) => normalizedText.includes(normalizeToken(keyword)));
}

function evaluateItem(item, filters) {
  const denyReasons = [];
  const allowHits = [];
  const itemText = `${item.title || ''} ${item.summary || ''}`;
  const hasAllowRules = hasAnyAllowRules(filters);
  const authorIds = normalizeStringList(item.authorIds);
  const topicIds = normalizeStringList(item.topicIds);
  const entryType = normalizeToken(item.targetType);

  if (filters.onlyUnliked && item.alreadyLiked) {
    denyReasons.push('already-liked');
  }
  if (filters.maxAgeHours && item.publishedAt) {
    const ageHours = (Date.now() - new Date(item.publishedAt).getTime()) / (60 * 60 * 1000);
    if (!Number.isFinite(ageHours) || ageHours > filters.maxAgeHours) {
      denyReasons.push('too-old');
    }
  }
  if (filters.denyAuthors.length && matchesAnyToken(authorIds, filters.denyAuthors)) {
    denyReasons.push('deny-author');
  }
  if (filters.denyTopics.length && matchesAnyToken(topicIds, filters.denyTopics)) {
    denyReasons.push('deny-topic');
  }
  if (filters.denyKeywords.length && matchesAnyKeyword(itemText, filters.denyKeywords)) {
    denyReasons.push('deny-keyword');
  }

  if (hasAllowRules) {
    if (filters.allowAuthors.length && matchesAnyToken(authorIds, filters.allowAuthors)) {
      allowHits.push('author');
    }
    if (filters.allowTopics.length && matchesAnyToken(topicIds, filters.allowTopics)) {
      allowHits.push('topic');
    }
    if (filters.allowKeywords.length && matchesAnyKeyword(itemText, filters.allowKeywords)) {
      allowHits.push('keyword');
    }
    if (filters.allowEntryTypes.length && matchesAnyToken([entryType], filters.allowEntryTypes)) {
      allowHits.push('entry-type');
    }
  } else {
    allowHits.push('default-visible');
  }

  return {
    matched: denyReasons.length === 0 && allowHits.length > 0,
    allowHits,
  };
}

async function launchContext(config, headless) {
  return chromium.launchPersistentContext(projectPath(config.storage.userDataDir), {
    headless,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: {
      width: config.browser.viewport.width,
      height: config.browser.viewport.height,
    },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function getPrimaryPage(context) {
  return context.pages()[0] || context.newPage();
}

async function gotoFeeds(page, config) {
  page.setDefaultTimeout(config.run.navigationTimeoutMs);
  page.setDefaultNavigationTimeout(config.run.navigationTimeoutMs);
  await page.goto(FEEDS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

async function pageDomAction(page, action, payload = {}) {
  return page.evaluate(({ action, payload }) => {
    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }
    function normalizeToken(value) {
      return cleanText(value).toLowerCase();
    }
    function uniqueStrings(values) {
      return Array.from(new Set(values.map((item) => cleanText(item)).filter(Boolean)));
    }
    function pickFirstText(values) {
      for (const value of values) {
        const text = cleanText(value);
        if (text) {
          return text;
        }
      }
      return '';
    }
    function hashString(value) {
      const text = String(value || '');
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }
    function normalizePublishedAt(text) {
      const raw = cleanText(text);
      if (!raw) {
        return null;
      }
      const now = Date.now();
      if (/^\d{13}$/.test(raw)) {
        return new Date(Number(raw)).toISOString();
      }
      if (/^\d{10}$/.test(raw)) {
        return new Date(Number(raw) * 1000).toISOString();
      }
      if (/(刚刚|刚才)/.test(raw)) {
        return new Date(now).toISOString();
      }
      if (/(\d+)\s*分钟前/.test(raw)) {
        return new Date(now - Number(RegExp.$1) * 60 * 1000).toISOString();
      }
      if (/(\d+)\s*小时前/.test(raw)) {
        return new Date(now - Number(RegExp.$1) * 60 * 60 * 1000).toISOString();
      }
      if (/昨天/.test(raw)) {
        return new Date(now - 24 * 60 * 60 * 1000).toISOString();
      }
      const parsed = Date.parse(raw.replace(/[./]/g, '-'));
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    }
    function parseEntryPath(urlOrPath) {
      try {
        const url = new URL(urlOrPath, location.origin);
        const match = url.pathname.match(
          /^\/(articles|videos|radios|talks|discussions|originals|timelines|albums|collections|products|games|films|external_links|external-links)\/([^/?#]+)/i
        );
        if (!match) {
          return null;
        }
        return {
          targetType: normalizeToken(match[1]).replace(/_/g, '-'),
          targetId: String(match[2]),
          url: url.toString(),
        };
      } catch (error) {
        return null;
      }
    }
    function findFeedContainer(button) {
      return (
        button.closest(
          '.talk, .original-feed, .original, .am_card, [data-feed-id], [data-entry-id], article, li, section, .feedItem, .flowCard'
        ) || button.closest('div')
      );
    }
    function findPrimaryEntryLink(container) {
      if (!container) {
        return null;
      }
      return Array.from(container.querySelectorAll('a[href]')).find((link) => Boolean(parseEntryPath(link.href))) || null;
    }
    function inferEntryType(container) {
      const className = normalizeToken(container && container.className ? container.className : '');
      if (className.includes('original')) return 'originals';
      if (className.includes('discussion')) return 'discussions';
      if (className.includes('video')) return 'videos';
      if (className.includes('radio')) return 'radios';
      if (className.includes('timeline')) return 'timelines';
      if (className.includes('article')) return 'articles';
      if (className.includes('talk')) return 'talks';
      return 'dom';
    }
    function findLikeButton(container) {
      if (!container) {
        return null;
      }
      return (
        container.querySelector('.o_vote-up') ||
        container.querySelector('[class*="o_vote-up"]') ||
        container.querySelector('[aria-label*="喜欢"]') ||
        container.querySelector('[data-action*="like"]') ||
        null
      );
    }
    function isLikeButtonActive(button) {
      if (!button) {
        return false;
      }
      return /\bis_active\b/.test(button.className || '') ||
        button.getAttribute('aria-pressed') === 'true' ||
        (button.dataset && button.dataset.active === 'true');
    }
    function hasLoginPrompt() {
      return Array.from(document.querySelectorAll('button, p, h1, div')).some((node) => {
        const text = cleanText(node.textContent || '');
        return text.includes('需登录后才可显示内容') || text.includes('登录机核');
      });
    }
    function collect() {
      const scope =
        document.querySelector('.pageContainer .flowLayout_main') ||
        document.querySelector('.flowLayout_main') ||
        document.querySelector('main') ||
        document.body;
      const buttons = Array.from(
        scope.querySelectorAll('a.o_vote-up[role="button"], .o_vote-up[role="button"], a.o_vote-up, .o_vote-up')
      ).filter((button) => !button.closest('.flowLayout_side, aside, footer'));
      const seen = new Set();
      const records = [];
      buttons.forEach((button) => {
        const container = findFeedContainer(button);
        const entryLink = findPrimaryEntryLink(container);
        const parsed = entryLink ? parseEntryPath(entryLink.href) : null;
        const title = pickFirstText([
          entryLink && entryLink.textContent,
          container && container.querySelector('h1, h2, h3, h4') && container.querySelector('h1, h2, h3, h4').textContent,
          container && container.querySelector('[class*="title"]') && container.querySelector('[class*="title"]').textContent,
          container && container.querySelector('p') && container.querySelector('p').textContent,
        ]);
        const summary = pickFirstText([
          container && container.querySelector('[class*="summary"]') && container.querySelector('[class*="summary"]').textContent,
          container && container.querySelector('[class*="desc"]') && container.querySelector('[class*="desc"]').textContent,
        ]);
        const publishedAt = normalizePublishedAt(
          (container && container.querySelector('time[datetime]') && container.querySelector('time[datetime]').getAttribute('datetime')) ||
            (container && container.querySelector('[data-time]') && container.querySelector('[data-time]').getAttribute('data-time')) ||
            (container && container.textContent) ||
            ''
        );
        const itemKey = parsed
          ? `${parsed.targetType}:${parsed.targetId}`
          : `dom:${hashString([title, summary, publishedAt, cleanText(container && container.className)].join('|'))}`;
        if (seen.has(itemKey)) {
          return;
        }
        seen.add(itemKey);
        records.push({
          itemKey,
          targetType: parsed ? parsed.targetType : inferEntryType(container),
          targetId: parsed ? parsed.targetId : itemKey.replace(/^dom:/, ''),
          alreadyLiked: isLikeButtonActive(button),
          authorIds: uniqueStrings(
            Array.from(container && container.querySelectorAll('a[href*="/users/"]') ? container.querySelectorAll('a[href*="/users/"]') : [])
              .map((link) => {
                const href = link.getAttribute('href') || '';
                const match = href.match(/\/users\/(\d+)/);
                return match ? match[1] : '';
              })
              .filter(Boolean)
          ),
          topicIds: uniqueStrings(
            Array.from(container && container.querySelectorAll('a[href*="/topics/"]') ? container.querySelectorAll('a[href*="/topics/"]') : []).flatMap(
              (link) => {
                const href = link.getAttribute('href') || '';
                const match = href.match(/\/topics\/([^/?#]+)/);
                const values = [];
                if (match) values.push(match[1]);
                const text = cleanText(link.textContent || '');
                if (text) values.push(text);
                return values;
              }
            )
          ),
          title: title || itemKey,
          summary,
          url: (parsed && parsed.url) || (entryLink && entryLink.href) || location.href,
          publishedAt,
          button,
        });
      });
      return records;
    }

    if (action === 'loginPrompt') return hasLoginPrompt();
    if (action === 'extract') return collect().map(({ button, ...item }) => item);
    if (action === 'isLiked') {
      const target = collect().find((item) => item.itemKey === payload.itemKey);
      return target ? target.alreadyLiked : false;
    }
    if (action === 'click') {
      const target = collect().find((item) => item.itemKey === payload.itemKey);
      if (!target || !target.button) return { ok: false, reason: 'not-found' };
      if (isLikeButtonActive(target.button)) return { ok: true, alreadyLiked: true };
      if (typeof target.button.click === 'function') {
        target.button.click();
      } else {
        const MouseEventCtor = (target.button.ownerDocument && target.button.ownerDocument.defaultView
          ? target.button.ownerDocument.defaultView.MouseEvent
          : MouseEvent);
        target.button.dispatchEvent(new MouseEventCtor('click', { bubbles: true, cancelable: true, composed: true }));
      }
      return { ok: true, alreadyLiked: false };
    }
    throw new Error(`unsupported action: ${action}`);
  }, { action, payload });
}

async function waitForFeed(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pageDomAction(page, 'loginPrompt')) {
      return { loginRequired: true, items: [] };
    }
    const items = await pageDomAction(page, 'extract');
    if (items.length > 0) {
      return { loginRequired: false, items };
    }
    await page.waitForTimeout(500);
  }
  return {
    loginRequired: await pageDomAction(page, 'loginPrompt'),
    items: await pageDomAction(page, 'extract'),
  };
}

function createVoteTracker(page) {
  const records = [];
  const handler = (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch (error) {
      return;
    }
    if (!/\/votes(?:\/|$|\.json)/i.test(url.pathname) && !/vote/i.test(url.pathname)) {
      return;
    }
    records.push({ status: response.status(), at: Date.now() });
    if (records.length > 200) {
      records.shift();
    }
  };
  page.on('response', handler);
  return {
    blockedSince(timestamp) {
      return records.find((item) => item.at >= timestamp && [401, 403, 429].includes(item.status)) || null;
    },
    dispose() {
      page.off('response', handler);
    },
  };
}

async function clickLike(page, item, tracker, config) {
  const startedAt = Date.now();
  const clicked = await pageDomAction(page, 'click', { itemKey: item.itemKey });
  if (!clicked || !clicked.ok) {
    throw new Error('没有找到可点击的点赞按钮');
  }
  if (clicked.alreadyLiked) {
    return { ok: true, mode: 'dom-already-liked' };
  }
  const deadline = Date.now() + config.run.clickTimeoutMs;
  while (Date.now() < deadline) {
    const blocked = tracker.blockedSince(startedAt);
    if (blocked) {
      throw new BlockedRequestError(blocked.status, `vote request blocked with HTTP ${blocked.status}`);
    }
    if (await pageDomAction(page, 'isLiked', { itemKey: item.itemKey })) {
      return { ok: true, mode: 'dom' };
    }
    await page.waitForTimeout(200);
  }
  const blocked = tracker.blockedSince(startedAt);
  if (blocked) {
    throw new BlockedRequestError(blocked.status, `vote request blocked with HTTP ${blocked.status}`);
  }
  throw new Error('点击后点赞按钮没有进入激活状态');
}

async function captureErrorScreenshot(page, config) {
  if (!page || page.isClosed()) {
    return;
  }
  const screenshotPath = projectPath(config.storage.errorScreenshotFile);
  ensureDir(path.dirname(screenshotPath));
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
}

async function runLogin(config) {
  const context = await launchContext(config, false);
  try {
    const page = await getPrimaryPage(context);
    await gotoFeeds(page, config);
    logLine('浏览器已打开，请在窗口里完成 GCORES 登录。');
    logLine('登录成功后回到终端按 Enter，我会把登录态保存在本地。');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('');
    rl.close();
    await gotoFeeds(page, config);
    await page.waitForTimeout(1500);
    if (await pageDomAction(page, 'loginPrompt')) {
      throw new Error('仍然检测到登录提示，请确认浏览器里已经登录成功。');
    }
    logLine(`登录态已保存到 ${projectPath(config.storage.userDataDir)}`);
  } finally {
    await context.close();
  }
}

async function runOnce(config) {
  const state = loadState(config);
  state.dailyCounter = resetDailyCounter(state.dailyCounter);
  if (state.cooldown.blockedUntil > Date.now()) {
    logLine(`仍在冷却期，跳过本轮。冷却到 ${new Date(state.cooldown.blockedUntil).toLocaleString('zh-CN')}`);
    saveState(config, state);
    return;
  }

  const stats = { scanned: 0, matched: 0, liked: 0, skipped: 0, consecutiveErrors: 0 };
  const matchedPreview = [];
  let context;
  let page;
  let tracker;

  try {
    context = await launchContext(config, config.headless);
    page = await getPrimaryPage(context);
    tracker = createVoteTracker(page);
    await gotoFeeds(page, config);

    const ready = await waitForFeed(page, config.run.waitForFeedMs);
    if (ready.loginRequired) {
      throw new Error('检测到登录失效，请先运行 npm run gcores:login');
    }
    if (!ready.items.length) {
      throw new Error('当前页没有发现可处理的点赞按钮，请检查页面结构是否变化。');
    }

    logLine(`本轮发现 ${ready.items.length} 个当前页点赞按钮。`);

    for (const item of ready.items) {
      stats.scanned += 1;
      if (wasProcessed(state, item.itemKey)) {
        stats.skipped += 1;
        continue;
      }
      if (config.filters.onlyUnliked && item.alreadyLiked) {
        markProcessed(state, item.itemKey, 'already-liked');
        stats.skipped += 1;
        continue;
      }

      const evaluation = evaluateItem(item, config.filters);
      if (!evaluation.matched) {
        stats.skipped += 1;
        continue;
      }

      stats.matched += 1;
      matchedPreview.push({
        key: item.itemKey,
        title: item.title,
        url: item.url,
        reasons: evaluation.allowHits,
      });

      if (hasReachedDailyLimit(state, config) || hasReachedRunLimit(stats, config)) {
        break;
      }

      try {
        const result = await clickLike(page, item, tracker, config);
        if (result && result.ok) {
          stats.liked += 1;
          stats.consecutiveErrors = 0;
          markProcessed(state, item.itemKey, result.mode || 'liked');
          incrementDailyLikes(state);
          logLine(`已点赞：${item.title}`);
        }
      } catch (error) {
        if (error instanceof BlockedRequestError) {
          state.cooldown.blockedUntil = Date.now() + config.timing.cooldownAfterBlockMs;
          setLastError(state, `触发风控，进入冷却期（HTTP ${error.status}）`, { status: error.status });
          throw error;
        }
        stats.consecutiveErrors += 1;
        setLastError(state, error.message || '点赞失败', { itemKey: item.itemKey, title: item.title });
        logLine(`点赞失败：${item.title} | ${error.message}`);
        if (stats.consecutiveErrors >= config.run.maxConsecutiveErrors) {
          break;
        }
      }

      await sleep(randomBetween(...config.timing.actionDelayMsRange));
    }

    clearLastError(state);
    state.lastRun = {
      createdAt: new Date().toISOString(),
      stats,
      items: matchedPreview.slice(0, 20),
    };
    saveState(config, state);
    logLine(
      `本轮完成：扫描 ${stats.scanned}，命中 ${stats.matched}，点赞 ${stats.liked}，跳过 ${stats.skipped}，今日累计 ${state.dailyCounter.likes}。`
    );
  } catch (error) {
    if (!(error instanceof BlockedRequestError)) {
      setLastError(state, error.message || 'unexpected run error');
    }
    state.lastRun = {
      createdAt: new Date().toISOString(),
      stats,
      items: matchedPreview.slice(0, 20),
    };
    if (page) {
      await captureErrorScreenshot(page, config);
    }
    saveState(config, state);
    if (error instanceof BlockedRequestError) {
      logLine(`检测到风控状态码 ${error.status}，已进入冷却期。`);
      return;
    }
    throw error;
  } finally {
    if (tracker) {
      tracker.dispose();
    }
    if (context) {
      await context.close();
    }
  }
}

function printUsage() {
  console.log('Usage: node scripts/gcores-playwright.js <login|run>');
}

async function main() {
  const command = process.argv[2];
  if (!command || ['-h', '--help', 'help'].includes(command)) {
    printUsage();
    return;
  }

  const config = loadConfig();
  if (command === 'login') {
    await runLogin(config);
    return;
  }
  if (command === 'run') {
    await runOnce(config);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(cleanText(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});

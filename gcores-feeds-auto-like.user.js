// ==UserScript==
// @name         GCORES 动态自动点赞助手
// @namespace    https://www.gcores.com/
// @version      0.1.2
// @description  机核动态页自动点赞助手，支持规则筛选、试运行、限速、请求捕获和 DOM 兜底。
// @match        https://www.gcores.com/feeds*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_notification
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_NAME = 'GCORES 动态自动点赞助手';
  const SCRIPT_VERSION = '0.1.2';
  const LEGACY_LIMIT_DEFAULTS = {
    maxLikesPerRun: 10,
    maxLikesPerDay: 30,
    maxAgeHours: 72,
  };
  const LEGACY_DEFAULT_ALLOW_ENTRY_TYPES = [
    'articles',
    'videos',
    'radios',
    'talks',
    'discussions',
    'originals',
    'timelines',
  ];
  const PROCESSED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const AUTO_HEADER_NAME = 'x-gcores-auto-like';
  const BUTTON_TEXT = {
    start: '开始',
    pause: '暂停',
    stop: '停止',
    dryRun: '试运行',
    edit: '编辑配置',
    export: '导出状态',
    clear: '清空缓存',
  };
  const STATUS_TEXT = {
    idle: '空闲',
    running: '运行中',
    waiting_refresh: '等待刷新',
    paused: '已暂停',
    stopped: '已停止',
    cooldown: '冷却中',
    login_required: '需要登录',
    not_feeds: '不在动态页',
  };
  const SOURCE_MODE_TEXT = {
    api: '接口',
    'api-sample': '接口样本',
    dom: '页面按钮',
    none: '未校准',
  };
  const FILTER_LABELS = {
    allowAuthors: '允许作者',
    allowTopics: '允许话题',
    allowKeywords: '允许关键词',
    allowEntryTypes: '允许内容类型',
    denyAuthors: '屏蔽作者',
    denyTopics: '屏蔽话题',
    denyKeywords: '屏蔽关键词',
  };

  const KNOWN_ENTRY_TYPES = [
    'articles',
    'videos',
    'radios',
    'talks',
    'discussions',
    'originals',
    'timelines',
    'portfolios',
    'albums',
    'collections',
    'products',
    'games',
    'films',
    'external-links',
  ];

  const STORAGE_KEYS = {
    config: 'gcores-auto-like:config',
    persisted: 'gcores-auto-like:persisted',
  };
  const SESSION_KEYS = {
    loopEnabled: 'gcores-auto-like:loop-enabled',
    nextRefreshAt: 'gcores-auto-like:next-refresh-at',
  };

  const DEFAULT_CONFIG = {
    autoStart: false,
    dryRun: true,
    debug: false,
    limits: {
      maxLikesPerRun: 0,
      maxLikesPerDay: 0,
      maxPagesPerRun: 5,
      maxConsecutiveErrors: 3,
    },
    timing: {
      actionDelayMsRange: [2500, 7000],
      pageDelayMsRange: [4000, 9000],
      cooldownAfterBlockMs: 60 * 60 * 1000,
      refreshIntervalMs: 5 * 60 * 1000,
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
    cooldown: {
      blockedUntil: 0,
    },
  };

  const DEFAULT_PERSISTED = {
    processed: {},
    dailyCounter: {
      date: '',
      likes: 0,
    },
    lastError: null,
    lastDryRun: null,
    calibration: {
      feedRequest: null,
      feedSample: null,
      voteTemplates: {
        post: null,
        patch: null,
        delete: null,
      },
    },
  };

  const runtime = {
    config: null,
    persisted: null,
    requestContext: {
      csrfToken: null,
      sameOrigin: true,
    },
    currentUserId: null,
    ui: null,
    domButtons: new Map(),
    runner: null,
    menuReady: false,
  };

  class BlockedRequestError extends Error {
    constructor(status, message) {
      super(message || `请求被拦截，状态码 ${status}`);
      this.name = 'BlockedRequestError';
      this.status = status;
    }
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
    return cleanText(String(value || '')).toLowerCase();
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

  function isPositiveLimit(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0;
  }

  function formatLimitValue(value) {
    return isPositiveLimit(value) ? String(value) : '不限';
  }

  function equalNormalizedLists(left, right) {
    const leftList = normalizeStringList(left).slice().sort();
    const rightList = normalizeStringList(right).slice().sort();
    if (leftList.length !== rightList.length) {
      return false;
    }
    return leftList.every((item, index) => item === rightList[index]);
  }

  function sanitizeRange(value, fallback) {
    const range = Array.isArray(value) ? value.slice(0, 2) : fallback.slice();
    const minValue = clampNumber(range[0], fallback[0], 0);
    const maxValue = clampNumber(range[1], fallback[1], minValue);
    return [Math.min(minValue, maxValue), Math.max(minValue, maxValue)];
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
      return {
        date,
        likes: 0,
      };
    }
    return {
      date,
      likes: clampNumber(counter.likes, 0, 0),
    };
  }

  function trimProcessedCache(processed, now = Date.now()) {
    const next = {};
    if (!isObject(processed)) {
      return next;
    }
    Object.keys(processed).forEach((key) => {
      const entry = processed[key];
      if (!entry) {
        return;
      }
      const ts = clampNumber(entry.ts || entry.timestamp || entry, 0, 0);
      if (!ts || now - ts > PROCESSED_CACHE_TTL_MS) {
        return;
      }
      next[key] = {
        ts,
        status: cleanText(entry.status || 'processed'),
      };
    });
    return next;
  }

  function sanitizeConfig(config) {
    const merged = deepMerge(DEFAULT_CONFIG, isObject(config) ? config : {});
    merged.autoStart = Boolean(merged.autoStart);
    merged.dryRun = Boolean(merged.dryRun);
    merged.debug = Boolean(merged.debug);
    merged.limits.maxLikesPerRun = clampNumber(merged.limits.maxLikesPerRun, DEFAULT_CONFIG.limits.maxLikesPerRun, 0);
    merged.limits.maxLikesPerDay = clampNumber(merged.limits.maxLikesPerDay, DEFAULT_CONFIG.limits.maxLikesPerDay, 0);
    merged.limits.maxPagesPerRun = clampNumber(merged.limits.maxPagesPerRun, DEFAULT_CONFIG.limits.maxPagesPerRun, 1);
    merged.limits.maxConsecutiveErrors = clampNumber(
      merged.limits.maxConsecutiveErrors,
      DEFAULT_CONFIG.limits.maxConsecutiveErrors,
      1
    );
    merged.timing.actionDelayMsRange = sanitizeRange(
      merged.timing.actionDelayMsRange,
      DEFAULT_CONFIG.timing.actionDelayMsRange
    );
    merged.timing.pageDelayMsRange = sanitizeRange(
      merged.timing.pageDelayMsRange,
      DEFAULT_CONFIG.timing.pageDelayMsRange
    );
    merged.timing.cooldownAfterBlockMs = clampNumber(
      merged.timing.cooldownAfterBlockMs,
      DEFAULT_CONFIG.timing.cooldownAfterBlockMs,
      1000
    );
    merged.timing.refreshIntervalMs = clampNumber(
      merged.timing.refreshIntervalMs,
      DEFAULT_CONFIG.timing.refreshIntervalMs,
      60 * 1000
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
    merged.cooldown.blockedUntil = clampNumber(merged.cooldown.blockedUntil, 0, 0);
    return merged;
  }

  function migrateConfigForCurrentPageMode(config) {
    const next = sanitizeConfig(config);
    let changed = false;

    if (next.limits.maxLikesPerRun === LEGACY_LIMIT_DEFAULTS.maxLikesPerRun) {
      next.limits.maxLikesPerRun = 0;
      changed = true;
    }
    if (next.limits.maxLikesPerDay === LEGACY_LIMIT_DEFAULTS.maxLikesPerDay) {
      next.limits.maxLikesPerDay = 0;
      changed = true;
    }
    if (next.filters.maxAgeHours === LEGACY_LIMIT_DEFAULTS.maxAgeHours) {
      next.filters.maxAgeHours = 0;
      changed = true;
    }
    if (equalNormalizedLists(next.filters.allowEntryTypes, LEGACY_DEFAULT_ALLOW_ENTRY_TYPES)) {
      next.filters.allowEntryTypes = [];
      changed = true;
    }

    return {
      config: next,
      changed,
    };
  }

  function sanitizePersisted(persisted) {
    const merged = deepMerge(DEFAULT_PERSISTED, isObject(persisted) ? persisted : {});
    merged.processed = trimProcessedCache(merged.processed);
    merged.dailyCounter = resetDailyCounter(merged.dailyCounter);
    merged.lastError = merged.lastError && typeof merged.lastError.message === 'string' ? merged.lastError : null;
    merged.lastDryRun = merged.lastDryRun && typeof merged.lastDryRun === 'object' ? merged.lastDryRun : null;
    merged.calibration = deepMerge(DEFAULT_PERSISTED.calibration, isObject(merged.calibration) ? merged.calibration : {});
    return merged;
  }

  function safeCall(fn, fallbackValue) {
    try {
      return fn();
    } catch (error) {
      console.warn(`${SCRIPT_NAME}: safeCall failed`, error);
      return fallbackValue;
    }
  }

  function getSessionValue(key, fallbackValue) {
    return safeCall(() => window.sessionStorage.getItem(key), fallbackValue);
  }

  function setSessionValue(key, value) {
    safeCall(() => window.sessionStorage.setItem(key, value));
  }

  function removeSessionValue(key) {
    safeCall(() => window.sessionStorage.removeItem(key));
  }

  function isLoopEnabled() {
    return getSessionValue(SESSION_KEYS.loopEnabled, '0') === '1';
  }

  function setLoopEnabled(enabled) {
    if (enabled) {
      setSessionValue(SESSION_KEYS.loopEnabled, '1');
      return;
    }
    removeSessionValue(SESSION_KEYS.loopEnabled);
  }

  function getScheduledRefreshAt() {
    const raw = getSessionValue(SESSION_KEYS.nextRefreshAt, '0');
    return clampNumber(raw, 0, 0);
  }

  function setScheduledRefreshAt(timestamp) {
    if (timestamp > 0) {
      setSessionValue(SESSION_KEYS.nextRefreshAt, String(timestamp));
      return;
    }
    removeSessionValue(SESSION_KEYS.nextRefreshAt);
  }

  function loadConfig() {
    const raw = safeCall(() => GM_getValue(STORAGE_KEYS.config, DEFAULT_CONFIG), DEFAULT_CONFIG);
    return sanitizeConfig(raw);
  }

  function saveConfig(config) {
    runtime.config = sanitizeConfig(config);
    safeCall(() => GM_setValue(STORAGE_KEYS.config, runtime.config));
    window.GM_config = deepClone(runtime.config);
    updateUi();
  }

  function loadPersisted() {
    const raw = safeCall(() => GM_getValue(STORAGE_KEYS.persisted, DEFAULT_PERSISTED), DEFAULT_PERSISTED);
    return sanitizePersisted(raw);
  }

  function savePersisted() {
    runtime.persisted = sanitizePersisted(runtime.persisted);
    safeCall(() => GM_setValue(STORAGE_KEYS.persisted, runtime.persisted));
    updateUi();
  }

  function randomBetween(minValue, maxValue) {
    if (maxValue <= minValue) {
      return minValue;
    }
    return Math.floor(minValue + Math.random() * (maxValue - minValue + 1));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitWithControl(ms, runner) {
    let remaining = ms;
    while (remaining > 0) {
      if (runner.shouldStop) {
        return false;
      }
      while (runner.status === 'paused') {
        if (runner.shouldStop) {
          return false;
        }
        await sleep(200);
      }
      const chunk = Math.min(250, remaining);
      await sleep(chunk);
      remaining -= chunk;
    }
    return !runner.shouldStop;
  }

  async function waitFor(predicate, timeoutMs, intervalMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) {
        return true;
      }
      await sleep(intervalMs);
    }
    return false;
  }

  function logDebug(...args) {
    if (runtime.config && runtime.config.debug) {
      console.debug(`${SCRIPT_NAME}:`, ...args);
    }
  }

  function getBlockedUntil() {
    return clampNumber(runtime.config.cooldown.blockedUntil, 0, 0);
  }

  function isCooldownActive() {
    return getBlockedUntil() > Date.now();
  }

  function setLastError(message, extra) {
    runtime.persisted.lastError = {
      message: cleanText(message),
      at: Date.now(),
      ...(isObject(extra) ? extra : {}),
    };
    savePersisted();
  }

  function clearLastError() {
    runtime.persisted.lastError = null;
    savePersisted();
  }

  function notify(message) {
    safeCall(() => {
      if (typeof GM_notification === 'function') {
        GM_notification({
          title: SCRIPT_NAME,
          text: cleanText(message),
          timeout: 4000,
        });
      }
    });
  }

  function setBlockedCooldown(status) {
    runtime.config.cooldown.blockedUntil = Date.now() + runtime.config.timing.cooldownAfterBlockMs;
    saveConfig(runtime.config);
    setLastError(`触发风控，已进入冷却期（HTTP ${status}）`, { status });
  }

  function buildItemKey(item) {
    if (item?.updateId) {
      return String(item.updateId);
    }
    return `${item.targetType}:${item.targetId}`;
  }

  function normalizePathSegment(segment) {
    return cleanText(segment).toLowerCase().replace(/_/g, '-');
  }

  function parseEntryPath(urlOrPath) {
    try {
      const url = new URL(urlOrPath, location.origin);
      const match = url.pathname.match(/^\/(articles|videos|radios|talks|discussions|originals|timelines|albums|collections|products|games|films|external_links|external-links)\/([^/?#]+)/i);
      if (!match) {
        return null;
      }
      return {
        targetType: normalizePathSegment(match[1]),
        targetId: String(match[2]),
        url: url.toString(),
      };
    } catch (error) {
      return null;
    }
  }

  function buildEntryUrl(type, id) {
    return type && id ? `${location.origin}/${type}/${id}` : '';
  }

  function isFeedsPage() {
    return /^\/feeds(?:\/|$)/.test(location.pathname);
  }

  function uniqueStrings(values) {
    return Array.from(new Set(values.map((item) => cleanText(item)).filter(Boolean)));
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

  function findFeedContainer(anchor) {
    return (
      anchor.closest(
        '.talk, .original-feed, .original, .am_card, [data-feed-id], [data-entry-id], article, li, section, .feedItem, .flowCard'
      ) ||
      anchor.closest('div')
    );
  }

  function inferEntryTypeFromContainer(container) {
    const className = normalizeToken(container?.className || '');
    if (!className) {
      return 'dom';
    }
    if (className.includes('original')) {
      return 'originals';
    }
    if (className.includes('discussion')) {
      return 'discussions';
    }
    if (className.includes('video')) {
      return 'videos';
    }
    if (className.includes('radio')) {
      return 'radios';
    }
    if (className.includes('timeline')) {
      return 'timelines';
    }
    if (className.includes('article')) {
      return 'articles';
    }
    if (className.includes('talk')) {
      return 'talks';
    }
    return 'dom';
  }

  function findPrimaryEntryLink(container) {
    if (!container) {
      return null;
    }
    const links = Array.from(container.querySelectorAll('a[href]'));
    return links.find((link) => Boolean(parseEntryPath(link.href))) || null;
  }

  function buildDomItemIdentity(container, parsed, title, summary, publishedAt) {
    if (parsed?.targetType && parsed?.targetId) {
      return {
        itemKey: `${parsed.targetType}:${parsed.targetId}`,
        targetType: parsed.targetType,
        targetId: parsed.targetId,
      };
    }

    const authorText = pickFirstText([
      container?.querySelector('a[href*="/users/"]')?.textContent,
      container?.querySelector('[class*="author"]')?.textContent,
    ]);
    const fingerprint = [
      authorText,
      publishedAt || '',
      title || '',
      summary || '',
      cleanText(container?.className || ''),
    ].join('|');
    const targetId = hashString(fingerprint);
    return {
      itemKey: `dom:${targetId}`,
      targetType: inferEntryTypeFromContainer(container),
      targetId,
    };
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

  function pickSummary(container, title) {
    if (!container) {
      return '';
    }
    const candidate = pickFirstText([
      container.querySelector('p')?.textContent,
      container.querySelector('[class*="summary"]')?.textContent,
      container.querySelector('[class*="desc"]')?.textContent,
      container.textContent,
    ]);
    if (title && candidate.startsWith(title)) {
      return cleanText(candidate.slice(title.length));
    }
    return candidate;
  }

  function inferPublishedAt(container) {
    if (!container) {
      return null;
    }
    const now = Date.now();
    const timeNode =
      container.querySelector('time[datetime]') ||
      container.querySelector('[datetime]') ||
      container.querySelector('[data-time]');
    if (timeNode) {
      return normalizePublishedAt(
        timeNode.getAttribute('datetime') ||
          timeNode.getAttribute('data-time') ||
          cleanText(timeNode.textContent || ''),
        now
      );
    }
    const text = cleanText(container.textContent || '');
    const directMatch =
      text.match(/\d{4}[./-]\d{1,2}[./-]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/) ||
      text.match(/\d{1,2}[./-]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/);
    if (directMatch) {
      return normalizePublishedAt(directMatch[0], now);
    }
    const relativeMatch =
      text.match(/(?:刚刚|刚才|今天|昨天|前天|\d+\s*(?:秒钟?|分钟?|小时|天|周|星期|个月)\s*前)/) || null;
    return relativeMatch ? normalizePublishedAt(relativeMatch[0], now) : null;
  }

  function normalizePublishedAt(value, now = Date.now()) {
    const text = cleanText(value);
    if (!text) {
      return null;
    }

    if (/^\d{13}$/.test(text)) {
      return new Date(Number(text)).toISOString();
    }
    if (/^\d{10}$/.test(text)) {
      return new Date(Number(text) * 1000).toISOString();
    }

    const relativeTs = parseRelativePublishedAt(text, now);
    if (relativeTs) {
      return new Date(relativeTs).toISOString();
    }

    const absoluteTs = parseAbsolutePublishedAt(text, now);
    if (absoluteTs) {
      return new Date(absoluteTs).toISOString();
    }

    const nativeTs = Date.parse(text);
    return Number.isFinite(nativeTs) ? new Date(nativeTs).toISOString() : null;
  }

  function parseRelativePublishedAt(text, now = Date.now()) {
    const normalized = cleanText(text);
    if (!normalized) {
      return null;
    }
    if (/(刚刚|刚才)/.test(normalized)) {
      return now;
    }
    if (/今天/.test(normalized)) {
      return now;
    }
    if (/昨天/.test(normalized)) {
      return now - 24 * 60 * 60 * 1000;
    }
    if (/前天/.test(normalized)) {
      return now - 48 * 60 * 60 * 1000;
    }

    const match = normalized.match(/(\d+)\s*(秒钟?|分钟?|小时|天|周|星期|个月)\s*前/);
    if (!match) {
      return null;
    }

    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || amount < 0) {
      return null;
    }

    const unitMsMap = {
      秒: 1000,
      秒钟: 1000,
      分钟: 60 * 1000,
      小时: 60 * 60 * 1000,
      天: 24 * 60 * 60 * 1000,
      周: 7 * 24 * 60 * 60 * 1000,
      星期: 7 * 24 * 60 * 60 * 1000,
      个月: 30 * 24 * 60 * 60 * 1000,
    };

    const unitMs = unitMsMap[unit];
    return unitMs ? now - amount * unitMs : null;
  }

  function parseAbsolutePublishedAt(text, now = Date.now()) {
    const normalized = cleanText(text).replace(/[./]/g, '-');
    if (!normalized) {
      return null;
    }

    const fullDateMatch = normalized.match(
      /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
    );
    if (fullDateMatch) {
      const [, year, month, day, hour = '0', minute = '0', second = '0'] = fullDateMatch;
      return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      ).getTime();
    }

    const shortDateMatch = normalized.match(/^(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (shortDateMatch) {
      const currentYear = new Date(now).getFullYear();
      const [, month, day, hour = '0', minute = '0', second = '0'] = shortDateMatch;
      return new Date(
        currentYear,
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      ).getTime();
    }

    return null;
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
    if (/\bis_active\b/.test(button.className || '')) {
      return true;
    }
    if (button.getAttribute('aria-pressed') === 'true') {
      return true;
    }
    return button.dataset?.active === 'true';
  }

  function extractDomFeedItems() {
    const scope =
      document.querySelector('.pageContainer .flowLayout_main') ||
      document.querySelector('.flowLayout_main') ||
      document.querySelector('main') ||
      document.body;
    const buttons = Array.from(
      scope.querySelectorAll('a.o_vote-up[role="button"], .o_vote-up[role="button"], a.o_vote-up, .o_vote-up')
    ).filter(
      (button) => !button.closest('.flowLayout_side, aside, footer')
    );
    const items = [];
    runtime.domButtons.clear();
    const seen = new Set();
    buttons.forEach((button) => {
      const container = findFeedContainer(button);
      const entryLink = findPrimaryEntryLink(container);
      const parsed = entryLink ? parseEntryPath(entryLink.href) : null;
      const title = pickFirstText([
        entryLink?.textContent,
        container?.querySelector('h1, h2, h3, h4')?.textContent,
        container?.querySelector('[class*="title"]')?.textContent,
        container?.querySelector('[class*="paragraph"]')?.textContent,
        container?.querySelector('p')?.textContent,
      ]);
      const summary = pickSummary(container, title);
      const publishedAt = inferPublishedAt(container);
      const identity = buildDomItemIdentity(container, parsed, title, summary, publishedAt);
      const itemKey = identity.itemKey;
      if (seen.has(itemKey)) {
        return;
      }
      seen.add(itemKey);
      const authorIds = uniqueStrings(
        Array.from(container?.querySelectorAll('a[href*="/users/"]') || [])
          .map((link) => link.getAttribute('href').match(/\/users\/(\d+)/)?.[1])
          .filter(Boolean)
      );
      const topicIds = uniqueStrings(
        Array.from(container?.querySelectorAll('a[href*="/topics/"]') || []).flatMap((link) => {
          const href = link.getAttribute('href') || '';
          const match = href.match(/\/topics\/([^/?#]+)/);
          const values = [];
          if (match) {
            values.push(match[1]);
          }
          const text = cleanText(link.textContent || '');
          if (text) {
            values.push(text);
          }
          return values;
        })
      );
      const likeButton = findLikeButton(container);
      if (likeButton) {
        runtime.domButtons.set(itemKey, likeButton);
      }
      items.push({
        updateId: itemKey,
        targetType: identity.targetType,
        targetId: identity.targetId,
        voteId: null,
        alreadyLiked: isLikeButtonActive(likeButton),
        authorIds,
        topicIds,
        title: title || `${identity.targetType}/${identity.targetId}`,
        summary,
        url: parsed?.url || entryLink?.href || location.href,
        publishedAt,
      });
    });
    return items;
  }

  function detectLoginState() {
    const loginPrompt = document.querySelector('.emptyBlock');
    if (loginPrompt) {
      const text = cleanText(loginPrompt.textContent || '');
      if (text.includes('需登录后才可显示内容') || text.includes('登录机核')) {
        return { loggedIn: false, reason: 'login-prompt' };
      }
    }
    const items = extractDomFeedItems();
    if (items.length > 0) {
      return { loggedIn: true, reason: 'dom-items-detected' };
    }
    const hasLoginPrompt = Array.from(document.querySelectorAll('button, p, h1, div')).some((node) => {
      const text = cleanText(node.textContent || '');
      return text.includes('需登录后才可显示内容') || text.includes('登录机核');
    });
    if (hasLoginPrompt) {
      return { loggedIn: false, reason: 'login-prompt' };
    }
    return { loggedIn: true, reason: 'no-login-prompt' };
  }

  function detectCurrentUserId() {
    const voteTemplate = runtime.persisted?.calibration?.voteTemplates?.post;
    if (voteTemplate?.sample?.userId) {
      return String(voteTemplate.sample.userId);
    }
    const candidates = [];
    Array.from(document.querySelectorAll('a[href*="/users/"]')).forEach((anchor) => {
      const match = anchor.getAttribute('href').match(/\/users\/(\d+)/);
      if (!match) {
        return;
      }
      let score = 0;
      if (anchor.closest('nav, header, .gnav, .navLayout')) {
        score += 10;
      }
      if (anchor.querySelector('img') || anchor.closest('[class*="avatar"]')) {
        score += 5;
      }
      const rect = typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null;
      if (rect && rect.top >= 0 && rect.top < 300) {
        score += 3;
      }
      candidates.push({ id: match[1], score });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.id || null;
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
    const hasAllowRules = hasAnyAllowRules(filters);
    const now = Date.now();
    const itemText = `${item.title || ''} ${item.summary || ''}`;
    const normalizedType = normalizeToken(item.targetType);
    const authorIds = normalizeStringList(item.authorIds);
    const topicIds = normalizeStringList(item.topicIds);

    if (filters.onlyUnliked && item.alreadyLiked) {
      denyReasons.push('already-liked');
    }
    if (filters.maxAgeHours && item.publishedAt) {
      const ageHours = (now - new Date(item.publishedAt).getTime()) / (60 * 60 * 1000);
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
      if (filters.allowEntryTypes.length && matchesAnyToken([normalizedType], filters.allowEntryTypes)) {
        allowHits.push('entry-type');
      }
      if (filters.allowKeywords.length && matchesAnyKeyword(itemText, filters.allowKeywords)) {
        allowHits.push('keyword');
      }
    } else {
      allowHits.push('default-visible');
    }

    return {
      matched: denyReasons.length === 0 && allowHits.length > 0,
      allowHits,
      denyReasons,
    };
  }

  function markProcessed(itemKey, status) {
    runtime.persisted.processed[itemKey] = {
      ts: Date.now(),
      status: cleanText(status || 'processed'),
    };
    savePersisted();
  }

  function wasProcessed(itemKey) {
    runtime.persisted.processed = trimProcessedCache(runtime.persisted.processed);
    return Boolean(runtime.persisted.processed[itemKey]);
  }

  function clearProcessedCache() {
    runtime.persisted.processed = {};
    savePersisted();
  }

  function incrementDailyLikes() {
    runtime.persisted.dailyCounter = resetDailyCounter(runtime.persisted.dailyCounter);
    runtime.persisted.dailyCounter.likes += 1;
    savePersisted();
  }

  function remainingDailyLikes() {
    runtime.persisted.dailyCounter = resetDailyCounter(runtime.persisted.dailyCounter);
    if (!isPositiveLimit(runtime.config.limits.maxLikesPerDay)) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, runtime.config.limits.maxLikesPerDay - runtime.persisted.dailyCounter.likes);
  }

  function getCsrfToken() {
    return (
      document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
      document.querySelector('meta[name="csrf-token"]')?.content ||
      null
    );
  }

  function safeJsonParse(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function normalizeRequestHeaders(headers) {
    const output = {};
    if (!headers) {
      return output;
    }
    Object.keys(headers).forEach((key) => {
      const normalizedKey = key.toLowerCase();
      if (!['accept', 'content-type', 'x-csrf-token', 'x-requested-with'].includes(normalizedKey)) {
        return;
      }
      output[normalizedKey] = headers[key];
    });
    return output;
  }

  class NetworkObserver {
    constructor() {
      this.installed = false;
    }

    install() {
      if (this.installed) {
        return;
      }
      this.installed = true;
      this.installFetchObserver();
      this.installXhrObserver();
    }

    installFetchObserver() {
      const originalFetch = window.fetch;
      const observer = this;
      if (typeof originalFetch !== 'function') {
        return;
      }
      window.fetch = function fetchWithObservation(input, init) {
        const requestInfo = observer.normalizeFetchRequest(input, init);
        return originalFetch.apply(this, arguments).then((response) => {
          observer.observeResponse(requestInfo, response.clone()).catch((error) => {
            logDebug('fetch observation failed', error);
          });
          return response;
        });
      };
    }

    installXhrObserver() {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
        this.__gcoresAutoLikeRequest = {
          method: String(method || 'GET').toUpperCase(),
          url: new URL(url, location.origin).toString(),
          headers: {},
          bodyText: null,
        };
        return originalOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.setRequestHeader = function patchedHeader(name, value) {
        if (this.__gcoresAutoLikeRequest) {
          this.__gcoresAutoLikeRequest.headers[String(name || '').toLowerCase()] = String(value || '');
        }
        return originalSetRequestHeader.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function patchedSend(body) {
        if (this.__gcoresAutoLikeRequest) {
          this.__gcoresAutoLikeRequest.bodyText = typeof body === 'string' ? body : null;
        }
        this.addEventListener('loadend', () => {
          const requestInfo = this.__gcoresAutoLikeRequest;
          if (!requestInfo) {
            return;
          }
          const contentType = this.getResponseHeader('content-type') || '';
          if (!contentType.includes('json') && !requestInfo.url.match(/feed|vote|latest/i)) {
            return;
          }
          const payload = safeJsonParse(this.responseText);
          if (!payload) {
            return;
          }
          handleObservedPayload(requestInfo, payload, this.status);
        });
        return originalSend.apply(this, arguments);
      };
    }

    normalizeFetchRequest(input, init) {
      const requestHeaders = {};
      const applyHeaders = (headers) => {
        if (!headers) {
          return;
        }
        if (headers instanceof Headers) {
          headers.forEach((value, key) => {
            requestHeaders[String(key).toLowerCase()] = String(value);
          });
          return;
        }
        if (Array.isArray(headers)) {
          headers.forEach(([key, value]) => {
            requestHeaders[String(key).toLowerCase()] = String(value);
          });
          return;
        }
        Object.keys(headers).forEach((key) => {
          requestHeaders[String(key).toLowerCase()] = String(headers[key]);
        });
      };

      let method = 'GET';
      let url = location.href;
      let bodyText = null;

      if (typeof Request !== 'undefined' && input instanceof Request) {
        method = String(input.method || 'GET').toUpperCase();
        url = input.url;
        applyHeaders(input.headers);
      } else if (typeof input === 'string') {
        url = new URL(input, location.origin).toString();
      }

      if (init) {
        method = String(init.method || method).toUpperCase();
        applyHeaders(init.headers);
        bodyText = typeof init.body === 'string' ? init.body : bodyText;
      }

      return {
        method,
        url,
        headers: requestHeaders,
        bodyText,
      };
    }

    async observeResponse(requestInfo, response) {
      const url = new URL(requestInfo.url, location.origin);
      if (url.origin !== location.origin || response.status >= 400) {
        return;
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json') && !requestInfo.url.match(/feed|vote|latest/i)) {
        return;
      }
      const text = await response.text();
      const payload = safeJsonParse(text);
      if (!payload) {
        return;
      }
      handleObservedPayload(requestInfo, payload, response.status);
    }
  }

  function looksLikeFeedEnvelope(payload) {
    if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) {
      return false;
    }
    const first = payload.data[0];
    if (!first || typeof first !== 'object') {
      return false;
    }
    return (
      first.type === 'latest-updates' ||
      first.type === 'feeds' ||
      Boolean(first.relationships?.feed) ||
      Boolean(first.relationships?.target)
    );
  }

  function findFirstRefOfTypes(value, allowedTypes) {
    const allowed = new Set(allowedTypes.map((type) => normalizeToken(type)));
    const queue = [{ value, path: [] }];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.value == null) {
        continue;
      }
      if (
        isObject(current.value) &&
        typeof current.value.type === 'string' &&
        current.value.id != null &&
        allowed.has(normalizeToken(current.value.type))
      ) {
        return current;
      }
      if (Array.isArray(current.value)) {
        current.value.forEach((item, index) => {
          queue.push({ value: item, path: current.path.concat(index) });
        });
        continue;
      }
      if (isObject(current.value)) {
        Object.keys(current.value).forEach((key) => {
          queue.push({ value: current.value[key], path: current.path.concat(key) });
        });
      }
    }
    return null;
  }

  function findFirstKey(value, keys) {
    const keySet = new Set(keys);
    const queue = [{ value, path: [] }];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.value == null) {
        continue;
      }
      if (Array.isArray(current.value)) {
        current.value.forEach((item, index) => {
          queue.push({ value: item, path: current.path.concat(index) });
        });
        continue;
      }
      if (!isObject(current.value)) {
        continue;
      }
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(current.value, key)) {
          return { value: current.value[key], path: current.path.concat(key) };
        }
      }
      Object.keys(current.value).forEach((key) => {
        if (!keySet.has(key)) {
          queue.push({ value: current.value[key], path: current.path.concat(key) });
        }
      });
    }
    return null;
  }

  function extractVoteIdFromValue(value) {
    const match = findFirstRefOfTypes(value, ['votes']);
    return match?.value?.id ? String(match.value.id) : null;
  }

  function extractVoteIdFromUrl(url) {
    const match = String(url || '').match(/\/votes\/([^/?#]+)/i);
    return match ? String(match[1]) : null;
  }

  function buildVoteTemplate(requestInfo, payload) {
    const method = String(requestInfo.method || '').toUpperCase();
    if (!['POST', 'PATCH', 'DELETE'].includes(method)) {
      return null;
    }
    const bodyJson = safeJsonParse(requestInfo.bodyText);
    const haystack = `${requestInfo.url}\n${requestInfo.bodyText || ''}`.toLowerCase();
    const targetMatch = findFirstRefOfTypes(bodyJson, KNOWN_ENTRY_TYPES) || findFirstRefOfTypes(payload, KNOWN_ENTRY_TYPES);
    const userMatch = findFirstRefOfTypes(bodyJson, ['users']) || findFirstRefOfTypes(payload, ['users']);
    const voteFlagMatch = findFirstKey(bodyJson, ['vote-flag', 'voteFlag']) || findFirstKey(payload, ['vote-flag', 'voteFlag']);
    const voteId = extractVoteIdFromValue(payload) || extractVoteIdFromUrl(requestInfo.url);
    const looksLikeVote = /vote/.test(haystack) || Boolean(targetMatch) || Boolean(voteId) || Boolean(voteFlagMatch);
    if (!looksLikeVote) {
      return null;
    }

    return {
      method,
      url: requestInfo.url,
      headers: normalizeRequestHeaders(requestInfo.headers),
      body: bodyJson || requestInfo.bodyText || null,
      bodyIsJson: Boolean(bodyJson),
      sample: {
        targetType: targetMatch?.value?.type ? String(targetMatch.value.type) : null,
        targetId: targetMatch?.value?.id ? String(targetMatch.value.id) : null,
        userId: userMatch?.value?.id ? String(userMatch.value.id) : null,
        voteId: voteId ? String(voteId) : null,
        voteFlag: typeof voteFlagMatch?.value === 'boolean' ? voteFlagMatch.value : null,
      },
      paths: {
        targetPath: targetMatch?.path || null,
        userPath: userMatch?.path || null,
        voteFlagPath: voteFlagMatch?.path || null,
      },
      observedAt: Date.now(),
    };
  }

  function handleObservedPayload(requestInfo, payload, status) {
    if (status >= 400) {
      return;
    }
    if (looksLikeFeedEnvelope(payload)) {
      runtime.persisted.calibration.feedRequest = {
        method: requestInfo.method,
        url: requestInfo.url,
        headers: normalizeRequestHeaders(requestInfo.headers),
        bodyText: requestInfo.bodyText,
        observedAt: Date.now(),
      };
      runtime.persisted.calibration.feedSample = payload;
      savePersisted();
      logDebug('Feed request captured', runtime.persisted.calibration.feedRequest);
    }

    const template = buildVoteTemplate(requestInfo, payload);
    if (!template) {
      return;
    }
    if (template.method === 'POST') {
      runtime.persisted.calibration.voteTemplates.post = template;
    } else if (template.method === 'PATCH') {
      runtime.persisted.calibration.voteTemplates.patch = template;
    } else if (template.method === 'DELETE') {
      runtime.persisted.calibration.voteTemplates.delete = template;
    }
    savePersisted();
    logDebug('Vote template captured', template);
  }

  function indexJsonApiRecords(payload) {
    const records = new Map();
    const insert = (record) => {
      if (!record || typeof record.type !== 'string' || record.id == null) {
        return;
      }
      records.set(`${record.type}:${record.id}`, record);
    };
    if (Array.isArray(payload?.data)) {
      payload.data.forEach(insert);
    } else if (payload?.data) {
      insert(payload.data);
    }
    if (Array.isArray(payload?.included)) {
      payload.included.forEach(insert);
    }
    return records;
  }

  function resolveJsonApiRecord(ref, records) {
    if (!ref || typeof ref.type !== 'string' || ref.id == null) {
      return null;
    }
    return records.get(`${ref.type}:${ref.id}`) || null;
  }

  function resolveRelation(record, relationName, records) {
    const rel = record?.relationships?.[relationName]?.data;
    if (!rel) {
      return null;
    }
    if (Array.isArray(rel)) {
      return rel.map((item) => resolveJsonApiRecord(item, records)).filter(Boolean);
    }
    return resolveJsonApiRecord(rel, records);
  }

  function findPrimaryTarget(record, records, visited) {
    if (!record || visited.has(`${record.type}:${record.id}`)) {
      return null;
    }
    visited.add(`${record.type}:${record.id}`);
    if (KNOWN_ENTRY_TYPES.includes(record.type)) {
      return record;
    }

    const priorityRelations = ['target', 'feed', 'related-content', 'article', 'radio', 'video', 'talk', 'discussion', 'original'];
    for (const relationName of priorityRelations) {
      const related = resolveRelation(record, relationName, records);
      if (!related) {
        continue;
      }
      const list = Array.isArray(related) ? related : [related];
      for (const nextRecord of list) {
        const match = findPrimaryTarget(nextRecord, records, visited);
        if (match) {
          return match;
        }
      }
    }

    const relationKeys = Object.keys(record.relationships || {});
    for (const relationName of relationKeys) {
      const related = resolveRelation(record, relationName, records);
      if (!related) {
        continue;
      }
      const list = Array.isArray(related) ? related : [related];
      for (const nextRecord of list) {
        const match = findPrimaryTarget(nextRecord, records, visited);
        if (match) {
          return match;
        }
      }
    }

    return null;
  }

  function gatherRelationIds(record, relationName, records) {
    const related = resolveRelation(record, relationName, records);
    if (!related) {
      return [];
    }
    if (Array.isArray(related)) {
      return related.map((item) => String(item.id));
    }
    return [String(related.id)];
  }

  function gatherTopicTokens(record, records) {
    const topics = resolveRelation(record, 'topic', records) || resolveRelation(record, 'topics', records) || [];
    const topicList = Array.isArray(topics) ? topics : [topics];
    const tokens = [];
    topicList.forEach((topic) => {
      if (!topic) {
        return;
      }
      if (topic.id != null) {
        tokens.push(String(topic.id));
      }
      if (topic.attributes?.slug) {
        tokens.push(String(topic.attributes.slug));
      }
      if (topic.attributes?.title) {
        tokens.push(String(topic.attributes.title));
      }
    });
    return uniqueStrings(tokens);
  }

  function pickAttr(record, keys) {
    if (!record?.attributes) {
      return '';
    }
    for (const key of keys) {
      const value = record.attributes[key];
      if (value != null && cleanText(value)) {
        return cleanText(value);
      }
    }
    return '';
  }

  function extractVoteMeta(record, records) {
    const candidates = [record];
    const directVote = resolveRelation(record, 'vote', records);
    const directVotes = resolveRelation(record, 'votes', records);
    const helpful = resolveRelation(record, 'helpful', records);
    const helpfuls = resolveRelation(record, 'helpfuls', records);
    [directVote, helpful].forEach((item) => {
      if (item) {
        candidates.push(item);
      }
    });
    [directVotes, helpfuls].forEach((list) => {
      if (Array.isArray(list)) {
        list.forEach((item) => candidates.push(item));
      }
    });

    let voteId = null;
    let alreadyLiked = false;
    candidates.forEach((candidate) => {
      if (!candidate) {
        return;
      }
      if (!voteId && candidate.type === 'votes') {
        voteId = String(candidate.id);
      }
      const attrs = candidate.attributes || {};
      if (attrs['vote-flag'] === true || attrs.voteFlag === true || attrs.liked === true || attrs['is-liked'] === true) {
        alreadyLiked = true;
      }
    });
    if (record?.meta?.['vote-id']) {
      voteId = String(record.meta['vote-id']);
    }
    if (record?.meta?.['vote-flag'] === true) {
      alreadyLiked = true;
    }
    return { voteId, alreadyLiked };
  }

  function dedupeItems(items) {
    const next = [];
    const seen = new Set();
    items.forEach((item) => {
      const key = buildItemKey(item);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      next.push(item);
    });
    return next;
  }

  function normalizeFeedEnvelope(payload) {
    const records = indexJsonApiRecords(payload);
    const updates = Array.isArray(payload?.data) ? payload.data : [];
    const items = [];

    updates.forEach((update) => {
      const targetRecord = findPrimaryTarget(update, records, new Set());
      if (!targetRecord) {
        return;
      }
      const voteMeta = extractVoteMeta(targetRecord, records);
      const authorIds = uniqueStrings([
        ...gatherRelationIds(targetRecord, 'user', records),
        ...gatherRelationIds(targetRecord, 'author', records),
        ...gatherRelationIds(update, 'user', records),
      ]);
      const topicIds = uniqueStrings([
        ...gatherTopicTokens(targetRecord, records),
        ...gatherTopicTokens(update, records),
      ]);
      const title = pickAttr(targetRecord, ['title', 'name', 'subject']) || pickAttr(update, ['title', 'name', 'subject']);
      const summary =
        pickAttr(targetRecord, ['summary', 'description', 'desc', 'introduction', 'excerpt']) ||
        pickAttr(update, ['summary', 'description', 'desc', 'introduction', 'excerpt']);
      const publishedAt =
        targetRecord.attributes?.['published-at'] ||
        targetRecord.attributes?.['created-at'] ||
        targetRecord.attributes?.['updated-at'] ||
        update.attributes?.['published-at'] ||
        update.attributes?.['created-at'] ||
        update.attributes?.['updated-at'] ||
        null;
      const url =
        pickAttr(targetRecord, ['url', 'permalink', 'link']) ||
        pickAttr(update, ['url', 'permalink', 'link']) ||
        buildEntryUrl(targetRecord.type, targetRecord.id);

      items.push({
        updateId: String(update.id || `${targetRecord.type}:${targetRecord.id}`),
        targetType: String(targetRecord.type),
        targetId: String(targetRecord.id),
        voteId: voteMeta.voteId,
        alreadyLiked: voteMeta.alreadyLiked,
        authorIds,
        topicIds,
        title: title || `${targetRecord.type}/${targetRecord.id}`,
        summary,
        url,
        publishedAt,
      });
    });

    return dedupeItems(items);
  }

  function serializeFeedRequest(template, pageIndex) {
    const method = String(template.method || 'GET').toUpperCase();
    const headers = { ...template.headers };
    if (runtime.requestContext.csrfToken && !headers['x-csrf-token']) {
      headers['x-csrf-token'] = runtime.requestContext.csrfToken;
    }

    if (method === 'GET') {
      const url = new URL(template.url, location.origin);
      const limit =
        clampNumber(url.searchParams.get('page[limit]'), 0, 0) ||
        clampNumber(url.searchParams.get('limit'), 0, 0) ||
        20;
      if (url.searchParams.has('page[offset]')) {
        url.searchParams.set('page[offset]', String(limit * pageIndex));
      } else if (url.searchParams.has('offset')) {
        url.searchParams.set('offset', String(limit * pageIndex));
      } else if (url.searchParams.has('page')) {
        url.searchParams.set('page', String(pageIndex + 1));
      } else if (pageIndex > 0) {
        return null;
      }
      return {
        url: url.toString(),
        options: {
          method,
          credentials: 'include',
          headers,
        },
      };
    }

    const body = safeJsonParse(template.bodyText);
    if (!body) {
      return pageIndex === 0
        ? {
            url: template.url,
            options: {
              method,
              credentials: 'include',
              headers,
              body: template.bodyText || null,
            },
          }
        : null;
    }

    const nextBody = deepClone(body);
    if (nextBody.page && typeof nextBody.page === 'object' && nextBody.page.limit != null) {
      nextBody.page.offset = Number(nextBody.page.limit) * pageIndex;
    } else if (pageIndex > 0) {
      return null;
    }

    return {
      url: template.url,
      options: {
        method,
        credentials: 'include',
        headers: {
          ...headers,
          'content-type': headers['content-type'] || 'application/json',
        },
        body: JSON.stringify(nextBody),
      },
    };
  }

  async function requestJson(url, options) {
    const headers = {
      accept: 'application/json, application/vnd.api+json, text/plain, */*',
      ...options.headers,
      [AUTO_HEADER_NAME]: SCRIPT_VERSION,
    };
    if (runtime.requestContext.csrfToken && !headers['x-csrf-token']) {
      headers['x-csrf-token'] = runtime.requestContext.csrfToken;
    }
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
      redirect: 'follow',
    });
    const text = await response.text();
    const payload = safeJsonParse(text);
    return { response, text, payload };
  }

  function setValueAtPath(target, path, value) {
    if (!Array.isArray(path) || path.length === 0) {
      return;
    }
    let current = target;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (current == null) {
        return;
      }
      current = current[key];
    }
    if (current != null) {
      current[path[path.length - 1]] = value;
    }
  }

  function replaceScalarValues(value, replacements) {
    if (Array.isArray(value)) {
      return value.map((item) => replaceScalarValues(item, replacements));
    }
    if (isObject(value)) {
      const next = {};
      Object.keys(value).forEach((key) => {
        next[key] = replaceScalarValues(value[key], replacements);
      });
      return next;
    }
    if (typeof value === 'string') {
      let nextValue = value;
      replacements.forEach(([fromValue, toValue]) => {
        if (fromValue == null || toValue == null || fromValue === toValue) {
          return;
        }
        nextValue = nextValue.split(String(fromValue)).join(String(toValue));
      });
      return nextValue;
    }
    return value;
  }

  function updateVoteFlagInBody(body, template, voteFlag) {
    if (typeof voteFlag !== 'boolean') {
      return body;
    }
    if (template.paths.voteFlagPath) {
      setValueAtPath(body, template.paths.voteFlagPath, voteFlag);
      return body;
    }
    return replaceScalarValues(body, [[template.sample.voteFlag, voteFlag]]);
  }

  function applyVoteTemplate(template, variables) {
    const replacements = [
      [template.sample.targetType, variables.targetType],
      [template.sample.targetId, variables.targetId],
      [template.sample.userId, variables.userId],
      [template.sample.voteId, variables.voteId],
    ];

    let url = String(template.url);
    replacements.forEach(([fromValue, toValue]) => {
      if (fromValue == null || toValue == null || fromValue === toValue) {
        return;
      }
      url = url.split(String(fromValue)).join(String(toValue));
      url = url.split(encodeURIComponent(String(fromValue))).join(encodeURIComponent(String(toValue)));
    });

    const headers = {
      ...template.headers,
      accept: 'application/json, application/vnd.api+json, text/plain, */*',
    };
    if (runtime.requestContext.csrfToken && !headers['x-csrf-token']) {
      headers['x-csrf-token'] = runtime.requestContext.csrfToken;
    }

    if (template.bodyIsJson && isObject(template.body)) {
      const body = deepClone(template.body);
      if (template.paths.targetPath) {
        setValueAtPath(body, template.paths.targetPath, {
          type: variables.targetType,
          id: variables.targetId,
        });
      } else {
        const replacedBody = replaceScalarValues(body, replacements);
        return {
          url,
          options: {
            method: template.method,
            credentials: 'include',
            headers: {
              ...headers,
              'content-type': headers['content-type'] || 'application/vnd.api+json',
            },
            body: JSON.stringify(updateVoteFlagInBody(replacedBody, template, variables.voteFlag)),
          },
        };
      }
      if (template.paths.userPath && variables.userId) {
        setValueAtPath(body, template.paths.userPath, {
          type: 'users',
          id: variables.userId,
        });
      }
      const nextBody = updateVoteFlagInBody(body, template, variables.voteFlag);
      return {
        url,
        options: {
          method: template.method,
          credentials: 'include',
          headers: {
            ...headers,
            'content-type': headers['content-type'] || 'application/vnd.api+json',
          },
          body: JSON.stringify(nextBody),
        },
      };
    }

    if (typeof template.body === 'string' && template.body) {
      let body = template.body;
      replacements.forEach(([fromValue, toValue]) => {
        if (fromValue == null || toValue == null || fromValue === toValue) {
          return;
        }
        body = body.split(String(fromValue)).join(String(toValue));
      });
      if (template.sample.voteFlag !== null && typeof variables.voteFlag === 'boolean') {
        body = body.split(String(template.sample.voteFlag)).join(String(variables.voteFlag));
      }
      return {
        url,
        options: {
          method: template.method,
          credentials: 'include',
          headers,
          body,
        },
      };
    }

    return {
      url,
      options: {
        method: template.method,
        credentials: 'include',
        headers,
      },
    };
  }

  function buildGenericVoteRequests(item, voteFlag, voteId) {
    const requests = [];
    const currentUserId = runtime.currentUserId || detectCurrentUserId();
    const baseRelationships = {
      votable: {
        data: {
          type: item.targetType,
          id: item.targetId,
        },
      },
    };
    if (currentUserId) {
      baseRelationships.user = {
        data: {
          type: 'users',
          id: currentUserId,
        },
      };
    }

    const bodies = [
      {
        data: {
          type: 'votes',
          attributes: { 'vote-flag': voteFlag },
          relationships: baseRelationships,
        },
      },
      {
        data: {
          attributes: { 'vote-flag': voteFlag },
          relationships: baseRelationships,
        },
      },
    ];
    if (voteId) {
      bodies.push({
        data: {
          type: 'votes',
          id: voteId,
          attributes: { 'vote-flag': voteFlag },
          relationships: baseRelationships,
        },
      });
    }

    const requestSets = [
      {
        method: voteId ? 'PATCH' : 'POST',
        url: voteId ? `${location.origin}/votes/${voteId}` : `${location.origin}/votes`,
      },
      {
        method: voteId ? 'PATCH' : 'POST',
        url: voteId ? `${location.origin}/votes/${voteId}.json` : `${location.origin}/votes.json`,
      },
    ];

    requestSets.forEach((requestSet) => {
      bodies.forEach((body) => {
        requests.push({
          url: requestSet.url,
          options: {
            method: requestSet.method,
            headers: { 'content-type': 'application/vnd.api+json' },
            body: JSON.stringify(body),
          },
        });
        requests.push({
          url: requestSet.url,
          options: {
            method: requestSet.method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        });
      });
    });

    if (voteId) {
      requests.push({
        url: `${location.origin}/votes/${voteId}`,
        options: {
          method: 'DELETE',
          headers: {},
        },
      });
    }

    return requests;
  }

  async function executeVoteRequest(request) {
    const result = await requestJson(request.url, request.options);
    if ([401, 403, 429].includes(result.response.status)) {
      throw new BlockedRequestError(result.response.status, `HTTP ${result.response.status}`);
    }
    if (!result.response.ok) {
      throw new Error(`点赞请求失败（HTTP ${result.response.status}）`);
    }
    return result;
  }

  async function clickDomLikeButton(item) {
    const itemKey = buildItemKey(item);
    let button = runtime.domButtons.get(itemKey);
    if (!button || !document.contains(button)) {
      extractDomFeedItems();
      button = runtime.domButtons.get(itemKey);
    }
    if (!button) {
      throw new Error('DOM 兜底失败：未找到可见的点赞按钮');
    }
    if (isLikeButtonActive(button)) {
      return { ok: true, mode: 'dom', voteId: item.voteId || null };
    }

    if (typeof button.click === 'function') {
      button.click();
    } else {
      const ownerWindow = button.ownerDocument?.defaultView;
      const MouseEventCtor = ownerWindow?.MouseEvent || MouseEvent;
      button.dispatchEvent(
        new MouseEventCtor('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      );
    }

    const activated = await waitFor(() => isLikeButtonActive(button), 8000, 200);
    if (!activated) {
      throw new Error('DOM 兜底失败：点击后点赞按钮未激活');
    }
    return { ok: true, mode: 'dom', voteId: item.voteId || null };
  }

  async function createVote(item) {
    try {
      return await clickDomLikeButton(item);
    } catch (error) {
      logDebug('DOM vote click failed, falling back to request mode', error);
    }

    const template = runtime.persisted.calibration.voteTemplates.post;
    if (template) {
      const request = applyVoteTemplate(template, {
        targetType: item.targetType,
        targetId: item.targetId,
        userId: runtime.currentUserId || detectCurrentUserId(),
        voteFlag: true,
      });
      try {
        const result = await executeVoteRequest(request);
        return {
          ok: true,
          mode: 'api-template',
          voteId: extractVoteIdFromValue(result.payload),
        };
      } catch (error) {
        logDebug('Template vote request failed, falling back', error);
      }
    }

    const genericRequests = buildGenericVoteRequests(item, true, null);
    for (const request of genericRequests) {
      try {
        const result = await executeVoteRequest(request);
        return {
          ok: true,
          mode: 'api-generic',
          voteId: extractVoteIdFromValue(result.payload),
        };
      } catch (error) {
        if (error instanceof BlockedRequestError) {
          throw error;
        }
      }
    }

    return clickDomLikeButton(item);
  }

  async function updateVote(item, voteId, voteFlag) {
    const template = runtime.persisted.calibration.voteTemplates.patch;
    if (template && voteId) {
      const request = applyVoteTemplate(template, {
        targetType: item.targetType,
        targetId: item.targetId,
        userId: runtime.currentUserId || detectCurrentUserId(),
        voteId,
        voteFlag,
      });
      return executeVoteRequest(request);
    }

    const genericRequests = buildGenericVoteRequests(item, voteFlag, voteId);
    for (const request of genericRequests) {
      if (request.options.method !== 'PATCH') {
        continue;
      }
      try {
        return await executeVoteRequest(request);
      } catch (error) {
        if (error instanceof BlockedRequestError) {
          throw error;
        }
      }
    }

    throw new Error('没有可用的 PATCH 点赞路径');
  }

  async function deleteVote(item, voteId) {
    const template = runtime.persisted.calibration.voteTemplates.delete;
    if (template && voteId) {
      const request = applyVoteTemplate(template, {
        targetType: item.targetType,
        targetId: item.targetId,
        userId: runtime.currentUserId || detectCurrentUserId(),
        voteId,
      });
      return executeVoteRequest(request);
    }

    const genericRequests = buildGenericVoteRequests(item, true, voteId);
    for (const request of genericRequests) {
      if (request.options.method !== 'DELETE') {
        continue;
      }
      try {
        return await executeVoteRequest(request);
      } catch (error) {
        if (error instanceof BlockedRequestError) {
          throw error;
        }
      }
    }

    throw new Error('没有可用的 DELETE 点赞路径');
  }

  async function listFeedPage(pageIndex) {
    const feedSample = runtime.persisted.calibration.feedSample;
    const feedRequest = runtime.persisted.calibration.feedRequest;
    if (pageIndex === 0 && feedSample) {
      return {
        items: normalizeFeedEnvelope(feedSample),
        hasMore: true,
        mode: 'api-sample',
      };
    }
    if (!feedRequest) {
      return { items: [], hasMore: false, mode: 'none' };
    }

    const request = serializeFeedRequest(feedRequest, pageIndex);
    if (!request) {
      return { items: [], hasMore: false, mode: 'none' };
    }

    const result = await requestJson(request.url, request.options);
    if ([401, 403, 429].includes(result.response.status)) {
      throw new BlockedRequestError(result.response.status, `HTTP ${result.response.status}`);
    }
    if (!result.response.ok || !result.payload) {
      throw new Error(`动态列表请求失败（HTTP ${result.response.status}）`);
    }
    const items = normalizeFeedEnvelope(result.payload);
    return {
      items,
      hasMore: Boolean(items.length),
      mode: 'api',
    };
  }

  async function scrollForMore(pageIndex, runner) {
    const beforeCount = extractDomFeedItems().length;
    const beforeHeight = document.documentElement.scrollHeight;
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'smooth',
    });
    const waited = await waitWithControl(randomBetween(...runtime.config.timing.pageDelayMsRange), runner);
    if (!waited) {
      return false;
    }
    await waitFor(
      () => {
        const afterCount = extractDomFeedItems().length;
        const afterHeight = document.documentElement.scrollHeight;
        return afterCount > beforeCount || afterHeight > beforeHeight || pageIndex === 0;
      },
      5000,
      200
    );
    return true;
  }

  class Runner {
    constructor() {
      this.status = 'idle';
      this.sourceMode = 'dom';
      this.shouldStop = false;
      this.refreshTimerId = null;
      this.nextRefreshAt = 0;
      this.sessionSeen = new Set();
      this.matchedPreview = [];
      this.stats = {
        pages: 0,
        scanned: 0,
        matched: 0,
        liked: 0,
        skipped: 0,
        consecutiveErrors: 0,
      };
    }

    clearRefreshTimer() {
      if (this.refreshTimerId) {
        window.clearTimeout(this.refreshTimerId);
        this.refreshTimerId = null;
      }
      this.nextRefreshAt = 0;
      setScheduledRefreshAt(0);
    }

    enableLoop() {
      setLoopEnabled(true);
    }

    disableLoop() {
      setLoopEnabled(false);
      this.clearRefreshTimer();
    }

    hasReachedDailyLimit() {
      return isPositiveLimit(runtime.config.limits.maxLikesPerDay) && remainingDailyLikes() <= 0;
    }

    hasReachedRunLimit() {
      return isPositiveLimit(runtime.config.limits.maxLikesPerRun) && this.stats.liked >= runtime.config.limits.maxLikesPerRun;
    }

    scheduleRefresh() {
      this.clearRefreshTimer();
      if (this.shouldStop || this.status === 'paused' || !isLoopEnabled()) {
        return;
      }
      if (this.hasReachedDailyLimit() || isCooldownActive() || !isFeedsPage()) {
        return;
      }
      const delay = runtime.config.timing.refreshIntervalMs;
      this.nextRefreshAt = Date.now() + delay;
      setScheduledRefreshAt(this.nextRefreshAt);
      this.status = 'waiting_refresh';
      updateUi();
      this.refreshTimerId = window.setTimeout(() => {
        if (this.shouldStop || this.status === 'paused' || !isLoopEnabled()) {
          return;
        }
        window.location.reload();
      }, delay);
    }

    async start() {
      if (this.status === 'running') {
        return;
      }

      this.clearRefreshTimer();
      runtime.requestContext.csrfToken = getCsrfToken();
      runtime.currentUserId = detectCurrentUserId();
      runtime.persisted.dailyCounter = resetDailyCounter(runtime.persisted.dailyCounter);
      savePersisted();
      clearLastError();

      if (isCooldownActive()) {
        this.status = 'cooldown';
        this.disableLoop();
        updateUi();
        notify('冷却期仍在生效，请稍后再启动。');
        return;
      }

      if (!isFeedsPage()) {
        this.status = 'not_feeds';
        this.disableLoop();
        setLastError('请先打开机核动态页 /feeds 再运行脚本。');
        updateUi();
        return;
      }

      const loginState = detectLoginState();
      if (!loginState.loggedIn) {
        this.status = 'login_required';
        this.disableLoop();
        setLastError('运行前需要先登录机核账号。');
        updateUi();
        return;
      }

      this.shouldStop = false;
      this.status = 'running';
      this.sessionSeen.clear();
      this.matchedPreview = [];
      this.stats = {
        pages: 0,
        scanned: 0,
        matched: 0,
        liked: 0,
        skipped: 0,
        consecutiveErrors: 0,
      };
      this.sourceMode = 'dom';
      this.enableLoop();
      updateUi();

      try {
        await this.runLoop();
      } catch (error) {
        if (error instanceof BlockedRequestError) {
          this.status = 'cooldown';
          this.disableLoop();
          setBlockedCooldown(error.status);
        } else {
          setLastError(error.message || 'Unexpected run error');
        }
      } finally {
        this.persistDryRunSummary();
        if (this.status === 'cooldown' || this.status === 'login_required' || this.status === 'not_feeds') {
          this.disableLoop();
        } else if (this.shouldStop) {
          this.status = 'stopped';
          this.disableLoop();
        } else if (this.hasReachedDailyLimit()) {
          this.status = 'stopped';
          this.disableLoop();
          setLastError('已达到今日点赞上限，自动循环已停止。');
        } else if (isLoopEnabled()) {
          this.scheduleRefresh();
        } else if (this.status !== 'paused') {
          this.status = 'idle';
        }
        updateUi();
      }
    }

    pause() {
      if (this.status === 'running' || this.status === 'waiting_refresh') {
        setLoopEnabled(false);
        this.clearRefreshTimer();
        this.status = 'paused';
        updateUi();
      }
    }

    resume() {
      if (this.status === 'paused') {
        this.enableLoop();
        this.status = 'running';
        this.scheduleRefresh();
      }
    }

    stop() {
      this.shouldStop = true;
      this.disableLoop();
      this.status = 'stopped';
      updateUi();
    }

    persistDryRunSummary() {
      if (!runtime.config.dryRun) {
        return;
      }
      runtime.persisted.lastDryRun = {
        createdAt: Date.now(),
        sourceMode: this.sourceMode,
        stats: deepClone(this.stats),
        items: this.matchedPreview.slice(0, 20),
      };
      savePersisted();
    }

    async runLoop() {
      const ready = await waitFor(() => extractDomFeedItems().length > 0 || !isFeedsPage(), 10000, 250);
      if (this.shouldStop) {
        return;
      }
      if (!isFeedsPage()) {
        this.status = 'not_feeds';
        this.shouldStop = true;
        setLastError('你已经离开动态页，脚本已自动停止。');
        updateUi();
        return;
      }

      const pageItems = extractDomFeedItems();
      this.stats.pages = pageItems.length > 0 ? 1 : 0;
      if (!ready || pageItems.length === 0) {
        setLastError('当前页没有找到可处理的动态卡片或点赞按钮。');
        return;
      }
      await this.processItems(pageItems);
    }

    async processItems(items) {
      const deduped = dedupeItems(items);
      for (const item of deduped) {
        if (this.shouldStop) {
          return;
        }
        while (this.status === 'paused') {
          if (this.shouldStop) {
            return;
          }
          await sleep(200);
        }

        const itemKey = buildItemKey(item);
        if (this.sessionSeen.has(itemKey)) {
          continue;
        }
        this.sessionSeen.add(itemKey);
        this.stats.scanned += 1;

        if (wasProcessed(itemKey)) {
          this.stats.skipped += 1;
          continue;
        }

        if (runtime.config.filters.onlyUnliked && item.alreadyLiked) {
          markProcessed(itemKey, 'already-liked');
          this.stats.skipped += 1;
          continue;
        }

        const evaluation = evaluateItem(item, runtime.config.filters);
        if (!evaluation.matched) {
          this.stats.skipped += 1;
          continue;
        }

        this.stats.matched += 1;
        this.matchedPreview.push({
          key: itemKey,
          title: item.title,
          url: item.url,
          reasons: evaluation.allowHits,
        });
        updateUi();

        if (runtime.config.dryRun) {
          continue;
        }

        if (this.hasReachedDailyLimit() || this.hasReachedRunLimit()) {
          return;
        }

        try {
          const result = await createVote(item);
          if (result?.ok) {
            item.alreadyLiked = true;
            this.stats.liked += 1;
            this.stats.consecutiveErrors = 0;
            markProcessed(itemKey, result.mode || 'liked');
            incrementDailyLikes();
            updateUi();
            if (this.hasReachedDailyLimit() || this.hasReachedRunLimit()) {
              return;
            }
          }
        } catch (error) {
          if (error instanceof BlockedRequestError) {
            throw error;
          }
          this.stats.consecutiveErrors += 1;
          setLastError(error.message || '点赞请求失败');
          if (this.stats.consecutiveErrors >= runtime.config.limits.maxConsecutiveErrors) {
            this.shouldStop = true;
            return;
          }
        }

        const waited = await waitWithControl(randomBetween(...runtime.config.timing.actionDelayMsRange), this);
        if (!waited) {
          return;
        }
      }
    }
  }

  class Panel {
    constructor() {
      this.root = null;
      this.elements = {};
    }

    mount() {
      if (this.root) {
        return;
      }
      const host = document.createElement('div');
      host.id = 'gcores-auto-like-panel-host';
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      this.root = host;

      const style = document.createElement('style');
      style.textContent = `
        .panel {
          position: fixed;
          right: 20px;
          bottom: 20px;
          width: 320px;
          z-index: 2147483647;
          font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #1f2937;
          background: rgba(255, 255, 255, 0.96);
          border: 1px solid rgba(15, 23, 42, 0.16);
          border-radius: 16px;
          box-shadow: 0 18px 50px rgba(15, 23, 42, 0.22);
          overflow: hidden;
          backdrop-filter: blur(12px);
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 12px 14px 10px;
          background: linear-gradient(135deg, #f5f7fb, #eef2ff);
          border-bottom: 1px solid rgba(15, 23, 42, 0.08);
        }
        .title { font-weight: 700; font-size: 13px; }
        .version { color: #64748b; font-size: 11px; }
        .status {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 4px 8px;
          border-radius: 999px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          font-size: 10px;
          background: #e2e8f0;
        }
        .body { padding: 12px 14px 14px; }
        .row {
          margin-bottom: 8px;
          color: #334155;
          white-space: pre-wrap;
        }
        .controls {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          margin-bottom: 10px;
        }
        button {
          border: 1px solid rgba(15, 23, 42, 0.12);
          border-radius: 10px;
          padding: 8px 9px;
          background: #ffffff;
          cursor: pointer;
          font: inherit;
          color: #0f172a;
        }
        button:hover { background: #f8fafc; }
        button.primary {
          background: #111827;
          color: #ffffff;
          border-color: #111827;
        }
        button.warn {
          background: #fff7ed;
          border-color: rgba(234, 88, 12, 0.25);
          color: #9a3412;
        }
        .rules {
          padding: 10px;
          border-radius: 12px;
          background: #f8fafc;
          border: 1px solid rgba(15, 23, 42, 0.06);
          color: #334155;
          max-height: 130px;
          overflow: auto;
          white-space: pre-wrap;
        }
      `;

      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.innerHTML = `
        <div class="header">
          <div>
            <div class="title">${SCRIPT_NAME}</div>
            <div class="version">v${SCRIPT_VERSION}</div>
          </div>
          <div class="status" id="status">空闲</div>
        </div>
        <div class="body">
          <div class="controls">
            <button class="primary" data-action="start">${BUTTON_TEXT.start}</button>
            <button data-action="pause">${BUTTON_TEXT.pause}</button>
            <button class="warn" data-action="stop">${BUTTON_TEXT.stop}</button>
            <button data-action="toggleDryRun">${BUTTON_TEXT.dryRun}</button>
            <button data-action="edit">${BUTTON_TEXT.edit}</button>
            <button data-action="export">${BUTTON_TEXT.export}</button>
          </div>
          <div class="row" id="summary"></div>
          <div class="row" id="calibration"></div>
          <div class="row" id="error"></div>
          <div class="row"><strong>筛选规则</strong></div>
          <div class="rules" id="rules"></div>
          <div class="controls" style="margin-top: 10px;">
            <button data-action="clear">${BUTTON_TEXT.clear}</button>
          </div>
        </div>
      `;

      shadow.appendChild(style);
      shadow.appendChild(panel);

      this.elements.status = shadow.getElementById('status');
      this.elements.summary = shadow.getElementById('summary');
      this.elements.calibration = shadow.getElementById('calibration');
      this.elements.error = shadow.getElementById('error');
      this.elements.rules = shadow.getElementById('rules');

      shadow.querySelectorAll('button[data-action]').forEach((button) => {
        button.addEventListener('click', () => {
          const action = button.getAttribute('data-action');
          if (action === 'start') {
            if (!runtime.runner) {
              runtime.runner = new Runner();
            }
            if (runtime.runner.status === 'paused') {
              runtime.runner.resume();
            } else {
              runtime.runner.start();
            }
          } else if (action === 'pause') {
            runtime.runner?.pause();
          } else if (action === 'stop') {
            runtime.runner?.stop();
          } else if (action === 'toggleDryRun') {
            runtime.config.dryRun = !runtime.config.dryRun;
            saveConfig(runtime.config);
          } else if (action === 'edit') {
            editConfig();
          } else if (action === 'export') {
            exportState();
          } else if (action === 'clear') {
            if (window.confirm('Clear processed cache?')) {
              clearProcessedCache();
            }
          }
        });
      });

      this.update();
    }

    update() {
      if (!this.root) {
        return;
      }
      const runner = runtime.runner;
      const status = runner?.status || 'idle';
      const blockedUntil = getBlockedUntil();
      const blockedText = blockedUntil > Date.now() ? ` | 冷却至 ${new Date(blockedUntil).toLocaleTimeString()}` : '';
      const nextRefreshAt = runner?.nextRefreshAt || getScheduledRefreshAt();
      const refreshText = nextRefreshAt > Date.now() ? ` | 下次刷新 ${new Date(nextRefreshAt).toLocaleTimeString()}` : '';
      const dailyLimitText = formatLimitValue(runtime.config.limits.maxLikesPerDay);
      this.elements.status.textContent = STATUS_TEXT[status] || status;
      this.elements.summary.textContent = [
        `模式：${SOURCE_MODE_TEXT[runner?.sourceMode || 'dom'] || runner?.sourceMode || '页面按钮'} | 试运行：${runtime.config.dryRun ? '开启' : '关闭'} | 自动刷新：${Math.round(runtime.config.timing.refreshIntervalMs / 60000)} 分钟`,
        `当前页数=${runner?.stats.pages || 0} | 扫描=${runner?.stats.scanned || 0} | 命中=${runner?.stats.matched || 0}`,
        `点赞=${runner?.stats.liked || 0} | 今日=${runtime.persisted.dailyCounter.likes}/${dailyLimitText}${blockedText}${refreshText}`,
      ].join('\n');

      this.elements.calibration.textContent = [
        `点赞方式：优先直接点击当前页按钮`,
        `当前页点赞按钮：${runtime.domButtons.size}`,
        `当前用户：${runtime.currentUserId || '未知'}`,
      ].join('\n');

      this.elements.error.textContent = runtime.persisted.lastError
        ? `最近错误：${runtime.persisted.lastError.message}`
        : '最近错误：无';

      this.elements.rules.textContent = summarizeFilters(runtime.config.filters);
    }
  }

  function summarizeFilters(filters) {
    const lines = [
      `${FILTER_LABELS.allowAuthors}：${filters.allowAuthors.join(', ') || '（空）'}`,
      `${FILTER_LABELS.allowTopics}：${filters.allowTopics.join(', ') || '（空）'}`,
      `${FILTER_LABELS.allowKeywords}：${filters.allowKeywords.join(', ') || '（空）'}`,
      `${FILTER_LABELS.allowEntryTypes}：${filters.allowEntryTypes.join(', ') || '（空）'}`,
      `${FILTER_LABELS.denyAuthors}：${filters.denyAuthors.join(', ') || '（空）'}`,
      `${FILTER_LABELS.denyTopics}：${filters.denyTopics.join(', ') || '（空）'}`,
      `${FILTER_LABELS.denyKeywords}：${filters.denyKeywords.join(', ') || '（空）'}`,
      `最大时效：${isPositiveLimit(filters.maxAgeHours) ? `${filters.maxAgeHours} 小时` : '不限'} | 仅点赞未点过：${filters.onlyUnliked ? '是' : '否'}`,
    ];
    if (!hasAnyAllowRules(filters)) {
      lines.push('当前没有配置允许规则时，脚本会按“当前页全部可见内容”处理，只继续应用屏蔽规则、时效和未点赞限制。');
    }
    return lines.join('\n');
  }

  function updateUi() {
    runtime.ui?.update();
  }

  function handleRouteChange() {
    runtime.currentUserId = detectCurrentUserId();
    runtime.requestContext.csrfToken = getCsrfToken();
    if (
      runtime.runner &&
      ['running', 'waiting_refresh', 'paused'].includes(runtime.runner.status) &&
      !isFeedsPage()
    ) {
      runtime.runner.stop();
      runtime.runner.status = 'not_feeds';
      setLastError('你已经离开动态页，脚本已自动停止。');
    }
    updateUi();
  }

  function installRouteObserver() {
    const wrapHistoryMethod = (methodName) => {
      const original = history[methodName];
      if (typeof original !== 'function') {
        return;
      }
      history[methodName] = function wrappedHistoryMethod() {
        const result = original.apply(this, arguments);
        setTimeout(handleRouteChange, 0);
        return result;
      };
    };

    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
    window.addEventListener('popstate', handleRouteChange);
    window.addEventListener('hashchange', handleRouteChange);
  }

  function buildExportSnapshot() {
    return {
      exportedAt: new Date().toISOString(),
      script: {
        name: SCRIPT_NAME,
        version: SCRIPT_VERSION,
      },
      config: runtime.config,
      persisted: runtime.persisted,
      runtime: {
        currentUserId: runtime.currentUserId,
        requestContext: runtime.requestContext,
        runner: runtime.runner
          ? {
              status: runtime.runner.status,
              sourceMode: runtime.runner.sourceMode,
              nextRefreshAt: runtime.runner.nextRefreshAt,
              stats: runtime.runner.stats,
            }
          : null,
      },
    };
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  }

  function exportState() {
    const snapshot = JSON.stringify(buildExportSnapshot(), null, 2);
    let copied = false;
    safeCall(() => {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(snapshot, 'text');
        copied = true;
      }
    });
    if (!copied && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(snapshot).catch(() => {});
      copied = true;
    }
    if (!copied) {
      downloadText('gcores-auto-like-export.json', snapshot);
    }
    notify(copied ? '状态已复制到剪贴板。' : '状态文件已下载。');
  }

  function editConfig() {
    const nextRaw = window.prompt('编辑 GM_config JSON', JSON.stringify(runtime.config, null, 2));
    if (!nextRaw) {
      return;
    }
    const parsed = safeJsonParse(nextRaw);
    if (!parsed) {
      window.alert('JSON 格式无效，配置未修改。');
      return;
    }
    saveConfig(parsed);
    notify('配置已更新。');
  }

  function registerMenuCommands() {
    if (runtime.menuReady || typeof GM_registerMenuCommand !== 'function') {
      return;
    }
    runtime.menuReady = true;
    GM_registerMenuCommand('开始运行', () => {
      if (!runtime.runner) {
        runtime.runner = new Runner();
      }
      if (runtime.runner.status === 'paused') {
        runtime.runner.resume();
      } else {
        runtime.runner.start();
      }
    });
    GM_registerMenuCommand('暂停运行', () => runtime.runner?.pause());
    GM_registerMenuCommand('停止运行', () => runtime.runner?.stop());
    GM_registerMenuCommand('切换试运行', () => {
      runtime.config.dryRun = !runtime.config.dryRun;
      saveConfig(runtime.config);
    });
    GM_registerMenuCommand('编辑配置', () => editConfig());
    GM_registerMenuCommand('导出状态', () => exportState());
    GM_registerMenuCommand('清空已处理缓存', () => {
      clearProcessedCache();
      notify('已处理缓存已清空。');
    });
  }

  function bootstrap() {
    const migrated = migrateConfigForCurrentPageMode(loadConfig());
    runtime.config = migrated.config;
    runtime.persisted = loadPersisted();
    runtime.requestContext.csrfToken = getCsrfToken();
    runtime.currentUserId = detectCurrentUserId();
    runtime.persisted.dailyCounter = resetDailyCounter(runtime.persisted.dailyCounter);
    savePersisted();
    saveConfig(runtime.config);
    if (migrated.changed) {
      notify('已自动关闭最大时效、点赞上限和默认内容类型限制。');
    }
    registerMenuCommands();

    const observer = new NetworkObserver();
    observer.install();
    installRouteObserver();

    window.GCoresAutoLikeAssistant = {
      startRun() {
        if (!runtime.runner) {
          runtime.runner = new Runner();
        }
        return runtime.runner.start();
      },
      pauseRun() {
        runtime.runner?.pause();
      },
      stopRun() {
        runtime.runner?.stop();
      },
      listFeedPage,
      createVote,
      updateVote,
      deleteVote,
      getConfig() {
        return deepClone(runtime.config);
      },
      getState() {
        return buildExportSnapshot();
      },
    };

    const mountPanel = () => {
      if (!document.body) {
        return;
      }
      runtime.ui = new Panel();
      runtime.ui.mount();
      updateUi();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
    } else {
      mountPanel();
    }

    window.addEventListener(
      'load',
      () => {
        runtime.currentUserId = detectCurrentUserId();
        runtime.requestContext.csrfToken = getCsrfToken();
        updateUi();
        if (runtime.config.autoStart || isLoopEnabled()) {
          if (!runtime.runner) {
            runtime.runner = new Runner();
          }
          setTimeout(() => runtime.runner.start(), 1500);
        }
      },
      { once: true }
    );
  }

  bootstrap();
})();

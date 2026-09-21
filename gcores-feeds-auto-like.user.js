// ==UserScript==
// @name         GCORES 动态自动点赞助手
// @namespace    https://www.gcores.com/
// @version      0.4.0
// @description  机核动态与话题首页自动点赞助手，支持可视化配置、点赞历史、随机限速和刷新倒计时。
// @match        https://www.gcores.com/feeds*
// @match        https://www.gcores.com/topics/home*
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
  const SCRIPT_VERSION = '0.4.0';
  const CONFIG_REVISION = 2;
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
  const LIKE_HISTORY_MAX_ITEMS = 500;
  const STATUS_TEXT = {
    idle: '空闲',
    running: '运行中',
    waiting_refresh: '等待刷新',
    paused: '已暂停',
    stopped: '已停止',
    cooldown: '冷却中',
    login_required: '需要登录',
    not_supported: '不在支持页面',
  };
  const SOURCE_MODE_TEXT = {
    api: '接口',
    'api-sample': '接口样本',
    dom: '页面按钮',
    none: '未校准',
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
  const ENTRY_TYPE_LABELS = {
    articles: '文章',
    videos: '视频',
    radios: '电台',
    talks: '动态',
    discussions: '讨论',
    originals: '原创',
    timelines: '时间线',
    portfolios: '作品集',
    albums: '专辑',
    collections: '合集',
    products: '商品',
    games: '游戏',
    films: '电影',
    'external-links': '外部链接',
    dom: '页面内容',
    unknown: '未知类型',
  };

  const STORAGE_KEYS = {
    config: 'gcores-auto-like:config',
    persisted: 'gcores-auto-like:persisted',
  };
  const SESSION_KEYS = {
    loopEnabled: 'gcores-auto-like:loop-enabled',
    nextRefreshAt: 'gcores-auto-like:next-refresh-at',
  };

  const DEFAULT_CONFIG = {
    configRevision: CONFIG_REVISION,
    autoStart: false,
    dryRun: false,
    debug: false,
    limits: {
      maxLikesPerRun: 0,
      maxLikesPerDay: 0,
      maxConsecutiveErrors: 3,
    },
    timing: {
      actionDelayMsRange: [2500, 7000],
      cooldownAfterBlockMs: 60 * 60 * 1000,
      refreshIntervalMsRange: [40 * 60 * 1000, 70 * 60 * 1000],
      nightRefreshIntervalMsRange: [80 * 60 * 1000, 120 * 60 * 1000],
      quietHours: {
        enabled: true,
        startHour: 1,
        endHour: 8,
      },
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
    safety: {
      allowApiFallback: false,
    },
  };

  const DEFAULT_PERSISTED = {
    processed: {},
    dailyCounter: {
      date: '',
      likes: 0,
    },
    likeHistory: [],
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

  function equalRanges(left, right) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      Number(left[0]) === Number(right[0]) &&
      Number(left[1]) === Number(right[1])
    );
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

  function sanitizeLikeHistory(history) {
    if (!Array.isArray(history)) {
      return [];
    }
    return history
      .map((entry) => {
        if (!isObject(entry)) {
          return null;
        }
        const likedAt = clampNumber(entry.likedAt || entry.at, 0, 0);
        const key = cleanText(entry.key || entry.itemKey);
        if (!likedAt || !key) {
          return null;
        }
        return {
          key,
          likedAt,
          title: cleanText(entry.title || '未命名内容'),
          url: cleanText(entry.url),
          targetType: normalizeToken(entry.targetType || 'unknown'),
          authors: uniqueStrings(Array.isArray(entry.authors) ? entry.authors : []),
          topics: uniqueStrings(Array.isArray(entry.topics) ? entry.topics : []),
          mode: cleanText(entry.mode || 'dom'),
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.likedAt - left.likedAt)
      .slice(0, LIKE_HISTORY_MAX_ITEMS);
  }

  function sanitizeConfig(config) {
    const inputTiming = isObject(config?.timing) ? config.timing : {};
    const inputConfigRevision = clampNumber(config?.configRevision, 0, 0);
    const merged = deepMerge(DEFAULT_CONFIG, isObject(config) ? config : {});
    merged.configRevision = inputConfigRevision;
    merged.autoStart = Boolean(merged.autoStart);
    merged.dryRun = Boolean(merged.dryRun);
    merged.debug = Boolean(merged.debug);
    merged.limits.maxLikesPerRun = clampNumber(merged.limits.maxLikesPerRun, DEFAULT_CONFIG.limits.maxLikesPerRun, 0);
    merged.limits.maxLikesPerDay = clampNumber(merged.limits.maxLikesPerDay, DEFAULT_CONFIG.limits.maxLikesPerDay, 0);
    delete merged.limits.maxPagesPerRun;
    merged.limits.maxConsecutiveErrors = clampNumber(
      merged.limits.maxConsecutiveErrors,
      DEFAULT_CONFIG.limits.maxConsecutiveErrors,
      1
    );
    merged.timing.actionDelayMsRange = sanitizeRange(
      merged.timing.actionDelayMsRange,
      DEFAULT_CONFIG.timing.actionDelayMsRange
    );
    delete merged.timing.pageDelayMsRange;
    merged.timing.cooldownAfterBlockMs = clampNumber(
      merged.timing.cooldownAfterBlockMs,
      DEFAULT_CONFIG.timing.cooldownAfterBlockMs,
      1000
    );
    const legacyRefreshIntervalMs = clampNumber(inputTiming.refreshIntervalMs, 0, 0);
    const refreshRangeInput = Array.isArray(inputTiming.refreshIntervalMsRange)
      ? inputTiming.refreshIntervalMsRange
      : legacyRefreshIntervalMs > 0
        ? [Math.round(legacyRefreshIntervalMs * 0.8), Math.round(legacyRefreshIntervalMs * 1.2)]
        : DEFAULT_CONFIG.timing.refreshIntervalMsRange;
    merged.timing.refreshIntervalMsRange = sanitizeRange(
      refreshRangeInput,
      DEFAULT_CONFIG.timing.refreshIntervalMsRange
    ).map((value) => Math.max(60 * 1000, value));
    merged.timing.nightRefreshIntervalMsRange = sanitizeRange(
      inputTiming.nightRefreshIntervalMsRange,
      DEFAULT_CONFIG.timing.nightRefreshIntervalMsRange
    ).map((value) => Math.max(60 * 1000, value));
    merged.timing.quietHours = isObject(merged.timing.quietHours)
      ? merged.timing.quietHours
      : deepClone(DEFAULT_CONFIG.timing.quietHours);
    merged.timing.quietHours.enabled = Boolean(merged.timing.quietHours.enabled);
    merged.timing.quietHours.startHour = Math.min(
      23,
      Math.floor(clampNumber(merged.timing.quietHours.startHour, DEFAULT_CONFIG.timing.quietHours.startHour, 0))
    );
    merged.timing.quietHours.endHour = Math.min(
      23,
      Math.floor(clampNumber(merged.timing.quietHours.endHour, DEFAULT_CONFIG.timing.quietHours.endHour, 0))
    );
    delete merged.timing.refreshIntervalMs;
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
    merged.safety = isObject(merged.safety) ? merged.safety : deepClone(DEFAULT_CONFIG.safety);
    merged.safety.allowApiFallback = Boolean(merged.safety.allowApiFallback);
    return merged;
  }

  function migrateConfigForCurrentPageMode(config) {
    const next = sanitizeConfig(config);
    let changed = false;
    let defaultsChanged = false;

    if (next.configRevision < CONFIG_REVISION) {
      const oldRefreshRanges = [
        [4 * 60 * 1000, 8 * 60 * 1000],
        [4 * 60 * 1000, 6 * 60 * 1000],
      ];
      if (oldRefreshRanges.some((range) => equalRanges(next.timing.refreshIntervalMsRange, range))) {
        next.timing.refreshIntervalMsRange = DEFAULT_CONFIG.timing.refreshIntervalMsRange.slice();
      }
      if (equalRanges(next.timing.nightRefreshIntervalMsRange, [20 * 60 * 1000, 40 * 60 * 1000])) {
        next.timing.nightRefreshIntervalMsRange = DEFAULT_CONFIG.timing.nightRefreshIntervalMsRange.slice();
      }
      next.dryRun = false;
      next.configRevision = CONFIG_REVISION;
      changed = true;
      defaultsChanged = true;
    }

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
      defaultsChanged,
    };
  }

  function sanitizePersisted(persisted) {
    const merged = deepMerge(DEFAULT_PERSISTED, isObject(persisted) ? persisted : {});
    merged.processed = trimProcessedCache(merged.processed);
    merged.dailyCounter = resetDailyCounter(merged.dailyCounter);
    merged.likeHistory = sanitizeLikeHistory(merged.likeHistory);
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

  function isHourInWindow(hour, startHour, endHour) {
    if (startHour === endHour) {
      return false;
    }
    if (startHour < endHour) {
      return hour >= startHour && hour < endHour;
    }
    return hour >= startHour || hour < endHour;
  }

  function buildRefreshSchedule(now = Date.now()) {
    const quietHours = runtime.config.timing.quietHours;
    const hour = new Date(now).getHours();
    const isNight =
      quietHours.enabled && isHourInWindow(hour, quietHours.startHour, quietHours.endHour);
    const range = isNight
      ? runtime.config.timing.nightRefreshIntervalMsRange
      : runtime.config.timing.refreshIntervalMsRange;
    const delayMs = randomBetween(...range);
    return {
      delayMs,
      range: range.slice(),
      mode: isNight ? 'night' : 'normal',
    };
  }

  function formatCountdown(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function formatMinuteRange(range) {
    const values = sanitizeRange(range, [0, 0]).map((value) => Math.round(value / 60000));
    return values[0] === values[1] ? `${values[0]} 分钟` : `${values[0]}–${values[1]} 分钟`;
  }

  function formatDelayRange(range) {
    const values = sanitizeRange(range, [0, 0]);
    if (values[1] < 60 * 1000) {
      const seconds = values.map((value) => Math.round(value / 100) / 10);
      return seconds[0] === seconds[1] ? `${seconds[0]} 秒` : `${seconds[0]}–${seconds[1]} 秒`;
    }
    return formatMinuteRange(values);
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

  function isSupportedPage() {
    return /^\/feeds(?:\/|$)/.test(location.pathname) || /^\/topics\/home(?:\/|$)/.test(location.pathname);
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
      const authorLinks = Array.from(container?.querySelectorAll('a[href*="/users/"]') || []);
      const authorIds = uniqueStrings(
        authorLinks.map((link) => link.getAttribute('href').match(/\/users\/(\d+)/)?.[1]).filter(Boolean)
      );
      const authors = uniqueStrings(authorLinks.map((link) => cleanText(link.textContent || '')).filter(Boolean));
      const topicLinks = Array.from(container?.querySelectorAll('a[href*="/topics/"]') || []);
      const topicIds = uniqueStrings(
        topicLinks.flatMap((link) => {
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
      const topics = uniqueStrings(
        topicLinks.flatMap((link) => {
          const text = cleanText(link.textContent || '');
          if (text) {
            return [text];
          }
          const match = (link.getAttribute('href') || '').match(/\/topics\/([^/?#]+)/);
          return match ? [match[1]] : [];
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
        authors,
        topicIds,
        topics,
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

  function markProcessed(itemKey, status, shouldSave = true) {
    runtime.persisted.processed[itemKey] = {
      ts: Date.now(),
      status: cleanText(status || 'processed'),
    };
    if (shouldSave) {
      savePersisted();
    }
  }

  function wasProcessed(itemKey) {
    runtime.persisted.processed = trimProcessedCache(runtime.persisted.processed);
    return Boolean(runtime.persisted.processed[itemKey]);
  }

  function clearProcessedCache() {
    runtime.persisted.processed = {};
    savePersisted();
  }

  function incrementDailyLikes(shouldSave = true) {
    runtime.persisted.dailyCounter = resetDailyCounter(runtime.persisted.dailyCounter);
    runtime.persisted.dailyCounter.likes += 1;
    if (shouldSave) {
      savePersisted();
    }
  }

  function recordLikeHistory(item, mode, shouldSave = true) {
    const key = buildItemKey(item);
    const record = {
      key,
      likedAt: Date.now(),
      title: cleanText(item.title || `${item.targetType || 'content'}/${item.targetId || key}`),
      url: cleanText(item.url || buildEntryUrl(item.targetType, item.targetId)),
      targetType: normalizeToken(item.targetType || 'unknown'),
      authors: uniqueStrings(item.authors?.length ? item.authors : item.authorIds || []),
      topics: uniqueStrings(item.topics?.length ? item.topics : item.topicIds || []),
      mode: cleanText(mode || 'dom'),
    };
    const history = sanitizeLikeHistory(runtime.persisted.likeHistory);
    runtime.persisted.likeHistory = [record, ...history.filter((entry) => entry.key !== key)].slice(
      0,
      LIKE_HISTORY_MAX_ITEMS
    );
    if (shouldSave) {
      savePersisted();
    }
  }

  function clearLikeHistory() {
    runtime.persisted.likeHistory = [];
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
        authors: authorIds,
        topicIds,
        topics: topicIds,
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
    let domError = null;
    try {
      return await clickDomLikeButton(item);
    } catch (error) {
      domError = error;
      logDebug('DOM vote click failed, falling back to request mode', error);
    }

    if (!runtime.config.safety.allowApiFallback) {
      throw domError || new Error('页面点赞按钮点击失败');
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
        if (error instanceof BlockedRequestError) {
          throw error;
        }
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

  class Runner {
    constructor() {
      this.status = 'idle';
      this.sourceMode = 'dom';
      this.shouldStop = false;
      this.refreshTimerId = null;
      this.nextRefreshAt = 0;
      this.refreshScheduleMode = 'normal';
      this.refreshDelayMs = 0;
      this.pausedFromStatus = null;
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

    clearRefreshTimerHandle() {
      if (this.refreshTimerId) {
        window.clearTimeout(this.refreshTimerId);
        this.refreshTimerId = null;
      }
    }

    clearRefreshTimer() {
      this.clearRefreshTimerHandle();
      this.nextRefreshAt = 0;
      this.refreshDelayMs = 0;
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

    canAutoRefresh() {
      return (
        !this.shouldStop &&
        this.status !== 'paused' &&
        isLoopEnabled() &&
        !this.hasReachedDailyLimit() &&
        !isCooldownActive() &&
        isSupportedPage()
      );
    }

    armRefreshTimer() {
      this.clearRefreshTimerHandle();
      if (!this.canAutoRefresh() || !this.nextRefreshAt) {
        return;
      }
      const remainingMs = Math.max(0, this.nextRefreshAt - Date.now());
      this.refreshTimerId = window.setTimeout(() => {
        this.refreshTimerId = null;
        this.refreshIfDue('timer');
      }, remainingMs);
    }

    refreshIfDue(trigger) {
      if (!this.canAutoRefresh()) {
        return false;
      }
      const scheduledAt = this.nextRefreshAt || getScheduledRefreshAt();
      if (!scheduledAt) {
        return false;
      }
      this.nextRefreshAt = scheduledAt;
      const remainingMs = scheduledAt - Date.now();
      if (remainingMs > 250) {
        this.armRefreshTimer();
        updateUi();
        return false;
      }
      logDebug(`Refresh deadline reached via ${trigger || 'unknown'}`);
      this.clearRefreshTimerHandle();
      setScheduledRefreshAt(0);
      window.location.reload();
      return true;
    }

    recoverRefreshSchedule(trigger) {
      if (this.status !== 'waiting_refresh' || !isLoopEnabled()) {
        updateUi();
        return false;
      }
      const scheduledAt = this.nextRefreshAt || getScheduledRefreshAt();
      if (!scheduledAt) {
        this.scheduleRefresh();
        return false;
      }
      this.nextRefreshAt = scheduledAt;
      if (Date.now() >= scheduledAt) {
        return this.refreshIfDue(trigger || 'lifecycle');
      }
      this.armRefreshTimer();
      updateUi();
      return false;
    }

    scheduleRefresh() {
      this.clearRefreshTimer();
      if (this.shouldStop || this.status === 'paused' || !isLoopEnabled()) {
        return;
      }
      if (this.hasReachedDailyLimit() || isCooldownActive() || !isSupportedPage()) {
        return;
      }
      const schedule = buildRefreshSchedule();
      this.refreshScheduleMode = schedule.mode;
      this.refreshDelayMs = schedule.delayMs;
      this.nextRefreshAt = Date.now() + schedule.delayMs;
      setScheduledRefreshAt(this.nextRefreshAt);
      this.status = 'waiting_refresh';
      updateUi();
      this.armRefreshTimer();
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

      if (!isSupportedPage()) {
        this.status = 'not_supported';
        this.disableLoop();
        setLastError('请先打开机核动态页 /feeds 或话题首页 /topics/home 再运行脚本。');
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
      this.pausedFromStatus = null;
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
        if (this.status === 'cooldown' || this.status === 'login_required' || this.status === 'not_supported') {
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
        this.pausedFromStatus = this.status;
        setLoopEnabled(false);
        this.clearRefreshTimer();
        this.status = 'paused';
        updateUi();
      }
    }

    resume() {
      if (this.status === 'paused') {
        const previousStatus = this.pausedFromStatus;
        this.pausedFromStatus = null;
        this.enableLoop();
        if (previousStatus === 'waiting_refresh') {
          this.status = 'waiting_refresh';
          this.scheduleRefresh();
          return;
        }
        this.status = 'running';
        updateUi();
      }
    }

    stop() {
      this.shouldStop = true;
      this.pausedFromStatus = null;
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
      const ready = await waitFor(() => extractDomFeedItems().length > 0 || !isSupportedPage(), 10000, 250);
      if (this.shouldStop) {
        return;
      }
      if (!isSupportedPage()) {
        this.status = 'not_supported';
        this.shouldStop = true;
        setLastError('你已经离开机核动态页或话题首页，脚本已自动停止。');
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
            markProcessed(itemKey, result.mode || 'liked', false);
            incrementDailyLikes(false);
            recordLikeHistory(item, result.mode || 'liked', false);
            savePersisted();
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
      this.clockTimerId = null;
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
          right: 14px;
          bottom: 14px;
          width: min(360px, calc(100vw - 28px));
          z-index: 2147483647;
          font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #18212f;
          background: rgba(255, 255, 255, 0.97);
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
        .status[data-status="running"] { color: #166534; background: #dcfce7; }
        .status[data-status="waiting_refresh"] { color: #1d4ed8; background: #dbeafe; }
        .status[data-status="paused"] { color: #92400e; background: #fef3c7; }
        .status[data-status="cooldown"],
        .status[data-status="login_required"] { color: #b91c1c; background: #fee2e2; }
        .body { padding: 12px 14px 14px; }
        .countdown-card {
          display: grid;
          grid-template-columns: 1fr auto;
          align-items: center;
          gap: 4px 12px;
          margin-bottom: 11px;
          padding: 11px 12px;
          border-radius: 13px;
          color: #eff6ff;
          background: linear-gradient(135deg, #172554, #1d4ed8 58%, #0891b2);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
        }
        .countdown-label { font-size: 11px; color: rgba(239, 246, 255, 0.78); }
        .countdown-value {
          grid-row: 1 / span 2;
          grid-column: 2;
          min-width: 94px;
          text-align: right;
          font: 750 27px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          letter-spacing: -0.04em;
          font-variant-numeric: tabular-nums;
        }
        .countdown-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
        button:disabled { opacity: 0.42; cursor: not-allowed; }
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
        button.active {
          color: #1d4ed8;
          border-color: rgba(37, 99, 235, 0.35);
          background: #eff6ff;
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
        @media (prefers-color-scheme: dark) {
          .panel {
            color: #e5e7eb;
            background: rgba(15, 23, 42, 0.97);
            border-color: rgba(148, 163, 184, 0.25);
            box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
          }
          .header { background: linear-gradient(135deg, #111827, #172554); border-bottom-color: rgba(148, 163, 184, 0.18); }
          .version, .row { color: #cbd5e1; }
          button { color: #e5e7eb; background: #1e293b; border-color: rgba(148, 163, 184, 0.24); }
          button:hover { background: #273449; }
          button.primary { background: #f8fafc; color: #111827; border-color: #f8fafc; }
          button.warn { background: #431407; color: #fdba74; border-color: rgba(251, 146, 60, 0.35); }
          button.active { color: #93c5fd; background: #172554; border-color: rgba(96, 165, 250, 0.4); }
          .rules { color: #cbd5e1; background: #111827; border-color: rgba(148, 163, 184, 0.16); }
        }

        :host, :host * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        .panel {
          right: 18px;
          bottom: 18px;
          width: min(390px, calc(100vw - 24px));
          max-height: calc(100vh - 36px);
          color: #172033;
          background: rgba(250, 251, 255, 0.97);
          border: 1px solid rgba(80, 94, 125, 0.18);
          border-radius: 22px;
          box-shadow: 0 24px 70px rgba(31, 41, 72, 0.24), 0 4px 16px rgba(31, 41, 72, 0.1);
          font: 13px/1.45 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          overflow: auto;
          scrollbar-width: thin;
        }
        .header {
          position: sticky;
          top: 0;
          z-index: 2;
          padding: 14px 16px;
          background: rgba(255, 255, 255, 0.9);
          border-bottom: 1px solid rgba(80, 94, 125, 0.1);
          backdrop-filter: blur(18px);
        }
        .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .brand-mark {
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          flex: 0 0 auto;
          color: #fff;
          background: linear-gradient(145deg, #6d5dfc, #3b82f6);
          border-radius: 11px;
          box-shadow: 0 7px 18px rgba(79, 70, 229, 0.3);
          font-size: 17px;
          font-weight: 850;
          letter-spacing: -0.04em;
        }
        .title { color: #111827; font-size: 14px; font-weight: 800; letter-spacing: -0.01em; }
        .version { margin-top: 1px; color: #8992a6; font-size: 10px; font-weight: 650; letter-spacing: 0.05em; }
        .status {
          flex: 0 0 auto;
          padding: 5px 9px;
          color: #475569;
          background: #eef1f7;
          border: 1px solid rgba(71, 85, 105, 0.08);
          font-size: 10px;
          letter-spacing: 0;
          text-transform: none;
        }
        .body { padding: 14px; }
        .countdown-card {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-height: 88px;
          margin-bottom: 12px;
          padding: 16px;
          overflow: hidden;
          border-radius: 18px;
          background:
            radial-gradient(circle at 92% 0%, rgba(125, 211, 252, 0.42), transparent 35%),
            linear-gradient(135deg, #312e81 0%, #4f46e5 47%, #0284c7 100%);
          box-shadow: 0 14px 30px rgba(67, 56, 202, 0.22);
        }
        .countdown-card::after {
          content: "";
          position: absolute;
          right: -22px;
          bottom: -48px;
          width: 128px;
          height: 128px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-radius: 50%;
        }
        .countdown-copy { position: relative; z-index: 1; min-width: 0; padding-right: 12px; }
        .countdown-label { margin-bottom: 6px; color: rgba(255, 255, 255, 0.72); font-size: 11px; font-weight: 650; }
        .countdown-meta { color: #fff; font-size: 12px; font-weight: 650; white-space: normal; }
        .countdown-value {
          position: relative;
          z-index: 1;
          grid-row: auto;
          grid-column: auto;
          min-width: 108px;
          color: #fff;
          font: 800 31px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          letter-spacing: -0.055em;
          text-shadow: 0 2px 12px rgba(15, 23, 42, 0.2);
        }
        .controls { margin-bottom: 0; }
        .main-controls { gap: 8px; margin-bottom: 12px; }
        .main-controls button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          min-height: 40px;
          border-radius: 12px;
          font-weight: 720;
        }
        .button-icon { font-size: 10px; opacity: 0.76; }
        button {
          transition: transform 150ms ease, background 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
        }
        button:hover:not(:disabled) { transform: translateY(-1px); }
        button:active:not(:disabled) { transform: translateY(0); }
        button.primary {
          color: #fff;
          background: linear-gradient(135deg, #4f46e5, #2563eb);
          border-color: transparent;
          box-shadow: 0 7px 16px rgba(79, 70, 229, 0.22);
        }
        button.warn { color: #b45309; background: #fffaf2; border-color: #fed7aa; }
        .metrics {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 7px;
          margin-bottom: 12px;
        }
        .metric {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1px;
          padding: 9px 4px 8px;
          background: #fff;
          border: 1px solid rgba(80, 94, 125, 0.1);
          border-radius: 13px;
        }
        .metric.accent { background: #eef2ff; border-color: #d9ddff; }
        .metric-value { color: #172033; font-size: 18px; font-weight: 820; font-variant-numeric: tabular-nums; }
        .metric.accent .metric-value { color: #4f46e5; }
        .metric-label { color: #8a94a8; font-size: 9px; white-space: nowrap; }
        .strategy-card {
          margin-bottom: 11px;
          padding: 13px;
          background: #fff;
          border: 1px solid rgba(80, 94, 125, 0.11);
          border-radius: 16px;
        }
        .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .section-title { color: #172033; font-size: 13px; font-weight: 780; }
        .section-subtitle { margin-top: 1px; color: #9aa3b5; font-size: 10px; }
        .mode-toggle {
          flex: 0 0 auto;
          padding: 5px 9px;
          color: #4f46e5;
          background: #eef2ff;
          border-color: #d9ddff;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 750;
        }
        .mode-toggle.live { color: #047857; background: #ecfdf5; border-color: #a7f3d0; }
        .strategy-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 11px; }
        .strategy-tag {
          display: inline-flex;
          padding: 4px 7px;
          color: #556176;
          background: #f4f6fa;
          border-radius: 7px;
          font-size: 10px;
          font-weight: 620;
        }
        .strategy-summary {
          margin-top: 9px;
          color: #667085;
          font-size: 11px;
          line-height: 1.65;
          white-space: pre-wrap;
        }
        .error-card {
          margin-bottom: 11px;
          padding: 10px 11px;
          color: #b42318;
          background: #fff4f2;
          border: 1px solid #fecdca;
          border-radius: 12px;
          font-size: 11px;
        }
        .settings-button {
          display: grid;
          grid-template-columns: auto 1fr auto;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 11px 12px;
          text-align: left;
          background: #172033;
          border-color: #172033;
          border-radius: 14px;
          color: #fff;
        }
        .settings-button:hover { background: #222d43; }
        .settings-icon {
          display: grid;
          place-items: center;
          width: 30px;
          height: 30px;
          color: #c7d2fe;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 9px;
          font-size: 15px;
        }
        .settings-button strong, .settings-button small { display: block; }
        .settings-button strong { font-size: 12px; }
        .settings-button small { margin-top: 1px; color: #aeb8ca; font-size: 9px; }
        .settings-arrow { color: #8f9bb0; font-size: 22px; font-weight: 300; }
        .history-button {
          display: grid;
          grid-template-columns: 1fr auto auto;
          align-items: center;
          gap: 9px;
          width: 100%;
          margin-top: 8px;
          padding: 9px 12px;
          color: #475467;
          text-align: left;
          background: #fff;
          border-color: rgba(80, 94, 125, 0.12);
          border-radius: 12px;
        }
        .history-button strong, .history-button small { display: block; }
        .history-button strong { color: #344054; font-size: 11px; }
        .history-button small { margin-top: 1px; color: #98a2b3; font-size: 9px; }
        .history-count {
          padding: 3px 7px;
          color: #4f46e5;
          background: #eef2ff;
          border-radius: 999px;
          font-size: 9px;
          font-weight: 750;
        }
        .more-panel { margin-top: 9px; color: #7b8498; font-size: 10px; }
        .more-panel summary { padding: 4px 2px; cursor: pointer; user-select: none; }
        .diagnostics {
          margin: 7px 0;
          padding: 10px;
          color: #697386;
          background: #f2f4f8;
          border-radius: 10px;
          line-height: 1.65;
          white-space: pre-wrap;
        }
        .secondary-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
        .secondary-controls button { padding: 7px; font-size: 10px; }

        .settings-backdrop {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: grid;
          place-items: center;
          padding: 24px;
          color: #172033;
          background: rgba(12, 18, 32, 0.58);
          backdrop-filter: blur(8px);
          font: 13px/1.45 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .settings-modal {
          display: flex;
          flex-direction: column;
          width: min(720px, 100%);
          max-height: min(88vh, 850px);
          overflow: hidden;
          background: #f8f9fc;
          border: 1px solid rgba(255, 255, 255, 0.42);
          border-radius: 22px;
          box-shadow: 0 30px 100px rgba(0, 0, 0, 0.34);
        }
        .settings-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 17px 20px;
          background: #fff;
          border-bottom: 1px solid #e8ebf2;
        }
        .settings-title { color: #111827; font-size: 17px; font-weight: 820; letter-spacing: -0.02em; }
        .settings-subtitle { margin-top: 2px; color: #8a94a8; font-size: 11px; }
        .icon-button {
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          padding: 0;
          color: #667085;
          background: #f3f5f9;
          border: 0;
          border-radius: 10px;
          font-size: 22px;
          line-height: 1;
        }
        .settings-content {
          padding: 16px;
          overflow: auto;
          scrollbar-width: thin;
        }
        .settings-section {
          margin-bottom: 14px;
          padding: 16px;
          background: #fff;
          border: 1px solid #e7eaf1;
          border-radius: 16px;
        }
        .settings-section-title { color: #172033; font-size: 14px; font-weight: 800; }
        .settings-section-desc { margin: 3px 0 13px; color: #8a94a8; font-size: 11px; }
        .switch-list { border-top: 1px solid #eef0f4; }
        .switch-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          min-height: 54px;
          border-bottom: 1px solid #eef0f4;
          cursor: pointer;
        }
        .switch-row.compact { min-height: 44px; border-bottom: 0; }
        .switch-row span, .danger-option span { min-width: 0; }
        .switch-row strong, .switch-row small, .danger-option strong, .danger-option small { display: block; }
        .switch-row strong, .danger-option strong { color: #344054; font-size: 12px; }
        .switch-row small, .danger-option small { margin-top: 2px; color: #98a2b3; font-size: 10px; }
        input[type="checkbox"] {
          width: 17px;
          height: 17px;
          flex: 0 0 auto;
          accent-color: #4f46e5;
        }
        .switch-row > input[type="checkbox"] {
          appearance: none;
          position: relative;
          width: 36px;
          height: 21px;
          background: #d7dce5;
          border: 0;
          border-radius: 999px;
          outline: none;
          cursor: pointer;
          transition: background 160ms ease;
        }
        .switch-row > input[type="checkbox"]::after {
          content: "";
          position: absolute;
          top: 3px;
          left: 3px;
          width: 15px;
          height: 15px;
          background: #fff;
          border-radius: 50%;
          box-shadow: 0 1px 4px rgba(15, 23, 42, 0.24);
          transition: transform 160ms ease;
        }
        .switch-row > input[type="checkbox"]:checked { background: #5b51ed; }
        .switch-row > input[type="checkbox"]:checked::after { transform: translateX(15px); }
        .switch-row > input[type="checkbox"]:focus-visible { box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18); }
        .field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
        .field-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 0;
          color: #475467;
          font-size: 11px;
          font-weight: 650;
        }
        .field.full { margin-top: 12px; }
        .field > small { color: #98a2b3; font-size: 9px; font-weight: 500; }
        input[type="number"], select, textarea {
          width: 100%;
          min-width: 0;
          color: #344054;
          background: #fafbfc;
          border: 1px solid #dfe3eb;
          border-radius: 9px;
          outline: none;
          font: inherit;
          font-weight: 500;
        }
        input[type="number"], select { height: 36px; padding: 0 9px; }
        textarea { padding: 9px 10px; resize: vertical; line-height: 1.5; }
        input:focus, select:focus, textarea:focus { border-color: #818cf8; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1); }
        .range-inputs { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 7px; }
        .range-inputs b { color: #98a2b3; font-size: 10px; font-weight: 600; }
        .subsection {
          margin-top: 14px;
          padding: 5px 12px 13px;
          background: #f8f9fc;
          border: 1px solid #e9ecf2;
          border-radius: 12px;
        }
        .choice-grid { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 4px; }
        .choice-chip { cursor: pointer; }
        .choice-chip input { position: absolute; opacity: 0; pointer-events: none; }
        .choice-chip span {
          display: inline-flex;
          padding: 6px 9px;
          color: #667085;
          background: #f6f7fa;
          border: 1px solid #e5e8ef;
          border-radius: 8px;
          font-size: 10px;
          font-weight: 650;
          transition: all 140ms ease;
        }
        .choice-chip input:checked + span { color: #4338ca; background: #eef2ff; border-color: #c7d2fe; }
        .settings-details {
          margin-top: 13px;
          overflow: hidden;
          background: #f9fafc;
          border: 1px solid #e7eaf1;
          border-radius: 12px;
        }
        .settings-details > summary {
          padding: 11px 13px;
          color: #475467;
          cursor: pointer;
          font-size: 11px;
          font-weight: 720;
        }
        .settings-details.advanced { margin: 0 0 4px; background: #fff; }
        .details-body { margin-top: 0; padding: 0 13px 13px; }
        .details-body.field-grid { padding-top: 0; }
        .checkbox-field { align-items: flex-start; }
        .danger-option {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          margin-top: 14px;
          padding: 11px;
          color: #b54708;
          background: #fffaeb;
          border: 1px solid #fedf89;
          border-radius: 10px;
          cursor: pointer;
        }
        .settings-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 13px 18px;
          background: #fff;
          border-top: 1px solid #e8ebf2;
        }
        .settings-footer > div { display: flex; gap: 8px; }
        .settings-footer button { min-width: 88px; padding: 9px 13px; }
        .settings-footer .text-button { min-width: 0; padding-left: 0; color: #667085; background: transparent; border: 0; }
        .history-modal { width: min(780px, 100%); }
        .history-content {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 16px;
          overflow: auto;
          scrollbar-width: thin;
        }
        .history-card {
          padding: 13px 14px;
          background: #fff;
          border: 1px solid #e7eaf1;
          border-radius: 14px;
        }
        .history-card-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
          padding-bottom: 10px;
          border-bottom: 1px solid #eef0f4;
        }
        .history-item-title {
          min-width: 0;
          overflow: hidden;
          color: #172033;
          font-size: 12px;
          font-weight: 760;
          text-decoration: none;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        a.history-item-title:hover { color: #4f46e5; text-decoration: underline; }
        .history-card-header time { flex: 0 0 auto; color: #98a2b3; font-size: 9px; }
        .history-meta-grid {
          display: grid;
          grid-template-columns: 0.75fr 1fr 1.25fr;
          gap: 10px;
          padding-top: 10px;
        }
        .history-meta-field { min-width: 0; }
        .history-meta-field span, .history-meta-field strong { display: block; }
        .history-meta-field span { margin-bottom: 2px; color: #98a2b3; font-size: 9px; }
        .history-meta-field strong {
          overflow: hidden;
          color: #475467;
          font-size: 10px;
          font-weight: 650;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .history-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 240px;
          padding: 30px;
          color: #98a2b3;
          text-align: center;
        }
        .history-empty strong { margin-bottom: 5px; color: #475467; font-size: 14px; }
        .history-empty span { font-size: 11px; }
        .history-footer { color: #98a2b3; font-size: 9px; }
        .history-footer button { color: #b42318; background: #fff4f2; border-color: #fecdca; }

        @media (max-width: 640px) {
          .panel { right: 8px; bottom: 8px; width: calc(100vw - 16px); max-height: calc(100vh - 16px); }
          .settings-backdrop { padding: 8px; }
          .settings-modal { max-height: calc(100vh - 16px); border-radius: 16px; }
          .field-grid, .field-grid.three { grid-template-columns: 1fr; }
          .settings-content { padding: 10px; }
          .settings-section { padding: 13px; }
          .history-meta-grid { grid-template-columns: 1fr; }
          .history-card-header { flex-direction: column; gap: 4px; }
        }

        @media (prefers-color-scheme: dark) {
          .panel { color: #e5e7eb; background: rgba(16, 22, 36, 0.97); border-color: rgba(148, 163, 184, 0.2); }
          .header { background: rgba(17, 24, 39, 0.9); border-bottom-color: rgba(148, 163, 184, 0.12); }
          .title, .section-title, .metric-value { color: #f8fafc; }
          .metric, .strategy-card { background: #151d2c; border-color: rgba(148, 163, 184, 0.12); }
          .metric.accent, .mode-toggle { background: #202756; border-color: #343c78; }
          .metric-label, .section-subtitle, .strategy-summary { color: #98a4b8; }
          .strategy-tag, .diagnostics { color: #aeb8c9; background: #202838; }
          .settings-button { background: #293249; border-color: #293249; }
          .history-button, .history-card { color: #d0d5dd; background: #151d2c; border-color: rgba(148, 163, 184, 0.12); }
          .history-button strong, .history-item-title, .history-meta-field strong, .history-empty strong { color: #e2e8f0; }
          .history-card-header { border-color: rgba(148, 163, 184, 0.12); }
          .history-count { color: #c7d2fe; background: #292a63; }
          .more-panel { color: #9aa5b8; }
          .settings-modal { color: #e5e7eb; background: #111827; border-color: rgba(148, 163, 184, 0.18); }
          .settings-header, .settings-footer, .settings-section, .settings-details.advanced {
            background: #182132;
            border-color: rgba(148, 163, 184, 0.13);
          }
          .settings-title, .settings-section-title, .switch-row strong, .danger-option strong { color: #f1f5f9; }
          .settings-subtitle, .settings-section-desc, .switch-row small, .field > small { color: #8f9bb0; }
          .switch-list, .switch-row { border-color: rgba(148, 163, 184, 0.12); }
          .field { color: #c7d0df; }
          input[type="number"], select, textarea { color: #e2e8f0; background: #111827; border-color: #344054; }
          .subsection, .settings-details { background: #111827; border-color: #303b4f; }
          .choice-chip span { color: #aeb8c9; background: #202838; border-color: #344054; }
          .choice-chip input:checked + span { color: #c7d2fe; background: #292a63; border-color: #4f52a5; }
          .danger-option { background: #3b2a12; border-color: #7a5521; }
          .settings-footer button:not(.primary) { color: #d0d5dd; background: #202838; border-color: #344054; }
        }
      `;

      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.innerHTML = `
        <div class='header'>
          <div class='brand'>
            <div class='brand-mark'>G</div>
            <div>
              <div class='title'>动态点赞助手</div>
              <div class='version'>GCORES · v${SCRIPT_VERSION}</div>
            </div>
          </div>
          <div class='status' id='status'>空闲</div>
        </div>
        <div class='body'>
          <div class='countdown-card'>
            <div class='countdown-copy'>
              <div class='countdown-label' id='countdownLabel'>自动循环</div>
              <div class='countdown-meta' id='countdownMeta'>尚未安排刷新</div>
            </div>
            <div class='countdown-value' id='countdown'>--:--</div>
          </div>

          <div class='controls main-controls'>
            <button class='primary' data-action='start'><span class='button-icon'>▶</span><span>开始</span></button>
            <button data-action='pause'><span class='button-icon'>Ⅱ</span><span>暂停</span></button>
            <button class='warn' data-action='stop'><span class='button-icon'>■</span><span>停止</span></button>
          </div>

          <div class='metrics'>
            <div class='metric'><span class='metric-value' id='metricScanned'>0</span><span class='metric-label'>已扫描</span></div>
            <div class='metric'><span class='metric-value' id='metricMatched'>0</span><span class='metric-label'>已命中</span></div>
            <div class='metric accent'><span class='metric-value' id='metricLiked'>0</span><span class='metric-label'>本轮点赞</span></div>
            <div class='metric'><span class='metric-value' id='metricDaily'>0</span><span class='metric-label'>今日累计</span></div>
          </div>

          <div class='strategy-card'>
            <div class='section-heading'>
              <div>
                <div class='section-title'>当前策略</div>
                <div class='section-subtitle'>只展示实际生效的规则</div>
              </div>
              <button class='mode-toggle' data-action='toggleDryRun' id='modeToggle'>安全预览</button>
            </div>
            <div class='strategy-tags' id='strategyTags'></div>
            <div class='strategy-summary' id='strategySummary'></div>
          </div>

          <div class='error-card' id='error' hidden></div>

          <button class='settings-button' data-action='edit'>
            <span class='settings-icon'>⚙</span>
            <span><strong>可视化配置</strong><small>刷新节奏、点赞上限和内容筛选</small></span>
            <span class='settings-arrow'>›</span>
          </button>

          <button class='history-button' data-action='history'>
            <span><strong>点赞历史</strong><small>查看类型、作者和话题</small></span>
            <span class='history-count' id='historyCount'>0 条</span>
            <span class='settings-arrow'>›</span>
          </button>

          <details class='more-panel'>
            <summary>更多操作与运行信息</summary>
            <div class='diagnostics' id='diagnostics'></div>
            <div class='secondary-controls'>
              <button data-action='export'>导出状态</button>
              <button data-action='clear'>清空已处理缓存</button>
            </div>
          </details>
        </div>
      `;

      const settingsBackdrop = document.createElement('div');
      settingsBackdrop.className = 'settings-backdrop';
      settingsBackdrop.hidden = true;
      settingsBackdrop.innerHTML = this.buildSettingsMarkup();

      const historyBackdrop = document.createElement('div');
      historyBackdrop.className = 'settings-backdrop history-backdrop';
      historyBackdrop.hidden = true;
      historyBackdrop.innerHTML = this.buildHistoryMarkup();

      shadow.appendChild(style);
      shadow.appendChild(panel);
      shadow.appendChild(settingsBackdrop);
      shadow.appendChild(historyBackdrop);

      this.elements.panel = panel;
      this.elements.settingsBackdrop = settingsBackdrop;
      this.elements.settingsForm = settingsBackdrop.querySelector('#settingsForm');
      this.elements.historyBackdrop = historyBackdrop;
      this.elements.historyList = historyBackdrop.querySelector('#historyList');
      this.elements.historyCount = shadow.getElementById('historyCount');
      this.elements.status = shadow.getElementById('status');
      this.elements.countdown = shadow.getElementById('countdown');
      this.elements.countdownLabel = shadow.getElementById('countdownLabel');
      this.elements.countdownMeta = shadow.getElementById('countdownMeta');
      this.elements.metricScanned = shadow.getElementById('metricScanned');
      this.elements.metricMatched = shadow.getElementById('metricMatched');
      this.elements.metricLiked = shadow.getElementById('metricLiked');
      this.elements.metricDaily = shadow.getElementById('metricDaily');
      this.elements.strategyTags = shadow.getElementById('strategyTags');
      this.elements.strategySummary = shadow.getElementById('strategySummary');
      this.elements.diagnostics = shadow.getElementById('diagnostics');
      this.elements.error = shadow.getElementById('error');
      this.elements.buttons = {};

      shadow.querySelectorAll('button[data-action]').forEach((button) => {
        this.elements.buttons[button.getAttribute('data-action')] = button;
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
            this.openSettings();
          } else if (action === 'history') {
            this.openHistory();
          } else if (action === 'export') {
            exportState();
          } else if (action === 'clear') {
            if (window.confirm('确定清空已处理缓存吗？清空后，当前页内容可能会再次进入处理队列。')) {
              clearProcessedCache();
            }
          } else if (action === 'settingsClose' || action === 'settingsCancel') {
            this.closeSettings();
          } else if (action === 'historyClose') {
            this.closeHistory();
          } else if (action === 'historyClear') {
            if (window.confirm('确定清空点赞历史吗？该操作不会影响已处理缓存和今日计数。')) {
              clearLikeHistory();
              this.renderHistory();
              notify('点赞历史已清空。');
            }
          } else if (action === 'settingsReset') {
            if (window.confirm('确定恢复推荐配置吗？现有筛选规则和时间设置会被覆盖。')) {
              const resetConfig = deepClone(DEFAULT_CONFIG);
              resetConfig.cooldown.blockedUntil = runtime.config.cooldown.blockedUntil;
              saveConfig(resetConfig);
              if (runtime.runner?.status === 'waiting_refresh' && isLoopEnabled()) {
                runtime.runner.scheduleRefresh();
              }
              this.fillSettingsForm(runtime.config);
              notify('已恢复推荐配置。');
            }
          }
        });
      });

      this.elements.settingsForm.addEventListener('submit', (event) => {
        event.preventDefault();
        this.saveSettingsForm();
      });
      settingsBackdrop.addEventListener('click', (event) => {
        if (event.target === settingsBackdrop) {
          this.closeSettings();
        }
      });
      settingsBackdrop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          this.closeSettings();
        }
      });
      historyBackdrop.addEventListener('click', (event) => {
        if (event.target === historyBackdrop) {
          this.closeHistory();
        }
      });
      historyBackdrop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          this.closeHistory();
        }
      });

      this.update();
      this.startClock();
    }

    buildHourOptions() {
      return Array.from({ length: 24 }, (_, hour) => {
        const label = `${String(hour).padStart(2, '0')}:00`;
        return `<option value='${hour}'>${label}</option>`;
      }).join('');
    }

    buildEntryTypeChoices() {
      return KNOWN_ENTRY_TYPES.map((type) => {
        const label = ENTRY_TYPE_LABELS[type] || type;
        return `
          <label class='choice-chip'>
            <input type='checkbox' name='entryType' value='${type}'>
            <span>${label}</span>
          </label>
        `;
      }).join('');
    }

    buildHistoryMarkup() {
      return `
        <div class='settings-modal history-modal' role='dialog' aria-modal='true' aria-labelledby='historyTitle'>
          <div class='settings-header'>
            <div>
              <div class='settings-title' id='historyTitle'>点赞历史</div>
              <div class='settings-subtitle'>仅记录脚本真实点赞成功的内容，最多保留 ${LIKE_HISTORY_MAX_ITEMS} 条</div>
            </div>
            <button type='button' class='icon-button' data-action='historyClose' aria-label='关闭'>×</button>
          </div>
          <div class='history-content' id='historyList'></div>
          <div class='settings-footer history-footer'>
            <span>内容类型、作者和话题来自点赞时的页面信息</span>
            <button type='button' data-action='historyClear'>清空历史</button>
          </div>
        </div>
      `;
    }

    buildSettingsMarkup() {
      const hourOptions = this.buildHourOptions();
      return `
        <form class='settings-modal' id='settingsForm'>
          <div class='settings-header'>
            <div>
              <div class='settings-title'>自动点赞配置</div>
              <div class='settings-subtitle'>常用选项直接调整，高级设置默认折叠</div>
            </div>
            <button type='button' class='icon-button' data-action='settingsClose' aria-label='关闭'>×</button>
          </div>

          <div class='settings-content'>
            <section class='settings-section'>
              <div class='settings-section-title'>运行方式</div>
              <div class='settings-section-desc'>建议先使用安全预览确认筛选结果，再关闭预览进行真实点赞。</div>
              <div class='switch-list'>
                <label class='switch-row'>
                  <span><strong>安全预览</strong><small>只统计命中内容，不执行点赞</small></span>
                  <input type='checkbox' name='dryRun'>
                </label>
                <label class='switch-row'>
                  <span><strong>打开支持页面后自动开始</strong><small>进入动态页或话题首页后自动运行一轮</small></span>
                  <input type='checkbox' name='autoStart'>
                </label>
                <label class='switch-row'>
                  <span><strong>只处理尚未点赞的内容</strong><small>避免误触导致取消点赞</small></span>
                  <input type='checkbox' name='onlyUnliked'>
                </label>
              </div>
              <div class='field-grid three'>
                <label class='field'>
                  <span>每轮最多点赞</span>
                  <input type='number' name='maxLikesPerRun' min='0' step='1'>
                  <small>0 表示不限</small>
                </label>
                <label class='field'>
                  <span>每天最多点赞</span>
                  <input type='number' name='maxLikesPerDay' min='0' step='1'>
                  <small>0 表示不限</small>
                </label>
                <label class='field'>
                  <span>内容最大时效</span>
                  <input type='number' name='maxAgeHours' min='0' step='1'>
                  <small>小时，0 表示不限</small>
                </label>
              </div>
            </section>

            <section class='settings-section'>
              <div class='settings-section-title'>运行节奏</div>
              <div class='settings-section-desc'>每一轮都会在区间内重新随机，倒计时显示本轮实际选中的时间。</div>
              <div class='field-grid'>
                <label class='field'>
                  <span>两次点赞间隔（秒）</span>
                  <div class='range-inputs'>
                    <input type='number' name='actionDelayMinSec' min='0.5' step='0.5'>
                    <b>至</b>
                    <input type='number' name='actionDelayMaxSec' min='0.5' step='0.5'>
                  </div>
                </label>
                <label class='field'>
                  <span>日间刷新间隔（分钟）</span>
                  <div class='range-inputs'>
                    <input type='number' name='refreshMinMin' min='1' step='1'>
                    <b>至</b>
                    <input type='number' name='refreshMaxMin' min='1' step='1'>
                  </div>
                </label>
              </div>

              <div class='subsection'>
                <label class='switch-row compact'>
                  <span><strong>启用夜间低频模式</strong><small>在指定时段自动延长刷新间隔</small></span>
                  <input type='checkbox' name='quietEnabled'>
                </label>
                <div class='field-grid three'>
                  <label class='field'>
                    <span>开始时间</span>
                    <select name='quietStartHour'>${hourOptions}</select>
                  </label>
                  <label class='field'>
                    <span>结束时间</span>
                    <select name='quietEndHour'>${hourOptions}</select>
                  </label>
                  <label class='field'>
                    <span>夜间刷新（分钟）</span>
                    <div class='range-inputs'>
                      <input type='number' name='nightRefreshMinMin' min='1' step='1'>
                      <b>至</b>
                      <input type='number' name='nightRefreshMaxMin' min='1' step='1'>
                    </div>
                  </label>
                </div>
              </div>
            </section>

            <section class='settings-section'>
              <div class='settings-section-title'>内容筛选</div>
              <div class='settings-section-desc'>所有“允许”项都为空时，默认处理当前页全部可见内容；屏蔽规则始终优先生效。</div>

              <label class='field full'>
                <span>允许的内容类型</span>
                <small>不选择代表不限制类型</small>
                <div class='choice-grid'>${this.buildEntryTypeChoices()}</div>
              </label>

              <div class='field-grid'>
                <label class='field'>
                  <span>只允许包含这些关键词</span>
                  <textarea name='allowKeywords' rows='3' placeholder='例如：独立游戏, 电影&#10;留空表示不限制'></textarea>
                  <small>逗号或换行分隔，满足任意一个即可</small>
                </label>
                <label class='field'>
                  <span>屏蔽包含这些关键词</span>
                  <textarea name='denyKeywords' rows='3' placeholder='例如：抽奖, 广告'></textarea>
                  <small>屏蔽规则优先于允许规则</small>
                </label>
              </div>

              <details class='settings-details'>
                <summary>作者与话题筛选</summary>
                <div class='details-body field-grid'>
                  <label class='field'>
                    <span>允许作者</span>
                    <textarea name='allowAuthors' rows='2' placeholder='作者用户 ID，逗号或换行分隔'></textarea>
                  </label>
                  <label class='field'>
                    <span>屏蔽作者</span>
                    <textarea name='denyAuthors' rows='2' placeholder='作者用户 ID，逗号或换行分隔'></textarea>
                  </label>
                  <label class='field'>
                    <span>允许话题</span>
                    <textarea name='allowTopics' rows='2' placeholder='话题名称、slug 或 ID'></textarea>
                  </label>
                  <label class='field'>
                    <span>屏蔽话题</span>
                    <textarea name='denyTopics' rows='2' placeholder='话题名称、slug 或 ID'></textarea>
                  </label>
                </div>
              </details>
            </section>

            <details class='settings-details advanced'>
              <summary>高级与故障处理</summary>
              <div class='details-body'>
                <div class='field-grid three'>
                  <label class='field'>
                    <span>连续错误上限</span>
                    <input type='number' name='maxConsecutiveErrors' min='1' step='1'>
                  </label>
                  <label class='field'>
                    <span>风控冷却（分钟）</span>
                    <input type='number' name='cooldownMinutes' min='1' step='1'>
                  </label>
                  <label class='field checkbox-field'>
                    <span>调试日志</span>
                    <input type='checkbox' name='debug'>
                  </label>
                </div>
                <label class='danger-option'>
                  <input type='checkbox' name='apiFallback'>
                  <span><strong>启用 API 兜底</strong><small>页面按钮失效时尝试接口请求，可能增加异常请求，不建议日常开启。</small></span>
                </label>
              </div>
            </details>
          </div>

          <div class='settings-footer'>
            <button type='button' class='text-button' data-action='settingsReset'>恢复推荐值</button>
            <div>
              <button type='button' data-action='settingsCancel'>取消</button>
              <button type='submit' class='primary'>保存配置</button>
            </div>
          </div>
        </form>
      `;
    }

    getFormField(name) {
      return this.elements.settingsForm?.elements?.namedItem(name) || null;
    }

    setFormValue(name, value) {
      const field = this.getFormField(name);
      if (field) {
        field.value = String(value ?? '');
      }
    }

    setFormChecked(name, checked) {
      const field = this.getFormField(name);
      if (field) {
        field.checked = Boolean(checked);
      }
    }

    fillSettingsForm(config) {
      const timing = config.timing;
      const filters = config.filters;
      this.setFormChecked('dryRun', config.dryRun);
      this.setFormChecked('autoStart', config.autoStart);
      this.setFormChecked('onlyUnliked', filters.onlyUnliked);
      this.setFormValue('maxLikesPerRun', config.limits.maxLikesPerRun);
      this.setFormValue('maxLikesPerDay', config.limits.maxLikesPerDay);
      this.setFormValue('maxAgeHours', filters.maxAgeHours);
      this.setFormValue('actionDelayMinSec', timing.actionDelayMsRange[0] / 1000);
      this.setFormValue('actionDelayMaxSec', timing.actionDelayMsRange[1] / 1000);
      this.setFormValue('refreshMinMin', timing.refreshIntervalMsRange[0] / 60000);
      this.setFormValue('refreshMaxMin', timing.refreshIntervalMsRange[1] / 60000);
      this.setFormChecked('quietEnabled', timing.quietHours.enabled);
      this.setFormValue('quietStartHour', timing.quietHours.startHour);
      this.setFormValue('quietEndHour', timing.quietHours.endHour);
      this.setFormValue('nightRefreshMinMin', timing.nightRefreshIntervalMsRange[0] / 60000);
      this.setFormValue('nightRefreshMaxMin', timing.nightRefreshIntervalMsRange[1] / 60000);
      this.setFormValue('allowKeywords', filters.allowKeywords.join('\n'));
      this.setFormValue('denyKeywords', filters.denyKeywords.join('\n'));
      this.setFormValue('allowAuthors', filters.allowAuthors.join('\n'));
      this.setFormValue('denyAuthors', filters.denyAuthors.join('\n'));
      this.setFormValue('allowTopics', filters.allowTopics.join('\n'));
      this.setFormValue('denyTopics', filters.denyTopics.join('\n'));
      this.setFormValue('maxConsecutiveErrors', config.limits.maxConsecutiveErrors);
      this.setFormValue('cooldownMinutes', Math.round(timing.cooldownAfterBlockMs / 60000));
      this.setFormChecked('debug', config.debug);
      this.setFormChecked('apiFallback', config.safety.allowApiFallback);
      const selectedTypes = new Set(filters.allowEntryTypes);
      this.elements.settingsForm.querySelectorAll('input[name="entryType"]').forEach((input) => {
        input.checked = selectedTypes.has(input.value);
      });
    }

    openSettings() {
      this.fillSettingsForm(runtime.config);
      this.elements.settingsBackdrop.hidden = false;
      window.setTimeout(() => this.getFormField('dryRun')?.focus(), 0);
    }

    closeSettings() {
      this.elements.settingsBackdrop.hidden = true;
    }

    openHistory() {
      this.renderHistory();
      this.elements.historyBackdrop.hidden = false;
      window.setTimeout(
        () => this.elements.historyBackdrop.querySelector('[data-action="historyClose"]')?.focus(),
        0
      );
    }

    closeHistory() {
      this.elements.historyBackdrop.hidden = true;
    }

    renderHistory() {
      const history = sanitizeLikeHistory(runtime.persisted.likeHistory);
      runtime.persisted.likeHistory = history;
      const list = this.elements.historyList;
      if (!list) {
        return;
      }
      if (history.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        const title = document.createElement('strong');
        title.textContent = '还没有点赞记录';
        const description = document.createElement('span');
        description.textContent = '关闭安全预览并成功点赞后，记录会出现在这里。';
        empty.append(title, description);
        list.replaceChildren(empty);
        return;
      }

      const createMeta = (label, value) => {
        const field = document.createElement('div');
        field.className = 'history-meta-field';
        const name = document.createElement('span');
        name.textContent = label;
        const content = document.createElement('strong');
        content.textContent = value;
        field.append(name, content);
        return field;
      };

      list.replaceChildren(
        ...history.map((entry) => {
          const card = document.createElement('article');
          card.className = 'history-card';
          const header = document.createElement('div');
          header.className = 'history-card-header';
          const title = entry.url ? document.createElement('a') : document.createElement('span');
          title.className = 'history-item-title';
          title.textContent = entry.title;
          if (entry.url) {
            title.href = entry.url;
            title.target = '_blank';
            title.rel = 'noopener noreferrer';
          }
          const time = document.createElement('time');
          time.textContent = new Date(entry.likedAt).toLocaleString('zh-CN', { hour12: false });
          header.append(title, time);
          const meta = document.createElement('div');
          meta.className = 'history-meta-grid';
          meta.append(
            createMeta('内容类型', ENTRY_TYPE_LABELS[entry.targetType] || entry.targetType || '未知'),
            createMeta('作者', entry.authors.join('、') || '未知作者'),
            createMeta('话题', entry.topics.join('、') || '未标记话题')
          );
          card.append(header, meta);
          return card;
        })
      );
    }

    parseListField(name) {
      const value = this.getFormField(name)?.value || '';
      return value
        .split(/[\n,，]+/)
        .map((item) => cleanText(item))
        .filter(Boolean);
    }

    readNumberField(name, fallback, minValue = 0) {
      const value = Number(this.getFormField(name)?.value);
      return Number.isFinite(value) ? Math.max(minValue, value) : fallback;
    }

    readRangeFields(minName, maxName, multiplier, fallback, minValue) {
      const min = this.readNumberField(minName, fallback[0] / multiplier, minValue);
      const max = this.readNumberField(maxName, fallback[1] / multiplier, minValue);
      return sanitizeRange([min * multiplier, max * multiplier], fallback);
    }

    saveSettingsForm() {
      const next = deepClone(runtime.config);
      const timing = next.timing;
      const filters = next.filters;
      next.dryRun = Boolean(this.getFormField('dryRun')?.checked);
      next.autoStart = Boolean(this.getFormField('autoStart')?.checked);
      next.debug = Boolean(this.getFormField('debug')?.checked);
      next.limits.maxLikesPerRun = this.readNumberField('maxLikesPerRun', next.limits.maxLikesPerRun, 0);
      next.limits.maxLikesPerDay = this.readNumberField('maxLikesPerDay', next.limits.maxLikesPerDay, 0);
      next.limits.maxConsecutiveErrors = this.readNumberField(
        'maxConsecutiveErrors',
        next.limits.maxConsecutiveErrors,
        1
      );
      filters.maxAgeHours = this.readNumberField('maxAgeHours', filters.maxAgeHours, 0);
      filters.onlyUnliked = Boolean(this.getFormField('onlyUnliked')?.checked);
      timing.actionDelayMsRange = this.readRangeFields(
        'actionDelayMinSec',
        'actionDelayMaxSec',
        1000,
        timing.actionDelayMsRange,
        0.5
      );
      timing.refreshIntervalMsRange = this.readRangeFields(
        'refreshMinMin',
        'refreshMaxMin',
        60000,
        timing.refreshIntervalMsRange,
        1
      );
      timing.nightRefreshIntervalMsRange = this.readRangeFields(
        'nightRefreshMinMin',
        'nightRefreshMaxMin',
        60000,
        timing.nightRefreshIntervalMsRange,
        1
      );
      timing.quietHours.enabled = Boolean(this.getFormField('quietEnabled')?.checked);
      timing.quietHours.startHour = Math.min(23, Math.floor(this.readNumberField('quietStartHour', 1, 0)));
      timing.quietHours.endHour = Math.min(23, Math.floor(this.readNumberField('quietEndHour', 8, 0)));
      timing.cooldownAfterBlockMs =
        this.readNumberField('cooldownMinutes', timing.cooldownAfterBlockMs / 60000, 1) * 60000;
      filters.allowKeywords = this.parseListField('allowKeywords');
      filters.denyKeywords = this.parseListField('denyKeywords');
      filters.allowAuthors = this.parseListField('allowAuthors');
      filters.denyAuthors = this.parseListField('denyAuthors');
      filters.allowTopics = this.parseListField('allowTopics');
      filters.denyTopics = this.parseListField('denyTopics');
      filters.allowEntryTypes = Array.from(
        this.elements.settingsForm.querySelectorAll('input[name="entryType"]:checked')
      ).map((input) => input.value);
      next.safety.allowApiFallback = Boolean(this.getFormField('apiFallback')?.checked);

      saveConfig(next);
      if (runtime.runner?.status === 'waiting_refresh' && isLoopEnabled()) {
        runtime.runner.scheduleRefresh();
      }
      this.closeSettings();
      notify('配置已保存并生效。');
    }

    startClock() {
      const tick = () => {
        if (!this.root) {
          return;
        }
        this.updateClock();
        this.clockTimerId = window.setTimeout(tick, document.hidden ? 15000 : 1000);
      };
      tick();
    }

    updateClock() {
      if (!this.elements.countdown) {
        return;
      }
      const runner = runtime.runner;
      const status = runner?.status || 'idle';
      const now = Date.now();
      const blockedUntil = getBlockedUntil();
      const nextRefreshAt = runner?.nextRefreshAt || getScheduledRefreshAt();
      const pageState = document.hidden ? '浏览器后台，恢复后会校时' : '页面前台';

      if (blockedUntil > now) {
        this.elements.countdownLabel.textContent = '风控冷却剩余';
        this.elements.countdown.textContent = formatCountdown(blockedUntil - now);
        this.elements.countdownMeta.textContent = `结束于 ${new Date(blockedUntil).toLocaleTimeString()} · ${pageState}`;
        return;
      }
      if (status === 'waiting_refresh' && nextRefreshAt > 0) {
        const remainingMs = nextRefreshAt - now;
        this.elements.countdownLabel.textContent = runner?.refreshScheduleMode === 'night' ? '夜间低频 · 下次刷新' : '下次随机刷新';
        this.elements.countdown.textContent = remainingMs > 0 ? formatCountdown(remainingMs) : '00:00';
        this.elements.countdownMeta.textContent = `预计 ${new Date(nextRefreshAt).toLocaleTimeString()} · ${pageState}`;
        if (remainingMs <= 0) {
          runner?.recoverRefreshSchedule('countdown');
        }
        return;
      }
      if (status === 'running') {
        this.elements.countdownLabel.textContent = '正在处理当前页';
        this.elements.countdown.textContent = '运行中';
        this.elements.countdownMeta.textContent = `完成后安排下一次随机刷新 · ${pageState}`;
        return;
      }
      if (status === 'paused') {
        this.elements.countdownLabel.textContent = '自动循环已暂停';
        this.elements.countdown.textContent = '暂停';
        this.elements.countdownMeta.textContent = '点击“继续”后重新安排刷新';
        return;
      }
      this.elements.countdownLabel.textContent = '自动循环';
      this.elements.countdown.textContent = '--:--';
      this.elements.countdownMeta.textContent = '点击“开始”运行并安排刷新';
    }

    renderStrategy() {
      const tags = [];
      const filters = runtime.config.filters;
      const quietHours = runtime.config.timing.quietHours;
      tags.push(runtime.config.dryRun ? '安全预览' : '真实点赞');
      tags.push(`日间 ${formatMinuteRange(runtime.config.timing.refreshIntervalMsRange)}`);
      if (quietHours.enabled) {
        tags.push(`夜间 ${quietHours.startHour}:00–${quietHours.endHour}:00`);
      }
      if (filters.onlyUnliked) {
        tags.push('仅未点赞');
      }
      if (isPositiveLimit(runtime.config.limits.maxLikesPerDay)) {
        tags.push(`每日上限 ${runtime.config.limits.maxLikesPerDay}`);
      }
      this.elements.strategyTags.replaceChildren(
        ...tags.map((label) => {
          const tag = document.createElement('span');
          tag.className = 'strategy-tag';
          tag.textContent = label;
          return tag;
        })
      );
      this.elements.strategySummary.textContent = summarizeFilters(filters);
    }

    update() {
      if (!this.root) {
        return;
      }
      const runner = runtime.runner;
      const status = runner?.status || 'idle';
      const stats = runner?.stats || {};
      const dailyLimitText = formatLimitValue(runtime.config.limits.maxLikesPerDay);
      this.elements.status.textContent = STATUS_TEXT[status] || status;
      this.elements.status.dataset.status = status;
      this.elements.metricScanned.textContent = String(stats.scanned || 0);
      this.elements.metricMatched.textContent = String(stats.matched || 0);
      this.elements.metricLiked.textContent = String(stats.liked || 0);
      this.elements.metricDaily.textContent = String(runtime.persisted.dailyCounter.likes || 0);
      this.elements.historyCount.textContent = `${runtime.persisted.likeHistory.length} 条`;
      if (!this.elements.historyBackdrop.hidden) {
        this.renderHistory();
      }
      this.elements.diagnostics.textContent = [
        `来源：${SOURCE_MODE_TEXT[runner?.sourceMode || 'dom'] || '页面按钮'} · 当前页按钮 ${runtime.domButtons.size} 个`,
        `点赞间隔：${formatDelayRange(runtime.config.timing.actionDelayMsRange)}随机`,
        `今日累计：${runtime.persisted.dailyCounter.likes}/${dailyLimitText} · 用户 ${runtime.currentUserId || '未知'}`,
        `页面状态：${document.hidden ? '后台（恢复后自动校时）' : '前台'} · API 兜底${runtime.config.safety.allowApiFallback ? '已开启' : '已关闭'}`,
      ].join('\n');

      if (runtime.persisted.lastError) {
        this.elements.error.hidden = false;
        this.elements.error.textContent = `最近一次异常：${runtime.persisted.lastError.message}`;
      } else {
        this.elements.error.hidden = true;
        this.elements.error.textContent = '';
      }

      this.renderStrategy();
      const startButton = this.elements.buttons.start;
      const pauseButton = this.elements.buttons.pause;
      const stopButton = this.elements.buttons.stop;
      const dryRunButton = this.elements.buttons.toggleDryRun;
      if (startButton) {
        const label = startButton.querySelector('span:last-child');
        if (label) {
          label.textContent = status === 'paused' ? '继续' : status === 'waiting_refresh' ? '立即运行' : '开始';
        }
        startButton.disabled = status === 'running';
      }
      if (pauseButton) {
        pauseButton.disabled = !['running', 'waiting_refresh'].includes(status);
      }
      if (stopButton) {
        stopButton.disabled = !['running', 'waiting_refresh', 'paused'].includes(status);
      }
      if (dryRunButton) {
        dryRunButton.classList.toggle('live', !runtime.config.dryRun);
        dryRunButton.textContent = runtime.config.dryRun ? '安全预览' : '真实点赞';
      }
      this.updateClock();
    }
  }

  function summarizeFilters(filters) {
    const previewList = (items, limit = 4) => {
      const visible = items.slice(0, limit);
      return `${visible.join('、')}${items.length > limit ? ` 等 ${items.length} 项` : ''}`;
    };
    const lines = [];
    if (!hasAnyAllowRules(filters)) {
      lines.push('范围：当前页全部可见内容');
    } else {
      const allowParts = [];
      if (filters.allowEntryTypes.length) {
        allowParts.push(`类型 ${previewList(filters.allowEntryTypes.map((type) => ENTRY_TYPE_LABELS[type] || type), 5)}`);
      }
      if (filters.allowKeywords.length) {
        allowParts.push(`关键词 ${previewList(filters.allowKeywords)}`);
      }
      if (filters.allowAuthors.length) {
        allowParts.push(`${filters.allowAuthors.length} 位指定作者`);
      }
      if (filters.allowTopics.length) {
        allowParts.push(`${filters.allowTopics.length} 个指定话题`);
      }
      lines.push(`只允许：${allowParts.join('；')}`);
    }
    const denyParts = [];
    if (filters.denyKeywords.length) {
      denyParts.push(`关键词 ${previewList(filters.denyKeywords)}`);
    }
    if (filters.denyAuthors.length) {
      denyParts.push(`${filters.denyAuthors.length} 位作者`);
    }
    if (filters.denyTopics.length) {
      denyParts.push(`${filters.denyTopics.length} 个话题`);
    }
    if (denyParts.length) {
      lines.push(`优先屏蔽：${denyParts.join('；')}`);
    }
    lines.push(
      isPositiveLimit(filters.maxAgeHours)
        ? `时效：只处理 ${filters.maxAgeHours} 小时内的内容`
        : '时效：不限制发布时间'
    );
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
      !isSupportedPage()
    ) {
      runtime.runner.stop();
      runtime.runner.status = 'not_supported';
      setLastError('你已经离开机核动态页或话题首页，脚本已自动停止。');
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

  function installLifecycleObserver() {
    const recover = (event) => {
      if (event?.type === 'visibilitychange' && document.hidden) {
        updateUi();
        return;
      }
      runtime.runner?.recoverRefreshSchedule(event?.type || 'lifecycle');
      updateUi();
    };
    document.addEventListener('visibilitychange', recover);
    window.addEventListener('focus', recover);
    window.addEventListener('pageshow', recover);
    window.addEventListener('online', recover);
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
              refreshScheduleMode: runtime.runner.refreshScheduleMode,
              refreshDelayMs: runtime.runner.refreshDelayMs,
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
    if (runtime.ui?.openSettings) {
      runtime.ui.openSettings();
      return;
    }
    notify('配置面板仍在载入，请稍后重试。');
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
    if (migrated.defaultsChanged) {
      notify('默认节奏已更新：白天 40–70 分钟、夜间 80–120 分钟，并已关闭安全预览。');
    } else if (migrated.changed) {
      notify('已自动关闭最大时效、点赞上限和默认内容类型限制。');
    }
    registerMenuCommands();

    if (runtime.config.safety.allowApiFallback) {
      const observer = new NetworkObserver();
      observer.install();
    }
    installRouteObserver();
    installLifecycleObserver();

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

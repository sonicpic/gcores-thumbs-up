'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const LOCAL_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.local.json');

const DEFAULT_CONFIG = {
  browser: {
    // 默认走无头渲染：不依赖桌面会话，RDP 断开后依然可以正常跑。
    headless: true,
    // chromium = Playwright 自带内核；msedge / chrome = 复用系统已安装的浏览器。
    channel: 'chromium',
    executablePath: '',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: '',
    viewport: { width: 1440, height: 2000 },
    extraArgs: [],
  },
  paths: {
    stateDir: '.gcores-auto-like',
    stateFile: '.gcores-auto-like/state.json',
    sessionFile: '.gcores-auto-like/session.json',
    logFile: '.gcores-auto-like/worker.log',
    errorScreenshotFile: '.gcores-auto-like/last-error.png',
    lockFile: '.gcores-auto-like/run.lock',
  },
  // 一次性导入登录态的来源，按顺序尝试；导入成功后运行期只读 session.json。
  session: {
    sources: [
      {
        type: 'profile',
        label: '旧版 Playwright Chromium profile',
        profileDir: 'D:/Workspace/gcores-thumbs-up/.gcores-playwright/profile',
        channel: 'chromium',
      },
      {
        type: 'profile',
        label: '本机 Edge（Default）',
        profileDir: '',
        channel: 'msedge',
        windowsProfile: 'edge-default',
      },
    ],
  },
  target: {
    feedsUrl: 'https://www.gcores.com/feeds',
  },
  ui: {
    // 本地控制台：只监听 127.0.0.1，用完即可关掉，不常驻。
    port: 7317,
    openBrowser: true,
  },
  run: {
    navigationTimeoutMs: 45000,
    waitForFeedMs: 20000,
    clickTimeoutMs: 8000,
    maxConsecutiveErrors: 3,
    navigationRetries: 3,
    // 单轮硬超时，防止任何一步卡死拖垮整个调度。
    maxRunMs: 300000,
    screenshotOnError: true,
  },
  limits: {
    maxLikesPerRun: 0,
    maxLikesPerDay: 0,
  },
  timing: {
    actionDelayMsRange: [2500, 7000],
    cooldownAfterBlockMs: 60 * 60 * 1000,
    // 每轮开始前的随机抖动：计划任务间隔本身做不到浮动，
    // 因此在这里随机睡一小段，避免执行时刻过于规律。
    jitterMsRange: [0, 120000],
  },
  schedule: {
    intervalMinutes: 30,
    taskName: 'GcoresAutoLike',
  },
  notifications: {
    enabled: true,
    pushplusToken: '',
    onLike: true,
    onFailure: true,
    onSessionExpired: true,
    onRunSummary: false,
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
  logging: {
    level: 'info',
    maxBytes: 2 * 1024 * 1024,
    keepFiles: 3,
  },
};

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

/**
 * 把 v0.2 的旧配置（headless / storage.* / daemon.* 平铺结构）平滑迁移到新结构。
 */
function migrateLegacyConfig(raw) {
  const next = deepClone(raw);
  if (typeof next.headless === 'boolean') {
    next.browser = isObject(next.browser) ? next.browser : {};
    if (typeof next.browser.headless !== 'boolean') {
      next.browser.headless = next.headless;
    }
    delete next.headless;
  }
  if (isObject(next.storage)) {
    next.paths = isObject(next.paths) ? next.paths : {};
    if (next.storage.stateFile && !next.paths.stateFile) next.paths.stateFile = next.storage.stateFile;
    if (next.storage.errorScreenshotFile && !next.paths.errorScreenshotFile) {
      next.paths.errorScreenshotFile = next.storage.errorScreenshotFile;
    }
    delete next.storage;
  }
  if (isObject(next.daemon)) {
    next.schedule = isObject(next.schedule) ? next.schedule : {};
    if (next.daemon.intervalMinutes && !next.schedule.intervalMinutes) {
      next.schedule.intervalMinutes = next.daemon.intervalMinutes;
    }
    delete next.daemon;
  }
  return next;
}

function sanitizeConfig(config) {
  const merged = deepMerge(DEFAULT_CONFIG, isObject(config) ? migrateLegacyConfig(config) : {});

  merged.browser.headless = merged.browser.headless !== false;
  merged.browser.channel = cleanText(merged.browser.channel) || DEFAULT_CONFIG.browser.channel;
  merged.browser.executablePath = cleanText(merged.browser.executablePath || '');
  merged.browser.locale = cleanText(merged.browser.locale || DEFAULT_CONFIG.browser.locale);
  merged.browser.timezoneId = cleanText(merged.browser.timezoneId || DEFAULT_CONFIG.browser.timezoneId);
  merged.browser.userAgent = cleanText(merged.browser.userAgent || '');
  merged.browser.viewport.width = clampNumber(merged.browser.viewport.width, DEFAULT_CONFIG.browser.viewport.width, 480);
  merged.browser.viewport.height = clampNumber(merged.browser.viewport.height, DEFAULT_CONFIG.browser.viewport.height, 480);
  merged.browser.extraArgs = Array.isArray(merged.browser.extraArgs)
    ? merged.browser.extraArgs.map((item) => cleanText(item)).filter(Boolean)
    : [];

  Object.keys(DEFAULT_CONFIG.paths).forEach((key) => {
    merged.paths[key] = cleanText(merged.paths[key] || DEFAULT_CONFIG.paths[key]);
  });

  merged.target.feedsUrl = cleanText(merged.target.feedsUrl || DEFAULT_CONFIG.target.feedsUrl);

  merged.ui = isObject(merged.ui) ? merged.ui : {};
  merged.ui.port = clampNumber(merged.ui.port, DEFAULT_CONFIG.ui.port, 1024);
  merged.ui.openBrowser = merged.ui.openBrowser !== false;

  merged.run.navigationTimeoutMs = clampNumber(merged.run.navigationTimeoutMs, DEFAULT_CONFIG.run.navigationTimeoutMs, 3000);
  merged.run.waitForFeedMs = clampNumber(merged.run.waitForFeedMs, DEFAULT_CONFIG.run.waitForFeedMs, 1000);
  merged.run.clickTimeoutMs = clampNumber(merged.run.clickTimeoutMs, DEFAULT_CONFIG.run.clickTimeoutMs, 500);
  merged.run.maxConsecutiveErrors = clampNumber(merged.run.maxConsecutiveErrors, DEFAULT_CONFIG.run.maxConsecutiveErrors, 1);
  merged.run.navigationRetries = clampNumber(merged.run.navigationRetries, DEFAULT_CONFIG.run.navigationRetries, 1);
  merged.run.maxRunMs = clampNumber(merged.run.maxRunMs, DEFAULT_CONFIG.run.maxRunMs, 10000);
  merged.run.screenshotOnError = merged.run.screenshotOnError !== false;

  merged.limits.maxLikesPerRun = clampNumber(merged.limits.maxLikesPerRun, 0, 0);
  merged.limits.maxLikesPerDay = clampNumber(merged.limits.maxLikesPerDay, 0, 0);

  merged.timing.actionDelayMsRange = sanitizeRange(merged.timing.actionDelayMsRange, DEFAULT_CONFIG.timing.actionDelayMsRange);
  merged.timing.cooldownAfterBlockMs = clampNumber(merged.timing.cooldownAfterBlockMs, DEFAULT_CONFIG.timing.cooldownAfterBlockMs, 1000);
  merged.timing.jitterMsRange = sanitizeRange(merged.timing.jitterMsRange, DEFAULT_CONFIG.timing.jitterMsRange);

  merged.schedule.intervalMinutes = clampNumber(merged.schedule.intervalMinutes, DEFAULT_CONFIG.schedule.intervalMinutes, 1);
  merged.schedule.taskName = cleanText(merged.schedule.taskName || DEFAULT_CONFIG.schedule.taskName);

  merged.notifications.enabled = merged.notifications.enabled !== false;
  merged.notifications.pushplusToken = cleanText(merged.notifications.pushplusToken || '');
  ['onLike', 'onFailure', 'onSessionExpired', 'onRunSummary'].forEach((key) => {
    merged.notifications[key] = Boolean(merged.notifications[key]);
  });

  merged.filters.allowAuthors = normalizeStringList(merged.filters.allowAuthors);
  merged.filters.allowTopics = normalizeStringList(merged.filters.allowTopics);
  merged.filters.allowKeywords = normalizeStringList(merged.filters.allowKeywords);
  merged.filters.allowEntryTypes = normalizeStringList(merged.filters.allowEntryTypes);
  merged.filters.denyAuthors = normalizeStringList(merged.filters.denyAuthors);
  merged.filters.denyTopics = normalizeStringList(merged.filters.denyTopics);
  merged.filters.denyKeywords = normalizeStringList(merged.filters.denyKeywords);
  merged.filters.maxAgeHours = clampNumber(merged.filters.maxAgeHours, 0, 0);
  merged.filters.onlyUnliked = merged.filters.onlyUnliked !== false;

  merged.session.sources = Array.isArray(merged.session.sources)
    ? merged.session.sources.filter((item) => isObject(item) && cleanText(item.type || 'profile') === 'profile')
    : [];

  merged.logging.level = ['debug', 'info', 'warn', 'error'].includes(merged.logging.level) ? merged.logging.level : 'info';
  merged.logging.maxBytes = clampNumber(merged.logging.maxBytes, DEFAULT_CONFIG.logging.maxBytes, 64 * 1024);
  merged.logging.keepFiles = clampNumber(merged.logging.keepFiles, DEFAULT_CONFIG.logging.keepFiles, 0);

  return merged;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

module.exports = {
  PROJECT_ROOT,
  CONFIG_PATH,
  LOCAL_CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  sanitizeConfig,
  deepMerge,
  deepClone,
  isObject,
  cleanText,
  normalizeToken,
  normalizeStringList,
  clampNumber,
  readJsonFile,
  writeJsonFile,
};

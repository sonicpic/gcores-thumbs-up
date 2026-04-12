const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const LOCAL_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.local.json');

const DEFAULT_CONFIG = {
  headless: false,
  storage: {
    userDataDir: '.gcores-playwright/profile',
    stateFile: '.gcores-playwright/state.json',
    errorScreenshotFile: '.gcores-playwright/last-error.png',
  },
  browser: {
    viewport: {
      width: 1600,
      height: 2200,
    },
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
  daemon: {
    intervalMinutes: 30,
  },
  notifications: {
    enabled: true,
    pushplusToken: '',
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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
  merged.browser.viewport.height = clampNumber(
    merged.browser.viewport.height,
    DEFAULT_CONFIG.browser.viewport.height,
    600
  );

  merged.run.navigationTimeoutMs = clampNumber(
    merged.run.navigationTimeoutMs,
    DEFAULT_CONFIG.run.navigationTimeoutMs,
    5000
  );
  merged.run.waitForFeedMs = clampNumber(merged.run.waitForFeedMs, DEFAULT_CONFIG.run.waitForFeedMs, 5000);
  merged.run.clickTimeoutMs = clampNumber(merged.run.clickTimeoutMs, DEFAULT_CONFIG.run.clickTimeoutMs, 1000);
  merged.run.maxConsecutiveErrors = clampNumber(
    merged.run.maxConsecutiveErrors,
    DEFAULT_CONFIG.run.maxConsecutiveErrors,
    1
  );

  merged.limits.maxLikesPerRun = clampNumber(merged.limits.maxLikesPerRun, DEFAULT_CONFIG.limits.maxLikesPerRun, 0);
  merged.limits.maxLikesPerDay = clampNumber(merged.limits.maxLikesPerDay, DEFAULT_CONFIG.limits.maxLikesPerDay, 0);

  merged.timing.actionDelayMsRange = sanitizeRange(
    merged.timing.actionDelayMsRange,
    DEFAULT_CONFIG.timing.actionDelayMsRange
  );
  merged.timing.cooldownAfterBlockMs = clampNumber(
    merged.timing.cooldownAfterBlockMs,
    DEFAULT_CONFIG.timing.cooldownAfterBlockMs,
    1000
  );

  merged.daemon = isObject(merged.daemon) ? merged.daemon : {};
  merged.daemon.intervalMinutes = clampNumber(
    merged.daemon.intervalMinutes,
    DEFAULT_CONFIG.daemon.intervalMinutes,
    1
  );

  merged.notifications = isObject(merged.notifications) ? merged.notifications : {};
  merged.notifications.enabled =
    typeof merged.notifications.enabled === 'boolean' ? merged.notifications.enabled : DEFAULT_CONFIG.notifications.enabled;
  merged.notifications.pushplusToken = cleanText(merged.notifications.pushplusToken || '');

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

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    writeJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
  }

  const baseConfig = readJsonFile(CONFIG_PATH);
  const localConfig = fs.existsSync(LOCAL_CONFIG_PATH) ? readJsonFile(LOCAL_CONFIG_PATH) : {};

  // 统一从公开配置和本地覆盖配置合并，避免多套入口分叉。
  return sanitizeConfig(deepMerge(baseConfig, localConfig));
}

module.exports = {
  PROJECT_ROOT,
  CONFIG_PATH,
  LOCAL_CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  cleanText,
  clampNumber,
};

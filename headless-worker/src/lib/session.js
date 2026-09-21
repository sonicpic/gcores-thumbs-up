'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { cleanText, isObject } = require('./config');
const { writeJsonAtomic, readJsonSafe } = require('./store');

/** 浏览器内核只依赖配置，不依赖任何桌面会话。 */
function buildLaunchOptions(config, overrides = {}) {
  const options = {
    headless: config.browser.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--mute-audio',
      ...config.browser.extraArgs,
    ],
    ...overrides,
  };
  if (config.browser.executablePath) {
    options.executablePath = config.browser.executablePath;
  } else if (config.browser.channel && config.browser.channel !== 'builtin') {
    // channel=chromium 走完整内核的新无头模式；msedge/chrome 复用系统浏览器。
    options.channel = config.browser.channel;
  }
  return options;
}

function buildContextOptions(config, storageState) {
  const options = {
    locale: config.browser.locale,
    timezoneId: config.browser.timezoneId,
    viewport: { width: config.browser.viewport.width, height: config.browser.viewport.height },
    deviceScaleFactor: 1,
  };
  if (config.browser.userAgent) {
    options.userAgent = config.browser.userAgent;
  }
  if (storageState) {
    options.storageState = storageState;
  }
  return options;
}

async function launchBrowser(config, overrides) {
  return chromium.launch(buildLaunchOptions(config, overrides));
}

/** 运行期上下文：只吃一份 session.json，不占用任何持久化 profile 目录。 */
async function newSessionContext(browser, config, storageState) {
  return browser.newContext(buildContextOptions(config, storageState));
}

function loadStorageState(sessionFile) {
  const raw = readJsonSafe(sessionFile, null);
  if (!isObject(raw) || !Array.isArray(raw.cookies)) {
    return null;
  }
  return raw;
}

function saveStorageState(sessionFile, state) {
  writeJsonAtomic(sessionFile, state);
}

/** 汇总会话健康度：有没有 gcores cookie、最近什么时候过期。 */
const AUTH_COOKIE_NAMES = ['appToken', 'userID'];
// 这几个是阿里云 WAF / 埋点产生的短命 cookie，不代表登录寿命，单列出来免得误判。
const NOISE_COOKIE_NAMES = ['acw_tc', 'sensorable', 'wechatTicket', 'gdxidpyhxdE'];

function toMillis(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1e12 ? number * 1000 : number;
}

function earliestExpiry(cookies) {
  const values = cookies.map((cookie) => toMillis(cookie.expires)).filter(Boolean);
  return values.length ? Math.min(...values) : 0;
}

function inspectStorageState(state) {
  const cookies = (state && state.cookies) || [];
  const gcoresCookies = cookies.filter((cookie) => /(^|\.)gcores\.com$/.test(String(cookie.domain || '')));
  const now = Date.now();
  const authCookies = gcoresCookies.filter((cookie) => AUTH_COOKIE_NAMES.includes(cookie.name));
  const noiseCookies = gcoresCookies.filter((cookie) => NOISE_COOKIE_NAMES.includes(cookie.name));
  const stableCookies = gcoresCookies.filter(
    (cookie) => !AUTH_COOKIE_NAMES.includes(cookie.name) && !NOISE_COOKIE_NAMES.includes(cookie.name)
  );
  const cookieExpiresAt = earliestExpiry(gcoresCookies);
  const authExpiresAt = earliestExpiry(authCookies);
  return {
    total: cookies.length,
    gcores: gcoresCookies.length,
    hasAuthCookie: authCookies.length > 0,
    authCookieNames: authCookies.map((cookie) => cookie.name).sort(),
    cookieNames: gcoresCookies.map((cookie) => cookie.name).sort(),
    transientCookieNames: noiseCookies.map((cookie) => cookie.name).sort(),
    /** 真正决定"还能免登录多久"的时间戳。 */
    authExpiresAt,
    authDaysLeft: authExpiresAt ? Math.round((authExpiresAt - now) / 86400000) : null,
    /** 全量最早过期时间（含 WAF 短命 cookie），仅供参考。 */
    cookieExpiresAt,
    stableExpiryDaysLeft: stableCookies.length
      ? Math.round(((earliestExpiry(stableCookies) || now) - now) / 86400000)
      : null,
  };
}

const PROFILE_FILES = [
  ['Local State', 'Local State'],
  ['Default/Network/Cookies', 'Default/Network/Cookies'],
  ['Default/Network/Cookies-journal', 'Default/Network/Cookies-journal'],
  ['Default/Cookies', 'Default/Cookies'],
  ['Default/Preferences', 'Default/Preferences'],
  ['Default/Secure Preferences', 'Default/Secure Preferences'],
  ['Default/Network/Network Persistent State', 'Default/Network/Network Persistent State'],
];

/** 把 Local Storage 目录整体拷过去，保证站点前端状态一致。 */
function copyLocalStorage(profileDir, scratchDir) {
  const from = path.join(profileDir, 'Default', 'Local Storage');
  const to = path.join(scratchDir, 'Default', 'Local Storage');
  if (!fs.existsSync(from)) {
    return { copied: 0 };
  }
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || /^LOCK$/.test(entry.name)) continue;
    try {
      fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
      copied += 1;
    } catch (error) {
      /* 单个文件失败不致命 */
    }
  }
  return { copied };
}

/**
 * 检查 profile 是否正被浏览器占用：占用时 Cookies 库会被独占锁住。
 */
function isProfileLocked(profileDir) {
  const cookieFile = path.join(profileDir, 'Default', 'Network', 'Cookies');
  if (!fs.existsSync(cookieFile)) {
    return false;
  }
  try {
    const fd = fs.openSync(cookieFile, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (error) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
  }
}

/**
 * 从任意 Chromium 系浏览器 profile 导入登录态。
 *
 * 思路：把 Cookies / Local State 等最小文件集拷到临时目录，用对应内核
 * 无头启动一次（由浏览器自己完成 DPAPI / App-Bound 解密），再导出成
 * 与浏览器解耦的 storageState JSON。之后运行期完全不再碰 profile。
 */
async function importFromProfile(config, source, logger) {
  const profileDir = cleanText(source.profileDir);
  if (!profileDir) {
    return { ok: false, reason: 'profileDir 未配置' };
  }
  if (!fs.existsSync(profileDir)) {
    return { ok: false, reason: `profile 不存在：${profileDir}` };
  }
  if (isProfileLocked(profileDir)) {
    return { ok: false, reason: `profile 正被浏览器占用（请先完全退出该浏览器）：${profileDir}`, locked: true };
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcores-import-'));
  logger.info(`导入来源「${source.label || profileDir}」→ 临时 profile ${scratchDir}`);

  let context;
  try {
    for (const [relative, target] of PROFILE_FILES) {
      const from = path.join(profileDir, relative);
      if (!fs.existsSync(from)) continue;
      const to = path.join(scratchDir, target);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    const ls = copyLocalStorage(profileDir, scratchDir);
    logger.debug(`Local Storage 复制 ${ls.copied} 个文件`);

    const launchOptions = {
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    };
    const channel = cleanText(source.channel || config.browser.channel);
    if (channel && channel !== 'builtin') {
      launchOptions.channel = channel;
    }

    context = await chromium.launchPersistentContext(scratchDir, launchOptions);
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultNavigationTimeout(config.run.navigationTimeoutMs);
    await page.goto(config.target.feedsUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const state = await context.storageState();
    const info = inspectStorageState(state);
    if (!info.hasAuthCookie) {
      return { ok: false, reason: 'profile 中没有找到 gcores 的 appToken/userID，可能该浏览器里并未登录', info };
    }

    // 顺带确认页面确实处在登录态，避免导入一份"有 cookie 但已失效"的状态。
    const loginPrompt = await page
      .evaluate(() => /需登录后才可显示内容|登录机核/.test(document.body ? document.body.innerText : ''))
      .catch(() => null);
    if (loginPrompt === true) {
      return { ok: false, reason: '该 profile 的登录态已失效，请重新登录后再导入', info };
    }

    return { ok: true, state, info };
  } catch (error) {
    return { ok: false, reason: cleanText(error && error.message ? error.message : error) };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    cleanupScratch(scratchDir, logger);
  }
}

function cleanupScratch(dir, logger) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    // 本机删除可能被安全策略拦下，留在 %TEMP% 里不影响正确性。
    logger.debug(`临时目录清理失败（可忽略）：${dir}`);
  }
}

/** 按配置顺序尝试所有来源，返回第一个成功的。 */
async function importFromSources(config, logger, filterLabel) {
  const sources = (config.session.sources || []).filter((item) => (filterLabel ? item.label === filterLabel : true));
  const attempts = [];
  for (const source of sources) {
    const result = await importFromProfile(config, source, logger);
    attempts.push({ label: source.label || source.profileDir, ok: result.ok, reason: result.reason || '' });
    if (result.ok) {
      return { ...result, attempts, sourceLabel: source.label || source.profileDir };
    }
  }
  return { ok: false, attempts, reason: attempts.map((item) => `${item.label}: ${item.reason}`).join(' | ') };
}

module.exports = {
  buildLaunchOptions,
  buildContextOptions,
  launchBrowser,
  newSessionContext,
  loadStorageState,
  saveStorageState,
  inspectStorageState,
  importFromProfile,
  importFromSources,
  isProfileLocked,
};

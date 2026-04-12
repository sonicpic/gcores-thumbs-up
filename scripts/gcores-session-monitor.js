const fs = require('fs');
const path = require('path');
const process = require('process');
const { chromium } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'gcores-playwright.config.json');
const LOCAL_CONFIG_PATH = path.join(PROJECT_ROOT, 'gcores-playwright.local.json');
const FEEDS_URL = 'https://www.gcores.com/feeds';
const PUSHPLUS_API = 'https://www.pushplus.plus/send';

const DEFAULT_CONFIG = {
  headless: true,
  storage: {
    userDataDir: '.gcores-playwright/profile',
  },
  browser: {
    viewport: {
      width: 1600,
      height: 2200,
    },
  },
  run: {
    navigationTimeoutMs: 45000,
  },
  notifications: {
    pushplusToken: '',
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

function projectPath(relativePath) {
  return path.resolve(PROJECT_ROOT, relativePath);
}

function loadConfig() {
  const baseConfig = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
    : {};
  const localConfig = fs.existsSync(LOCAL_CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
    : {};
  const merged = deepMerge(DEFAULT_CONFIG, deepMerge(isObject(baseConfig) ? baseConfig : {}, isObject(localConfig) ? localConfig : {}));
  merged.headless = Boolean(merged.headless);
  merged.storage.userDataDir = cleanText(merged.storage.userDataDir || DEFAULT_CONFIG.storage.userDataDir);
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
  merged.notifications.pushplusToken = cleanText(
    (merged.notifications && merged.notifications.pushplusToken) || ''
  );
  return merged;
}

function formatTimestamp(timestamp = Date.now()) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function logLine(message) {
  console.log(`[${formatTimestamp()}] ${message}`);
}

function parseArgs(argv) {
  const result = {
    intervalSeconds: 60,
    durationMinutes: 30,
    headless: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      result.help = true;
      continue;
    }
    if (value === '--interval-seconds') {
      result.intervalSeconds = clampNumber(argv[index + 1], result.intervalSeconds, 10);
      index += 1;
      continue;
    }
    if (value === '--duration-minutes') {
      result.durationMinutes = clampNumber(argv[index + 1], result.durationMinutes, 1);
      index += 1;
      continue;
    }
    if (value === '--headless') {
      result.headless = true;
      continue;
    }
    if (value === '--headed') {
      result.headless = false;
      continue;
    }
  }

  return result;
}

function printUsage() {
  console.log('Usage: node scripts/gcores-session-monitor.js [--interval-seconds 60] [--duration-minutes 30] [--headed|--headless]');
  console.log('Requires: PUSHPLUS_TOKEN environment variable or notifications.pushplusToken in gcores-playwright.local.json');
}

async function sendPushPlusMessage({ token, title, content, template = 'markdown' }) {
  const response = await fetch(PUSHPLUS_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      token,
      title,
      content,
      template,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.code !== 200) {
    throw new Error(`PushPlus send failed: HTTP ${response.status} ${payload ? JSON.stringify(payload) : ''}`);
  }
  return payload;
}

async function injectHeartbeat(page) {
  await page.evaluate(() => {
    const key = '__gcoresMonitorHeartbeat';
    const now = Date.now();
    window[key] = {
      startedAt: now,
      lastTickAt: now,
      tickCount: 0,
    };

    if (window.__gcoresMonitorHeartbeatTimer) {
      clearInterval(window.__gcoresMonitorHeartbeatTimer);
    }

    window.__gcoresMonitorHeartbeatTimer = setInterval(() => {
      const current = window[key] || {};
      window[key] = {
        startedAt: current.startedAt || now,
        lastTickAt: Date.now(),
        tickCount: Number(current.tickCount || 0) + 1,
      };
    }, 1000);
  });
}

async function readHeartbeat(page) {
  return page.evaluate(() => {
    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    const heartbeat = window.__gcoresMonitorHeartbeat || null;
    const buttons = Array.from(
      document.querySelectorAll(
        '.pageContainer .flowLayout_main .o_vote-up, .flowLayout_main .o_vote-up, main .o_vote-up, .o_vote-up'
      )
    ).filter((button) => !button.closest('.flowLayout_side, aside, footer'));
    const loginPrompt = Array.from(document.querySelectorAll('button, p, h1, div')).some((node) => {
      const text = cleanText(node.textContent || '');
      return text.includes('需登录后才可显示内容') || text.includes('登录机核');
    });
    const verificationPrompt = Array.from(document.querySelectorAll('h1, h2, div, p, span')).some((node) => {
      const text = cleanText(node.textContent || '');
      return text.includes('访问验证') || text.includes('请按住滑块');
    });

    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      heartbeat,
      buttonCount: buttons.length,
      loginPrompt,
      verificationPrompt,
    };
  });
}

function buildMessageContent({
  config,
  args,
  startedAt,
  sample,
  sampleError,
}) {
  const lines = [
    '# GCORES 远程会话监控',
    '',
    `- 发送时间: ${formatTimestamp()}`,
    `- 监控启动: ${formatTimestamp(startedAt)}`,
    `- 运行模式: ${config.headless ? 'headless' : 'headed'}${args.headless === false ? ' (forced)' : ''}`,
    `- 目标页面: ${FEEDS_URL}`,
  ];

  if (sampleError) {
    lines.push(`- 页面采样: 失败`);
    lines.push(`- 错误信息: ${cleanText(sampleError.message || sampleError)}`);
    lines.push('', '判断建议：');
    lines.push('- 如果微信消息还在持续收到，但页面采样失败，说明 Node 还活着，浏览器页可能已经挂掉。');
    lines.push('- 如果后续连消息都停了，更像是整个会话或进程被暂停。');
    return lines.join('\n');
  }

  const heartbeatAgeMs = sample && sample.heartbeat ? Date.now() - Number(sample.heartbeat.lastTickAt || 0) : null;
  lines.push(`- 页面采样: 成功`);
  lines.push(`- 当前 URL: ${sample.url}`);
  lines.push(`- 页面标题: ${sample.title || '未知'}`);
  lines.push(`- readyState: ${sample.readyState}`);
  lines.push(`- visibilityState: ${sample.visibilityState}`);
  lines.push(`- 点赞按钮数: ${sample.buttonCount}`);
  lines.push(`- 登录提示: ${sample.loginPrompt ? '是' : '否'}`);
  lines.push(`- 验证页提示: ${sample.verificationPrompt ? '是' : '否'}`);
  lines.push(`- 页内心跳: ${sample.heartbeat ? '存在' : '不存在'}`);

  if (sample.heartbeat) {
    lines.push(`- 页内心跳次数: ${sample.heartbeat.tickCount}`);
    lines.push(`- 页内心跳年龄: ${heartbeatAgeMs} ms`);
  }

  lines.push('', '判断建议：');
  if (!sample.heartbeat) {
    lines.push('- 页面里的定时器没有建立成功，先确认页面有没有完全打开。');
  } else if (heartbeatAgeMs > 15000) {
    lines.push('- Node 进程还在发消息，但页内心跳已经明显停住，更像是远程断开后浏览器页冻结。');
  } else {
    lines.push('- Node 和页内心跳目前都还在跑，暂时看不出被远程断开影响。');
  }
  lines.push('- 如果后续微信消息直接断掉，说明更像是整个会话/进程被暂停。');

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const config = loadConfig();
  const token = cleanText(process.env.PUSHPLUS_TOKEN || config.notifications.pushplusToken || '');
  if (!token) {
    throw new Error('缺少 PushPlus token。请设置 PUSHPLUS_TOKEN，或在 gcores-playwright.local.json 里配置 notifications.pushplusToken。');
  }
  if (typeof args.headless === 'boolean') {
    config.headless = args.headless;
  } else {
    config.headless = false;
  }

  const startedAt = Date.now();
  const durationMs = args.durationMinutes * 60 * 1000;
  const intervalMs = args.intervalSeconds * 1000;

  logLine(`启动远程会话监控，持续 ${args.durationMinutes} 分钟，间隔 ${args.intervalSeconds} 秒。`);
  logLine(`当前浏览器模式：${config.headless ? 'headless' : 'headed'}`);

  const context = await chromium.launchPersistentContext(projectPath(config.storage.userDataDir), {
    headless: config.headless,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: {
      width: config.browser.viewport.width,
      height: config.browser.viewport.height,
    },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  let page;
  try {
    page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(config.run.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(config.run.navigationTimeoutMs);
    await page.goto(FEEDS_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await injectHeartbeat(page);

    await sendPushPlusMessage({
      token,
      title: 'GCORES 监控已启动',
      content: buildMessageContent({
        config,
        args,
        startedAt,
        sample: await readHeartbeat(page),
      }),
    });

    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(intervalMs);
      let sample = null;
      let sampleError = null;
      try {
        sample = await readHeartbeat(page);
      } catch (error) {
        sampleError = error;
      }

      await sendPushPlusMessage({
        token,
        title: 'GCORES 远程会话心跳',
        content: buildMessageContent({
          config,
          args,
          startedAt,
          sample,
          sampleError,
        }),
      });
      logLine('已发送一条 PushPlus 心跳消息。');
    }

    await sendPushPlusMessage({
      token,
      title: 'GCORES 监控结束',
      content: `# GCORES 远程会话监控\n\n- 结束时间: ${formatTimestamp()}\n- 监控时长: ${args.durationMinutes} 分钟\n- 浏览器模式: ${config.headless ? 'headless' : 'headed'}`,
    });
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(cleanText(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});

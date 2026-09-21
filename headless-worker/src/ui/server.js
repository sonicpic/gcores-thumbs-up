'use strict';

/**
 * 本地控制台服务端。
 *
 * 设计约束：
 *  - 只监听 127.0.0.1，绝不对外暴露；
 *  - 每次都生成一次性 token，并要求 Host 必须是本机 —— 防止局域网访问与 DNS rebinding；
 *  - 依赖为零（只用 Node 标准库），进程随页面一起关，不做常驻。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const { PROJECT_ROOT, loadConfig, cleanText, deepMerge, readJsonFile, writeJsonFile } = require('../lib/config');
const { Store } = require('../lib/store');
const { loadStorageState, inspectStorageState, importFromSources, isProfileLocked } = require('../lib/session');
const { createLogger } = require('../lib/runner');
const { createNotifier } = require('../lib/notify');

const INDEX_FILE = path.join(__dirname, 'index.html');
const CLI_FILE = path.join(PROJECT_ROOT, 'src', 'cli.js');
const MAX_LOG_LINES = 600;

const TOKEN = crypto.randomBytes(16).toString('hex');
const job = { running: false, id: 0, command: '', startedAt: 0, finishedAt: 0, exitCode: null, lines: [] };

function projectPath(relative) {
  return path.resolve(PROJECT_ROOT, relative);
}

function pushLine(text) {
  String(text)
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.length > 0)
    .forEach((line) => {
      job.lines.push(line);
      if (job.lines.length > MAX_LOG_LINES) job.lines.shift();
    });
}

function readLogTail(lines = 60) {
  try {
    const content = fs.readFileSync(projectPath(loadConfig().paths.logFile), 'utf8');
    return content.trim().split('\n').slice(-lines);
  } catch (error) {
    return [];
  }
}

function fileInfo(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: true, bytes: stat.size, mtime: stat.mtime.toISOString() };
  } catch (error) {
    return { exists: false, bytes: 0, mtime: null };
  }
}

/**
 * 读取计划任务状态。schtasks.exe 在本机被安全策略列入黑名单，
 * 因此统一走 PowerShell 的 ScheduledTasks 模块。
 */
function readTaskInfo(taskName) {
  const script = [
    `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue`,
    "if (-not $t) { Write-Output '{\"registered\":false}'; exit 0 }",
    `$i = Get-ScheduledTaskInfo -TaskName '${taskName}'`,
    '$o = [ordered]@{',
    '  registered = $true',
    '  state = [string]$t.State',
    '  logonType = [string]$t.Principal.LogonType',
    '  interval = [string]$t.Triggers[0].Repetition.Interval',
    '  execute = [string]$t.Actions[0].Execute',
    '  lastRunTime = [string]$i.LastRunTime',
    '  lastTaskResult = $i.LastTaskResult',
    '  nextRunTime = [string]$i.NextRunTime',
    '}',
    '$o | ConvertTo-Json -Compress',
  ].join('\n');

  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  try {
    return JSON.parse((result.stdout || '').trim());
  } catch (error) {
    return { registered: false, error: cleanText(result.stderr || 'powershell query failed') };
  }
}

/**
 * 把配置里的调度间隔同步到真正的 Windows 计划任务上。
 *
 * 之前 `schedule.intervalMinutes` 只写进了 config.json，真正的 Task Scheduler
 * 触发器一动没动 —— 界面显示 45 分钟、任务仍然 30 分钟跑一次，这正是
 * "UI 与后台计划任务连接失效"的一环。这里补上。
 *
 * 失败也不影响配置本身的保存，结果会回传给界面。
 */
function applyIntervalToTask(config) {
  const script = path.join(PROJECT_ROOT, 'tools', 'install-task.ps1');
  if (!fs.existsSync(script)) {
    return { ok: false, message: `找不到 ${script}` };
  }
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-TaskName', String(config.schedule.taskName),
    '-IntervalMinutes', String(config.schedule.intervalMinutes),
    '-ProjectRoot', PROJECT_ROOT,
    '-NodePath', process.execPath,
    '-Force',
  ];
  // 原本以 S4U 注册的任务，重新注册时要保留，不能悄悄降级成 Interactive。
  try {
    const info = readTaskInfo(config.schedule.taskName);
    if (info && info.registered && String(info.logonType) === 'S4U') args.push('-RunWhenLoggedOff');
  } catch (error) { /* 读不到就按默认的 Interactive 处理 */ }

  const result = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (result.error) return { ok: false, message: cleanText(result.error.message) };
  if (result.status !== 0) {
    const detail = cleanText(`${result.stderr || ''}${result.stdout || ''}`);
    return { ok: false, message: detail || `install-task.ps1 退出码 ${result.status}` };
  }
  return { ok: true, message: `计划任务已按 ${config.schedule.intervalMinutes} 分钟间隔重新注册` };
}

function buildOverview(config) {
  const sessionFile = projectPath(config.paths.sessionFile);
  const stateFile = projectPath(config.paths.stateFile);
  const state = loadStorageState(sessionFile);
  const store = new Store(stateFile);

  const session = state
    ? (() => {
        const info = inspectStorageState(state);
        return {
          present: true,
          gcores: info.gcores,
          hasAuthCookie: info.hasAuthCookie,
          authCookieNames: info.authCookieNames,
          authExpiresAt: info.authExpiresAt,
          authDaysLeft: info.authDaysLeft,
          transient: info.transientCookieNames,
          file: fileInfo(sessionFile),
        };
      })()
    : { present: false, file: fileInfo(sessionFile) };

  return {
    runtime: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      sessionName: process.env.SESSIONNAME || '(no interactive session)',
      projectRoot: PROJECT_ROOT,
      headless: config.browser.headless,
      channel: config.browser.executablePath || config.browser.channel,
    },
    session,
    sources: (config.session.sources || []).map((source) => ({
      label: source.label || source.profileDir,
      profileDir: source.profileDir,
      channel: source.channel,
      exists: Boolean(source.profileDir) && fs.existsSync(source.profileDir),
      locked: Boolean(source.profileDir) && fs.existsSync(source.profileDir) && isProfileLocked(source.profileDir),
    })),
    task: readTaskInfo(config.schedule.taskName),
    store: {
      processed: Object.keys(store.state.processed).length,
      todayLikes: store.state.dailyCounter.likes,
      today: store.state.dailyCounter.date,
      runs: store.state.totals.runs,
      totalLikes: store.state.totals.liked,
      cooldownUntil: store.state.cooldown.blockedUntil,
      cooldownReason: store.state.cooldown.reason,
      lastRun: store.state.lastRun,
      sessionSource: store.state.session.source,
      lastCheckAt: store.state.session.lastCheckAt,
      lastError: store.state.session.lastError,
    },
    config: {
      schedule: config.schedule,
      limits: config.limits,
      timing: config.timing,
      filters: config.filters,
      notifications: {
        enabled: config.notifications.enabled,
        hasToken: Boolean(process.env.PUSHPLUS_TOKEN || config.notifications.pushplusToken),
        onLike: config.notifications.onLike,
        onFailure: config.notifications.onFailure,
        onSessionExpired: config.notifications.onSessionExpired,
        onRunSummary: config.notifications.onRunSummary,
      },
      browser: { headless: config.browser.headless, channel: config.browser.channel },
      ui: { port: config.ui.port },
    },
    logging: fileInfo(projectPath(config.paths.logFile)),
    logTail: readLogTail(60),
  };
}

function startJob(argv, label) {
  if (job.running) {
    return { ok: false, reason: 'already-running' };
  }
  job.running = true;
  job.id += 1;
  job.command = label;
  job.startedAt = Date.now();
  job.finishedAt = 0;
  job.exitCode = null;
  job.lines = [];
  pushLine(`$ gc ${argv.join(' ')}`);

  const child = spawn(process.execPath, [CLI_FILE, ...argv], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  child.stdout.on('data', (chunk) => pushLine(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => pushLine(chunk.toString('utf8')));
  child.on('close', (code) => {
    job.running = false;
    job.finishedAt = Date.now();
    job.exitCode = code;
    pushLine(`$ exit code ${code}`);
  });
  child.on('error', (error) => {
    job.running = false;
    job.finishedAt = Date.now();
    job.exitCode = -1;
    pushLine(`$ spawn failed: ${error.message}`);
  });
  return { ok: true };
}

function saveSettings(config, patch) {
  const current = readJsonFile(path.join(PROJECT_ROOT, 'config.json'));
  const merged = deepMerge(current, patch);
  // token 只允许写不读：为空表示"保持原样"。
  if (merged.notifications && !cleanText(merged.notifications.pushplusToken)) {
    const existing = (current.notifications && current.notifications.pushplusToken) || '';
    merged.notifications.pushplusToken = existing;
  }
  writeJsonFile(path.join(PROJECT_ROOT, 'config.json'), merged);
  return loadConfig();
}

async function importSession(config) {
  const logger = createLogger(config, PROJECT_ROOT, { mirrorToConsole: false, level: 'debug' });
  const result = await importFromSources(config, logger);
  if (!result.ok) {
    return { ok: false, message: result.reason, attempts: result.attempts };
  }
  writeJsonFile(projectPath(config.paths.sessionFile), result.state);
  const store = new Store(projectPath(config.paths.stateFile));
  const info = inspectStorageState(result.state);
  store.setSessionResult({ ok: true, cookieExpiresAt: info.authExpiresAt, source: result.sourceLabel });
  store.save();
  return { ok: true, message: `已从「${result.sourceLabel}」导入`, attempts: result.attempts, info };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        resolve({});
      }
    });
  });
}

function isLocalRequest(req) {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
    return false;
  }
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
    return false;
  }
  return true;
}

function startServer(config) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${config.ui.port}`);
    const isRoot = url.pathname === '/';

    if (!isLocalRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('只允许本机访问。');
      return;
    }

    // 浏览器会自动请求 favicon.ico。不能让它因为没有 token 而吃到 403，
    // 否则控制台常年挂着一条红色报错，会掩盖真正的问题。
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }

    const provided = url.searchParams.get('t') || req.headers['x-gc-token'];
    if (provided !== TOKEN) {
      if (isRoot) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<meta charset="utf-8"><p>链接无效或已过期，请重新运行 <code>npm run gc:ui</code>。</p>');
        return;
      }
      sendJson(res, 403, { ok: false, message: 'token 无效' });
      return;
    }

    try {
      if (req.method === 'GET' && isRoot) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(fs.readFileSync(INDEX_FILE, 'utf8').replace('__TOKEN__', TOKEN));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/overview') {
        sendJson(res, 200, { ok: true, overview: buildOverview(loadConfig()), job: publicJob() });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/job') {
        sendJson(res, 200, { ok: true, job: publicJob() });
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, message: 'method not allowed' });
        return;
      }

      const body = await readBody(req);
      const live = loadConfig();

      if (url.pathname === '/api/job') {
        const mode = body.mode === 'dry' ? 'dry' : 'run';
        const argv = ['run'];
        if (mode === 'dry') argv.push('--dry-run');
        sendJson(res, 200, { ok: true, ...startJob(argv, mode) });
        return;
      }

      if (url.pathname === '/api/config') {
        const previous = live;
        const next = saveSettings(live, body.patch || {});
        const payload = {
          ok: true,
          message: '配置已保存',
          config: { schedule: next.schedule, limits: next.limits, filters: next.filters },
        };
        // 间隔变了要落到真正的计划任务上，否则配置改了、调度没变。
        if (previous.schedule.intervalMinutes !== next.schedule.intervalMinutes) {
          const taskNow = readTaskInfo(next.schedule.taskName);
          if (taskNow && taskNow.registered) {
            const applied = applyIntervalToTask(next);
            payload.scheduleApplied = applied;
            payload.message = applied.ok
              ? `${payload.message}，${applied.message}`
              : `${payload.message}，但计划任务未能同步：${applied.message}`;
          } else {
            payload.scheduleApplied = { ok: false, skipped: true, message: '任务尚未注册，间隔会在注册时生效' };
          }
        }
        sendJson(res, 200, payload);
        return;
      }

      if (url.pathname === '/api/session/import') {
        sendJson(res, 200, await importSession(live));
        return;
      }

      if (url.pathname === '/api/notify/test') {
        const notifier = createNotifier(live, createLogger(live, PROJECT_ROOT, { mirrorToConsole: false, level: 'error' }));
        if (!notifier.available) {
          sendJson(res, 200, { ok: false, message: '通知未启用或未配置 PushPlus token' });
          return;
        }
        const delivered = await notifier.test({ message: '收到即代表推送链路正常。' });
        sendJson(res, 200, { ok: delivered, message: delivered ? '测试通知已发送' : '发送失败，请查看日志' });
        return;
      }

      if (url.pathname === '/api/task') {
        const action = body.action;
        const argv = action === 'remove' ? ['task', 'remove']
          : action === 'start' ? ['task', 'start']
          : action === 'stop' ? ['task', 'stop']
          : ['task', 'install', '--force'];
        sendJson(res, 200, { ok: true, ...startJob(argv, `task-${action || 'install'}`) });
        return;
      }

      if (url.pathname === '/api/state/reset') {
        const store = new Store(projectPath(live.paths.stateFile));
        store.state.processed = {};
        store.state.cooldown = { blockedUntil: 0, reason: '' };
        store.state.dailyCounter = { date: '', likes: 0 };
        store.save();
        sendJson(res, 200, { ok: true, message: '运行时状态已清空' });
        return;
      }

      sendJson(res, 404, { ok: false, message: 'unknown endpoint' });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: cleanText(error && error.message ? error.message : error) });
    }
  });

  function publicJob() {
    return {
      running: job.running,
      id: job.id,
      command: job.command,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      lines: job.lines.slice(-300),
    };
  }

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${config.ui.port} 已被占用。改 config.json 里的 ui.port，或先关掉旧的窗口。`);
    } else {
      console.error(`控制台启动失败：${error.message}`);
    }
    process.exitCode = 1;
  });

  server.listen(config.ui.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${config.ui.port}/?t=${TOKEN}`;
    console.log('');
    console.log('  GCORES 控制台已启动（仅本机可访问）');
    console.log(`  ${url}`);
    console.log('');
    console.log('  关闭这个窗口即停止服务。');
    if (config.ui.openBrowser) {
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    }
  });

  return server;
}

if (require.main === module) {
  const config = loadConfig();
  // 允许通过环境变量临时覆盖端口（测试 / 多实例场景），否则用配置值。
  const envPort = Number(process.env.GC_UI_PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) {
    config.ui.port = envPort;
  }
  startServer(config);
}

module.exports = { startServer, buildOverview, readTaskInfo, applyIntervalToTask };

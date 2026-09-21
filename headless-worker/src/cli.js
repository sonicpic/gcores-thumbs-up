#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline/promises');

const { PROJECT_ROOT, loadConfig, cleanText } = require('./lib/config');
const { Store, acquireLock, readJsonSafe } = require('./lib/store');
const { createLogger, runRound, projectPath } = require('./lib/runner');
const {
  launchBrowser,
  newSessionContext,
  loadStorageState,
  saveStorageState,
  inspectStorageState,
  importFromSources,
  isProfileLocked,
} = require('./lib/session');
const { chromium } = require('playwright');
const { createNotifier } = require('./lib/notify');

const TOOLS_DIR = path.join(PROJECT_ROOT, 'tools');

function parseArgs(argv) {
  const args = { command: '', sub: '', flags: {}, rest: [] };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        index += 1;
      }
    } else {
      positional.push(value);
    }
  }
  args.command = positional[0] || '';
  args.sub = positional[1] || '';
  args.rest = positional.slice(2);
  return args;
}

function printUsage() {
  console.log(`GCORES 无头自动点赞工具

用法: node src/cli.js <命令> [选项]

命令:
  run                        执行一轮（默认无头，适配计划任务）
      --dry-run              只做规则匹配，不真正点赞
      --no-notify            本轮不发通知（手动调试用）
      --quiet                不向控制台输出日志
  doctor                     环境与登录态体检
  ui                         启动本地控制台（图形界面，仅本机可访问）
  session status             查看当前登录态详情
  session import             从配置的来源导入登录态（复用已有浏览器登录）
      --source "<label>"     只从指定来源导入
  session login              打开有头浏览器手动登录一次（需要桌面会话）
  task install               注册 Windows 计划任务（推荐，脱离 RDP）
      --interval-minutes 30  调度间隔
      --project-root <path>  指定要调度的项目目录（默认当前项目）
      --s4u                  以"无论用户是否登录都运行"方式注册（需管理员）
      --force                覆盖同名任务
  task remove                删除计划任务
  task status                查看计划任务状态
  state show                 查看运行时状态
  state reset                清空运行时状态（processed / 冷却 / 计数）
  notify test                发一条测试通知，验证 PushPlus 配置
`);
}

function humanBytes(value) {
  if (!Number.isFinite(value)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)}${units[index]}`;
}

function fileInfo(file) {
  try {
    const stat = fs.statSync(file);
    return `${humanBytes(stat.size)} | ${stat.mtime.toLocaleString('zh-CN', { hour12: false })}`;
  } catch (error) {
    return '不存在';
  }
}

async function commandRun(config, args) {
  // 命令行开关优先于配置文件，便于临时压掉通知而不改本地配置。
  if (args.flags['no-notify']) {
    config.notifications.enabled = false;
  }
  const lock = acquireLock(projectPath(PROJECT_ROOT, config.paths.lockFile), config.run.maxRunMs);
  if (!lock.acquired) {
    const holder = lock.holder || {};
    console.log(`已有另一轮正在执行（PID ${holder.pid || '未知'}），本次跳过。`);
    return 0;
  }

  const logger = createLogger(config, PROJECT_ROOT, {
    mirrorToConsole: !args.flags.quiet,
    level: args.flags.debug ? 'debug' : config.logging.level,
  });

  try {
    const result = await runRound({
      config,
      root: PROJECT_ROOT,
      dryRun: Boolean(args.flags['dry-run']),
      logger,
    });
    if (!args.flags.quiet) {
      console.log(`\n结果：${result.ok ? '成功' : '失败'}，耗时 ${Math.round(result.durationMs / 1000)} 秒`);
      if (result.matchedItems.length) {
        console.log(`命中 ${result.matchedItems.length} 条：`);
        result.matchedItems.forEach((item) => console.log(`  - ${item.title}  ${item.url}`));
      }
      if (result.error) {
        console.log(`错误：${result.error.message}`);
      }
    }
    return result.ok ? 0 : 1;
  } finally {
    lock.release();
  }
}

async function commandSessionStatus(config) {
  const sessionFile = projectPath(PROJECT_ROOT, config.paths.sessionFile);
  const state = loadStorageState(sessionFile);
  if (!state) {
    console.log(`登录态文件不存在或不可用：${sessionFile}`);
    console.log('请执行：npm run gc:session:import');
    return 1;
  }
  const info = inspectStorageState(state);
  console.log(`登录态文件：${sessionFile}`);
  console.log(`  文件大小   : ${fileInfo(sessionFile)}`);
  console.log(`  Cookie 总数: ${info.total}（gcores 域 ${info.gcores}）`);
  console.log(`  关键 Cookie: ${info.hasAuthCookie ? `${info.authCookieNames.join('/')} 存在` : '缺失'}`);
  if (info.authExpiresAt) {
    console.log(
      `  凭证有效期 : 至 ${new Date(info.authExpiresAt).toLocaleString('zh-CN', { hour12: false })}（约 ${info.authDaysLeft} 天）`
    );
  }
  if (info.transientCookieNames.length) {
    console.log(`  短命 Cookie: ${info.transientCookieNames.join(', ')}（WAF/埋点，每次访问自动刷新，不必关注）`);
  }
  const store = new Store(projectPath(PROJECT_ROOT, config.paths.stateFile));
  if (store.state.session.lastCheckAt) {
    console.log(
      `  最近校验   : ${new Date(store.state.session.lastCheckAt).toLocaleString('zh-CN', { hour12: false })} → ${
        store.state.session.lastError ? `异常（${store.state.session.lastError.message}）` : '正常'
      }`
    );
  }
  if (store.state.session.source) {
    console.log(`  导入来源   : ${store.state.session.source}`);
  }
  return 0;
}

async function commandSessionImport(config, args) {
  const logger = createLogger(config, PROJECT_ROOT, { level: config.logging.level });
  const filter = typeof args.flags.source === 'string' ? args.flags.source : '';
  const sessionFile = projectPath(PROJECT_ROOT, config.paths.sessionFile);

  console.log('开始导入登录态……');
  for (const source of config.session.sources || []) {
    if (filter && source.label !== filter) continue;
    const label = source.label || source.profileDir || source.windowsProfile;
    if (!source.profileDir) {
      console.log(`- ${label}: 未配置 profileDir，跳过`);
      continue;
    }
    if (!fs.existsSync(source.profileDir)) {
      console.log(`- ${label}: profile 不存在（${source.profileDir}），跳过`);
      continue;
    }
    if (isProfileLocked(source.profileDir)) {
      console.log(`- ${label}: profile 正被浏览器占用，请先完全退出该浏览器再重试`);
      continue;
    }
    console.log(`- ${label}: 导入中……`);
  }

  const result = await importFromSources(config, logger, filter || undefined);
  if (!result.ok) {
    console.log(`导入失败：${result.reason}`);
    return 1;
  }
  saveStorageState(sessionFile, result.state);
  const info = inspectStorageState(result.state);
  const store = new Store(projectPath(PROJECT_ROOT, config.paths.stateFile));
  store.setSessionResult({ ok: true, cookieExpiresAt: info.authExpiresAt, source: result.sourceLabel });
  store.save();
  console.log(`导入成功：${result.sourceLabel}`);
  console.log(`  已保存到   : ${sessionFile}`);
  console.log(`  gcores Cookie: ${info.gcores} 个，关键凭证${info.hasAuthCookie ? '正常' : '缺失'}`);
  if (info.authExpiresAt) {
    console.log(
      `  凭证有效期 : 至 ${new Date(info.authExpiresAt).toLocaleString('zh-CN', { hour12: false })}（约 ${info.authDaysLeft} 天）`
    );
  }
  return 0;
}

async function commandSessionLogin(config) {
  const sessionFile = projectPath(PROJECT_ROOT, config.paths.sessionFile);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcores-login-'));
  console.log('将打开一个有头浏览器窗口（需要桌面会话），请在窗口里完成登录。');
  const context = await chromium.launchPersistentContext(scratchDir, {
    headless: false,
    channel: config.browser.channel === 'builtin' ? undefined : config.browser.channel,
    locale: config.browser.locale,
    timezoneId: config.browser.timezoneId,
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(config.target.feedsUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('登录完成后回到这里按 Enter 继续……');
    rl.close();
    await page.goto(config.target.feedsUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const state = await context.storageState();
    const info = inspectStorageState(state);
    if (!info.hasAuthCookie) {
      console.log('没有检测到 gcores 的登录凭证，请确认登录是否成功。');
      return 1;
    }
    saveStorageState(sessionFile, state);
    const store = new Store(projectPath(PROJECT_ROOT, config.paths.stateFile));
    store.setSessionResult({ ok: true, cookieExpiresAt: info.cookieExpiresAt, source: 'interactive-login' });
    store.save();
    console.log(`登录态已保存：${sessionFile}`);
    return 0;
  } finally {
    await context.close().catch(() => {});
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch (error) {
      /* 忽略 */
    }
  }
}

async function commandDoctor(config) {
  const lines = [];
  const push = (line) => lines.push(line);

  push('== 运行环境 ==');
  push(`  Node        : ${process.version} (${process.platform}/${process.arch})`);
  push(`  SESSIONNAME : ${process.env.SESSIONNAME || '(非交互会话)'}`);
  push(`  项目目录    : ${PROJECT_ROOT}`);

  push('');
  push('== 浏览器与渲染方式 ==');
  push(`  headless    : ${config.browser.headless}${config.browser.headless ? '（不依赖桌面会话 ✔）' : '（依赖桌面会话 ✘）'}`);
  push(`  channel     : ${config.browser.channel}${config.browser.executablePath ? ` / ${config.browser.executablePath}` : ''}`);
  push(`  viewport    : ${config.browser.viewport.width}x${config.browser.viewport.height}`);
  const browsersRoot = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  try {
    const installed = fs.readdirSync(browsersRoot).filter((name) => name.startsWith('chromium'));
    push(`  Playwright 内核: ${installed.length ? installed.join(', ') : '未安装（执行 npx playwright install chromium）'}`);
  } catch (error) {
    push('  Playwright 内核: 未安装（执行 npx playwright install chromium）');
  }

  push('');
  push('== 登录态 ==');
  const sessionFile = projectPath(PROJECT_ROOT, config.paths.sessionFile);
  const state = loadStorageState(sessionFile);
  if (!state) {
    push(`  session.json: 缺失（${sessionFile}）→ 执行 npm run gc:session:import`);
  } else {
    const info = inspectStorageState(state);
    push(`  session.json: ${info.gcores} 个 gcores cookie，关键凭证 ${info.hasAuthCookie ? '正常 ✔' : '缺失 ✘'}`);
    if (info.authExpiresAt) {
      push(`  凭证有效期  : 至 ${new Date(info.authExpiresAt).toLocaleString('zh-CN', { hour12: false })}（约 ${info.authDaysLeft} 天）`);
    }
  }

  push('');
  push('== 可导入来源 ==');
  for (const source of config.session.sources || []) {
    const label = source.label || source.profileDir;
    if (!source.profileDir) {
      push(`  - ${label}: 未配置 profileDir`);
      continue;
    }
    const exists = fs.existsSync(source.profileDir);
    const locked = exists ? isProfileLocked(source.profileDir) : false;
    push(`  - ${label}: ${!exists ? '路径不存在' : locked ? '可用，但浏览器正在运行（需先退出）' : '可用 ✔'}`);
  }

  push('');
  push('== 调度与通知 ==');
  push(`  调度方式    : Windows 计划任务（任务名 ${config.schedule.taskName}）`);
  push(`  间隔        : ${config.schedule.intervalMinutes} 分钟`);
  push(`  PushPlus    : ${config.notifications.enabled ? (process.env.PUSHPLUS_TOKEN || config.notifications.pushplusToken ? '已配置 ✔' : '未配置 token') : '已关闭'}`);
  push(`  单轮硬超时  : ${Math.round(config.run.maxRunMs / 1000)} 秒`);

  push('');
  push('== 数据文件 ==');
  push(`  状态文件    : ${fileInfo(projectPath(PROJECT_ROOT, config.paths.stateFile))}`);
  push(`  日志文件    : ${fileInfo(projectPath(PROJECT_ROOT, config.paths.logFile))}`);
  push(`  可选截图    : ${fileInfo(projectPath(PROJECT_ROOT, config.paths.errorScreenshotFile))}`);

  const store = new Store(projectPath(PROJECT_ROOT, config.paths.stateFile));
  push('');
  push('== 最近一轮 ==');
  if (store.state.lastRun) {
    const last = store.state.lastRun;
    push(`  时间        : ${new Date(last.startedAt).toLocaleString('zh-CN', { hour12: false })}`);
    push(`  结果        : ${last.ok ? '成功' : `失败（${last.error ? last.error.message : '未知'}）`}`);
    push(`  统计        : 扫描 ${last.stats.scanned} / 命中 ${last.stats.matched} / 点赞 ${last.stats.liked} / 跳过 ${last.stats.skipped}`);
  } else {
    push('  暂无记录');
  }
  push(`  累计        : ${store.state.totals.runs} 轮 / 点赞 ${store.state.totals.liked} 次`);
  if (store.state.cooldown.blockedUntil > Date.now()) {
    push(`  冷却中      : 至 ${new Date(store.state.cooldown.blockedUntil).toLocaleString('zh-CN', { hour12: false })}`);
  }

  console.log(lines.join('\n'));
  return 0;
}

function runPowerShell(scriptName, extraArgs = []) {
  const script = path.join(TOOLS_DIR, scriptName);
  if (!fs.existsSync(script)) {
    console.error(`找不到脚本：${script}`);
    return 1;
  }
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extraArgs],
    { stdio: 'inherit', windowsHide: true }
  );
  return result.status === null ? 1 : result.status;
}

function commandTask(config, sub, args) {
  const common = ['-IntervalMinutes', String(args.flags['interval-minutes'] || config.schedule.intervalMinutes)];
  if (sub === 'install') {
    const targetRoot = typeof args.flags['project-root'] === 'string' ? path.resolve(args.flags['project-root']) : PROJECT_ROOT;
    if (!fs.existsSync(path.join(targetRoot, 'src', 'cli.js'))) {
      console.error(`目标目录下找不到 src/cli.js：${targetRoot}`);
      return 1;
    }
    const extra = [
      ...common,
      '-TaskName', String(config.schedule.taskName),
      '-ProjectRoot', targetRoot,
      '-NodePath', process.execPath,
    ];
    if (args.flags.s4u) extra.push('-RunWhenLoggedOff');
    if (args.flags.force) extra.push('-Force');
    return runPowerShell('install-task.ps1', extra);
  }
  if (sub === 'remove') {
    return runPowerShell('uninstall-task.ps1', ['-TaskName', String(config.schedule.taskName)]);
  }
  if (sub === 'status') {
    return runPowerShell('task-status.ps1', ['-TaskName', String(config.schedule.taskName)]);
  }
  if (sub === 'start') {
    return runPowerShell('set-task-state.ps1', ['-TaskName', String(config.schedule.taskName), '-Action', 'Enable']);
  }
  if (sub === 'stop') {
    return runPowerShell('set-task-state.ps1', ['-TaskName', String(config.schedule.taskName), '-Action', 'Disable']);
  }
  console.error('未知的 task 子命令，可用：install / remove / status / start / stop');
  return 1;
}

async function commandNotify(config) {
  const logger = createLogger(config, PROJECT_ROOT, { mirrorToConsole: false });
  const notifier = createNotifier(config, logger);
  if (!notifier.available) {
    console.log('通知未启用或未配置 PushPlus token，请检查 config.local.json 的 notifications.pushplusToken。');
    return 1;
  }
  const delivered = await notifier.test({ message: '收到即代表推送链路正常。' });
  console.log(delivered ? '测试通知已发送，请检查接收端。' : '测试通知发送失败，请查看日志。');
  return delivered ? 0 : 1;
}

function commandState(config, sub) {  const stateFile = projectPath(PROJECT_ROOT, config.paths.stateFile);
  if (sub === 'reset') {
    const store = new Store(stateFile);
    store.state.processed = {};
    store.state.cooldown = { blockedUntil: 0, reason: '' };
    store.state.dailyCounter = { date: '', likes: 0 };
    store.save();
    console.log('运行时状态已清空（processed / 冷却 / 计数）。');
    return 0;
  }
  const raw = readJsonSafe(stateFile, null);
  if (!raw) {
    console.log(`状态文件不存在：${stateFile}`);
    return 1;
  }
  const store = new Store(stateFile);
  console.log(`状态文件：${stateFile}`);
  console.log(`  已处理条目 : ${Object.keys(store.state.processed).length}`);
  console.log(`  今日点赞   : ${store.state.dailyCounter.likes}（${store.state.dailyCounter.date}）`);
  console.log(`  累计轮次   : ${store.state.totals.runs}，累计点赞 ${store.state.totals.liked}`);
  console.log(`  冷却至     : ${store.state.cooldown.blockedUntil ? new Date(store.state.cooldown.blockedUntil).toLocaleString('zh-CN', { hour12: false }) : '无'}`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  let code = 0;

  switch (args.command) {
    case 'run':
      code = await commandRun(config, args);
      break;
    case 'doctor':
      code = await commandDoctor(config);
      break;
    case 'ui': {
      if (args.flags['no-open']) config.ui.openBrowser = false;
      const { startServer } = require('./ui/server');
      startServer(config);
      return;
    }
    case 'session':
      if (args.sub === 'status') code = await commandSessionStatus(config);
      else if (args.sub === 'import') code = await commandSessionImport(config, args);
      else if (args.sub === 'login') code = await commandSessionLogin(config);
      else {
        console.error('未知的 session 子命令，可用：status / import / login');
        code = 1;
      }
      break;
    case 'task':
      code = commandTask(config, args.sub, args);
      break;
    case 'state':
      code = commandState(config, args.sub || 'show');
      break;
    case 'notify':
      if (args.sub === 'test') code = await commandNotify(config);
      else {
        console.error('未知的 notify 子命令，可用：test');
        code = 1;
      }
      break;
    default:
      printUsage();
      code = args.command ? 1 : 0;
      break;
  }

  process.exitCode = code;
}

main().catch((error) => {
  console.error(cleanText(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});

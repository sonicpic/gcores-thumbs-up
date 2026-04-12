const fs = require('fs');
const path = require('path');
const process = require('process');
const { spawn, spawnSync } = require('child_process');
const { PROJECT_ROOT, loadConfig, cleanText } = require('./lib/app-config');

const STATE_DIR = path.join(PROJECT_ROOT, '.gcores-playwright');
const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
const LOG_FILE = path.join(STATE_DIR, 'daemon.log');
const RUN_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'gcores-playwright.js');

function ensureDir(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
}

function formatTimestamp(timestamp = Date.now()) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function logLine(message) {
  ensureDir(STATE_DIR);
  const line = `[${formatTimestamp()}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
  console.log(cleanText(line));
}

function parseBooleanOption(value) {
  const normalized = cleanText(value).toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'off', 'no', 'n'].includes(normalized)) {
    return false;
  }
  return null;
}

function parseArgs(argv) {
  const result = {
    command: 'start',
    intervalMinutes: null,
    pushplusEnabled: null,
    help: false,
    force: false,
  };

  const firstArg = argv[0];
  if (['start', 'serve', 'stop', 'status'].includes(firstArg)) {
    result.command = firstArg;
    argv = argv.slice(1);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      result.help = true;
      continue;
    }
    if (value === '--interval-minutes') {
      const nextValue = Number(argv[index + 1]);
      if (Number.isFinite(nextValue) && nextValue > 0) {
        result.intervalMinutes = nextValue;
      }
      index += 1;
      continue;
    }
    if (value === '--pushplus') {
      const parsed = parseBooleanOption(argv[index + 1]);
      if (parsed !== null) {
        result.pushplusEnabled = parsed;
      }
      index += 1;
      continue;
    }
    if (value === '--force') {
      result.force = true;
    }
  }

  return result;
}

function printUsage() {
  console.log(
    'Usage: node scripts/gcores-daemon.js <start|serve|stop|status> [--interval-minutes 30] [--pushplus on|off] [--force]'
  );
}

function resolveRuntimeOptions(args) {
  const config = loadConfig();
  return {
    // 默认走统一配置，只有显式传参时才覆盖。
    intervalMinutes: args.intervalMinutes || config.daemon.intervalMinutes,
    pushplusEnabled: args.pushplusEnabled === null ? config.notifications.enabled : args.pushplusEnabled,
  };
}

function writePidFile(pid, options) {
  ensureDir(STATE_DIR);
  fs.writeFileSync(
    PID_FILE,
    `${JSON.stringify(
      {
        pid,
        intervalMinutes: options.intervalMinutes,
        pushplusEnabled: options.pushplusEnabled,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

function readPidFile() {
  if (!fs.existsSync(PID_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch (error) {
    return null;
  }
}

function removePidFile() {
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
  }
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCycle(options) {
  return new Promise((resolve) => {
    // 守护进程把最终生效参数继续透传给 run，避免两边配置理解不一致。
    const child = spawn(process.execPath, [RUN_SCRIPT, 'run', '--pushplus', options.pushplusEnabled ? 'on' : 'off'], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const prefix = `[${formatTimestamp()}] [run ${child.pid}] `;

    child.stdout.on('data', (chunk) => {
      logStream.write(`${prefix}${chunk}`);
    });
    child.stderr.on('data', (chunk) => {
      logStream.write(`${prefix}[stderr] ${chunk}`);
    });
    child.on('close', (code) => {
      logStream.write(`${prefix}exited with code ${code}\n`);
      logStream.end();
      resolve(code);
    });
  });
}

async function serveLoop(options) {
  ensureDir(STATE_DIR);
  writePidFile(process.pid, options);
  logLine(
    `守护进程已启动，PID=${process.pid}，间隔=${options.intervalMinutes} 分钟，PushPlus=${options.pushplusEnabled ? '开启' : '关闭'}。`
  );

  const cleanup = () => {
    removePidFile();
  };

  process.on('SIGINT', () => {
    logLine('收到 SIGINT，守护进程退出。');
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logLine('收到 SIGTERM，守护进程退出。');
    cleanup();
    process.exit(0);
  });
  process.on('exit', cleanup);

  const intervalMs = options.intervalMinutes * 60 * 1000;
  while (true) {
    const cycleStartedAt = Date.now();
    logLine(`开始执行一轮 gcores:run，PushPlus=${options.pushplusEnabled ? '开启' : '关闭'}。`);
    const exitCode = await runCycle(options);
    const elapsedMs = Date.now() - cycleStartedAt;
    logLine(`本轮执行结束，退出码=${exitCode}，耗时=${elapsedMs} ms。`);

    // 这里按“开始时间对齐”计算等待，避免执行耗时把定时间隔越拖越长。
    const waitMs = Math.max(0, intervalMs - elapsedMs);
    logLine(`等待下一轮，剩余 ${Math.round(waitMs / 1000)} 秒。`);
    await sleep(waitMs);
  }
}

function startDaemon(args) {
  const existing = readPidFile();
  if (existing && isProcessAlive(existing.pid)) {
    if (!args.force) {
      console.log(
        `守护进程已经在运行，PID=${existing.pid}，间隔=${existing.intervalMinutes || '未知'} 分钟，PushPlus=${existing.pushplusEnabled === false ? '关闭' : '开启'}。`
      );
      return;
    }
    stopDaemon();
  }

  const options = resolveRuntimeOptions(args);
  ensureDir(STATE_DIR);
  const child = spawn(
    process.execPath,
    [
      __filename,
      'serve',
      '--interval-minutes',
      String(options.intervalMinutes),
      '--pushplus',
      options.pushplusEnabled ? 'on' : 'off',
    ],
    {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    }
  );
  child.unref();
  console.log(
    `守护进程已在后台启动，PID=${child.pid}，间隔=${options.intervalMinutes} 分钟，PushPlus=${options.pushplusEnabled ? '开启' : '关闭'}。`
  );
}

function stopDaemon() {
  const existing = readPidFile();
  if (!existing || !existing.pid) {
    console.log('没有检测到守护进程。');
    return;
  }
  if (!isProcessAlive(existing.pid)) {
    removePidFile();
    console.log('PID 文件已过期，已清理。');
    return;
  }

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(existing.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`taskkill failed with code ${result.status}`);
    }
  } else {
    process.kill(existing.pid, 'SIGTERM');
  }

  removePidFile();
  console.log(`守护进程已停止，PID=${existing.pid}。`);
}

function showStatus() {
  const existing = readPidFile();
  if (!existing || !existing.pid) {
    console.log('守护进程未运行。');
    return;
  }
  if (!isProcessAlive(existing.pid)) {
    removePidFile();
    console.log('守护进程未运行，已清理过期 PID 文件。');
    return;
  }

  console.log(
    `守护进程运行中：PID=${existing.pid}，启动时间=${existing.startedAt || '未知'}，间隔=${existing.intervalMinutes || '未知'} 分钟，PushPlus=${existing.pushplusEnabled === false ? '关闭' : '开启'}。`
  );
  console.log(`日志文件：${LOG_FILE}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (args.command === 'start') {
    startDaemon(args);
    return;
  }

  if (args.command === 'serve') {
    await serveLoop(resolveRuntimeOptions(args));
    return;
  }

  if (args.command === 'stop') {
    stopDaemon();
    return;
  }

  if (args.command === 'status') {
    showStatus();
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(cleanText(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});

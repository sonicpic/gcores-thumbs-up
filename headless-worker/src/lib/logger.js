'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function formatTimestamp(timestamp = Date.now()) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function rotateIfNeeded(file, maxBytes, keepFiles) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    return;
  }
  if (size < maxBytes) {
    return;
  }
  for (let index = keepFiles; index >= 1; index -= 1) {
    const from = index === 1 ? file : `${file}.${index - 1}`;
    const to = `${file}.${index}`;
    if (!fs.existsSync(from)) continue;
    try {
      if (fs.existsSync(to)) fs.unlinkSync(to);
      fs.renameSync(from, to);
    } catch (error) {
      /* 轮转失败不能影响主流程 */
    }
  }
}

/**
 * 极简结构化日志：同时写控制台与文件，按大小轮转。
 * 无头/计划任务场景下控制台不可见，文件才是唯一可信来源。
 */
class Logger {
  constructor({ file, level = 'info', maxBytes = 2 * 1024 * 1024, keepFiles = 3, mirrorToConsole = true } = {}) {
    this.file = file;
    this.threshold = LEVELS[level] || LEVELS.info;
    this.maxBytes = maxBytes;
    this.keepFiles = keepFiles;
    this.mirrorToConsole = mirrorToConsole;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    }
  }

  write(level, message, extra) {
    if ((LEVELS[level] || LEVELS.info) < this.threshold) {
      return;
    }
    const suffix = extra === undefined ? '' : ` ${safeJson(extra)}`;
    const line = `[${formatTimestamp()}] [${level.toUpperCase()}] ${message}${suffix}`;
    if (this.mirrorToConsole) {
      const sink = level === 'error' || level === 'warn' ? console.error : console.log;
      sink(line);
    }
    if (!this.file) {
      return;
    }
    try {
      rotateIfNeeded(this.file, this.maxBytes, this.keepFiles);
      fs.appendFileSync(this.file, `${line}\n`, 'utf8');
    } catch (error) {
      /* 日志写失败不能让业务挂掉 */
    }
  }

  debug(message, extra) {
    this.write('debug', message, extra);
  }

  info(message, extra) {
    this.write('info', message, extra);
  }

  warn(message, extra) {
    this.write('warn', message, extra);
  }

  error(message, extra) {
    this.write('error', message, extra);
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

module.exports = { Logger, formatTimestamp };

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { clampNumber, isObject } = require('./config');

const PROCESSED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const STATE_VERSION = 2;

const DEFAULT_STATE = {
  version: STATE_VERSION,
  processed: {},
  dailyCounter: { date: '', likes: 0 },
  cooldown: { blockedUntil: 0, reason: '' },
  session: { lastOkAt: 0, lastCheckAt: 0, lastError: null, cookieExpiresAt: 0, source: '' },
  lastRun: null,
  totals: { runs: 0, liked: 0 },
};

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function resetDailyCounter(counter, now = Date.now()) {
  const date = localDateKey(now);
  if (!counter || counter.date !== date) {
    return { date, likes: 0 };
  }
  return { date, likes: clampNumber(counter.likes, 0, 0) };
}

function trimProcessedCache(processed, now = Date.now()) {
  const next = {};
  if (!isObject(processed)) {
    return next;
  }
  Object.keys(processed).forEach((key) => {
    const entry = processed[key];
    const ts = clampNumber(entry && (entry.ts || entry.timestamp || entry), 0, 0);
    if (!ts || now - ts > PROCESSED_CACHE_TTL_MS) {
      return;
    }
    next[key] = { ts, status: String((entry && entry.status) || 'processed') };
  });
  return next;
}

function sanitizeState(state) {
  const base = isObject(state) ? state : {};
  const merged = {
    ...DEFAULT_STATE,
    ...base,
    processed: trimProcessedCache(base.processed),
    dailyCounter: resetDailyCounter(base.dailyCounter),
    cooldown: {
      blockedUntil: clampNumber(base.cooldown && base.cooldown.blockedUntil, 0, 0),
      reason: String((base.cooldown && base.cooldown.reason) || ''),
    },
    session: { ...DEFAULT_STATE.session, ...(isObject(base.session) ? base.session : {}) },
    totals: { runs: clampNumber(base.totals && base.totals.runs, 0, 0), liked: clampNumber(base.totals && base.totals.liked, 0, 0) },
    lastRun: isObject(base.lastRun) ? base.lastRun : null,
    version: STATE_VERSION,
  };
  merged.session.lastError = merged.session.lastError && typeof merged.session.lastError.message === 'string' ? merged.session.lastError : null;
  return merged;
}

/** 原子写：先写临时文件再 rename，避免掉电/强杀留下半截 JSON。 */
function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return fallback;
  }
}

class Store {
  constructor(stateFile) {
    this.stateFile = stateFile;
    this.state = sanitizeState(readJsonSafe(stateFile, DEFAULT_STATE));
  }

  reload() {
    this.state = sanitizeState(readJsonSafe(this.stateFile, DEFAULT_STATE));
    return this.state;
  }

  save() {
    this.state = sanitizeState(this.state);
    writeJsonAtomic(this.stateFile, this.state);
  }

  markProcessed(itemKey, status) {
    this.state.processed[itemKey] = { ts: Date.now(), status: String(status || 'processed') };
  }

  wasProcessed(itemKey) {
    return Boolean(this.state.processed[itemKey]);
  }

  incrementDailyLikes() {
    this.state.dailyCounter = resetDailyCounter(this.state.dailyCounter);
    this.state.dailyCounter.likes += 1;
  }

  hasReachedDailyLimit(config) {
    const limit = Number(config.limits.maxLikesPerDay);
    if (!Number.isFinite(limit) || limit <= 0) {
      return false;
    }
    this.state.dailyCounter = resetDailyCounter(this.state.dailyCounter);
    return this.state.dailyCounter.likes >= limit;
  }

  isCoolingDown() {
    return this.state.cooldown.blockedUntil > Date.now();
  }

  setCooldown(ms, reason) {
    this.state.cooldown.blockedUntil = Date.now() + ms;
    this.state.cooldown.reason = String(reason || '');
  }

  clearCooldown() {
    this.state.cooldown.blockedUntil = 0;
    this.state.cooldown.reason = '';
  }

  setSessionResult({ ok, error, cookieExpiresAt, source }) {
    this.state.session.lastCheckAt = Date.now();
    if (ok) {
      this.state.session.lastOkAt = Date.now();
      this.state.session.lastError = null;
    } else if (error) {
      this.state.session.lastError = { message: String(error), at: Date.now() };
    }
    if (cookieExpiresAt) {
      this.state.session.cookieExpiresAt = cookieExpiresAt;
    }
    if (source) {
      this.state.session.source = source;
    }
  }

  recordRun(summary) {
    this.state.totals.runs += 1;
    this.state.totals.liked += clampNumber(summary.stats && summary.stats.liked, 0, 0);
    this.state.lastRun = summary;
  }
}

/**
 * 跨进程互斥锁。计划任务已经配置为 IgnoreNew，这里再兜一层，
 * 防止手动执行与定时执行撞车。超过 TTL 的锁会被判定为残留并回收。
 */
function acquireLock(lockFile, ttlMs = 15 * 60 * 1000) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const payload = { pid: process.pid, host: os.hostname(), at: Date.now() };
  try {
    // wx = 独占创建，天然原子。
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, `${JSON.stringify(payload)}\n`);
    fs.closeSync(fd);
    return { acquired: true, release: () => releaseLock(lockFile, payload) };
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    const existing = readJsonSafe(lockFile, null);
    const age = existing && existing.at ? Date.now() - existing.at : Number.POSITIVE_INFINITY;
    const ownerAlive = existing && existing.host === os.hostname() && isAlive(existing.pid);
    if (age < ttlMs && ownerAlive) {
      return { acquired: false, holder: existing };
    }
    // 残锁回收后重试一次。
    try {
      fs.unlinkSync(lockFile);
    } catch (unlinkError) {
      return { acquired: false, holder: existing, stale: true };
    }
    return acquireLock(lockFile, ttlMs);
  }
}

function releaseLock(lockFile, payload) {
  const existing = readJsonSafe(lockFile, null);
  if (existing && existing.pid === payload.pid && existing.at === payload.at) {
    try {
      fs.unlinkSync(lockFile);
    } catch (error) {
      /* 忽略 */
    }
  }
}

function isAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

module.exports = {
  Store,
  DEFAULT_STATE,
  STATE_VERSION,
  sanitizeState,
  localDateKey,
  resetDailyCounter,
  writeJsonAtomic,
  readJsonSafe,
  acquireLock,
  releaseLock,
  PROCESSED_CACHE_TTL_MS,
};

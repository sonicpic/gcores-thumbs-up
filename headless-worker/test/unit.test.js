'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateItem } = require('../src/lib/rules');
const { sanitizeState, resetDailyCounter, acquireLock, Store, compactHistoryEntry, HISTORY_LIMIT, LIKES_LOG_LIMIT } = require('../src/lib/store');
const { sanitizeConfig, DEFAULT_CONFIG } = require('../src/lib/config');
const { isWithinActiveHours } = require('../src/lib/runner');

function baseFilters(overrides = {}) {
  return {
    allowAuthors: [],
    allowTopics: [],
    allowKeywords: [],
    allowEntryTypes: [],
    denyAuthors: [],
    denyTopics: [],
    denyKeywords: [],
    maxAgeHours: 0,
    onlyUnliked: true,
    ...overrides,
  };
}

function baseItem(overrides = {}) {
  return {
    itemKey: 'talks:1',
    targetType: 'talks',
    title: '普通动态',
    summary: '',
    authorIds: ['100'],
    topicIds: ['ps5'],
    alreadyLiked: false,
    publishedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('没有任何 allow 规则时默认全收', () => {
  const result = evaluateItem(baseItem(), baseFilters());
  assert.equal(result.matched, true);
  assert.deepEqual(result.allowHits, ['default-visible']);
});

test('onlyUnliked 会挡掉已点赞的动态', () => {
  const result = evaluateItem(baseItem({ alreadyLiked: true }), baseFilters());
  assert.equal(result.matched, false);
  assert.deepEqual(result.denyReasons, ['already-liked']);
});

test('onlyUnliked=false 时已点赞的动态仍可命中', () => {
  const result = evaluateItem(baseItem({ alreadyLiked: true }), baseFilters({ onlyUnliked: false }));
  assert.equal(result.matched, true);
});

test('deny 规则一票否决', () => {
  const filters = baseFilters({ denyKeywords: ['抽奖'] });
  const result = evaluateItem(baseItem({ title: '转发抽奖' }), filters);
  assert.equal(result.matched, false);
  assert.deepEqual(result.denyReasons, ['deny-keyword']);
});

test('allow 规则命中其一即通过', () => {
  const filters = baseFilters({ allowTopics: ['ps5'], allowEntryTypes: ['articles'] });
  const result = evaluateItem(baseItem({ targetType: 'talks' }), filters);
  assert.equal(result.matched, true);
  assert.deepEqual(result.allowHits, ['topic']);
});

test('allow 规则存在但都没命中则不通过', () => {
  const filters = baseFilters({ allowKeywords: ['战锤'] });
  const result = evaluateItem(baseItem({ title: '完全无关' }), filters);
  assert.equal(result.matched, false);
  assert.deepEqual(result.allowHits, []);
});

test('maxAgeHours 过滤过期动态', () => {
  const filters = baseFilters({ maxAgeHours: 24 });
  const old = baseItem({ publishedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() });
  assert.equal(evaluateItem(old, filters).matched, false);

  const fresh = baseItem({ publishedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
  assert.equal(evaluateItem(fresh, filters).matched, true);
});

test('每日计数跨天自动归零', () => {
  const stale = resetDailyCounter({ date: '2020-01-01', likes: 42 }, Date.now());
  assert.equal(stale.likes, 0);
  assert.notEqual(stale.date, '2020-01-01');
});

test('sanitizeState 会裁剪过期 processed 缓存', () => {
  const now = Date.now();
  const state = sanitizeState({
    processed: {
      'talks:1': { ts: now, status: 'dom' },
      'talks:2': { ts: now - 30 * 24 * 3600 * 1000, status: 'dom' },
    },
  });
  assert.ok(state.processed['talks:1']);
  assert.equal(state.processed['talks:2'], undefined);
});

test('sanitizeConfig 会把 v0.2 的平铺配置迁移到新结构', () => {
  const config = sanitizeConfig({ headless: false, storage: { stateFile: 'x/state.json' }, daemon: { intervalMinutes: 5 } });
  assert.equal(config.browser.headless, false);
  assert.equal(config.paths.stateFile, 'x/state.json');
  assert.equal(config.schedule.intervalMinutes, 5);
  assert.equal(config.headless, undefined);
});

test('sanitizeConfig 缺省开启无头模式', () => {
  assert.equal(sanitizeConfig({}).browser.headless, true);
  assert.equal(DEFAULT_CONFIG.browser.headless, true);
});

test('互斥锁：持有期间第二次获取会失败，释放后可再次获取', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-lock-'));
  const lockFile = path.join(dir, 'run.lock');

  const first = acquireLock(lockFile);
  assert.equal(first.acquired, true);

  const second = acquireLock(lockFile);
  assert.equal(second.acquired, false);
  assert.equal(second.holder.pid, process.pid);

  first.release();
  const third = acquireLock(lockFile);
  assert.equal(third.acquired, true);
  third.release();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('jitterMsRange 缺省值是一个合法的 [min,max] 区间', () => {
  const config = sanitizeConfig({});
  const [min, max] = config.timing.jitterMsRange;
  assert.ok(Number.isInteger(min) && Number.isInteger(max));
  assert.ok(min >= 0);
  assert.ok(max >= min);
});

test('jitterMsRange 会把区间规范化为非负且 min<=max', () => {
  // sanitizeRange 的语义：min 是下界，会强制 max >= min；倒挂的输入会被夹成等值。
  const config = sanitizeConfig({ timing: { jitterMsRange: [5000, 1000] } });
  const [min, max] = config.timing.jitterMsRange;
  assert.ok(min >= 0);
  assert.ok(max >= min);
  assert.equal(min, 5000);
  assert.equal(max, 5000);
});

test('jitterMsRange 为 [0,0] 时表示不抖动（不报错）', () => {
  const config = sanitizeConfig({ timing: { jitterMsRange: [0, 0] } });
  assert.deepEqual(config.timing.jitterMsRange, [0, 0]);
});

test('scrollRounds 缺省为 1，越界值会被夹到 [1,10]', () => {
  assert.equal(sanitizeConfig({}).run.scrollRounds, 1);
  assert.equal(sanitizeConfig({ run: { scrollRounds: 0 } }).run.scrollRounds, 1);
  assert.equal(sanitizeConfig({ run: { scrollRounds: 3 } }).run.scrollRounds, 3);
  assert.equal(sanitizeConfig({ run: { scrollRounds: 99 } }).run.scrollRounds, 10);
});

test('activeHours 非法时间会回退默认值，enabled 独立透传', () => {
  const ok = sanitizeConfig({ schedule: { activeHours: { enabled: true, start: '9:30', end: '23:00' } } });
  assert.equal(ok.schedule.activeHours.enabled, true);
  assert.equal(ok.schedule.activeHours.start, '9:30');
  assert.equal(ok.schedule.activeHours.end, '23:00');

  const bad = sanitizeConfig({ schedule: { activeHours: { enabled: true, start: '上午', end: '25:00' } } });
  assert.equal(bad.schedule.activeHours.start, DEFAULT_CONFIG.schedule.activeHours.start);
  assert.equal(bad.schedule.activeHours.end, DEFAULT_CONFIG.schedule.activeHours.end);

  assert.equal(sanitizeConfig({}).schedule.activeHours.enabled, false);
});

test('活跃时段：disabled 恒真；普通窗口两端包含', () => {
  const at = (h, m) => new Date(2026, 8, 28, h, m);
  const off = { activeHours: { enabled: false, start: '08:00', end: '23:59' } };
  assert.equal(isWithinActiveHours(off, at(3, 0)), true);

  const day = { activeHours: { enabled: true, start: '08:00', end: '23:59' } };
  assert.equal(isWithinActiveHours(day, at(7, 59)), false);
  assert.equal(isWithinActiveHours(day, at(8, 0)), true);
  assert.equal(isWithinActiveHours(day, at(23, 59)), true);
  assert.equal(isWithinActiveHours(day, at(0, 0)), false);
});

test('活跃时段：跨零点窗口（22:00~07:00）', () => {
  const at = (h, m) => new Date(2026, 8, 28, h, m);
  const night = { activeHours: { enabled: true, start: '22:00', end: '07:00' } };
  assert.equal(isWithinActiveHours(night, at(23, 30)), true);
  assert.equal(isWithinActiveHours(night, at(3, 0)), true);
  assert.equal(isWithinActiveHours(night, at(7, 0)), true);
  assert.equal(isWithinActiveHours(night, at(12, 0)), false);
  assert.equal(isWithinActiveHours(night, at(21, 59)), false);
});

test('活跃时段：start==end 视为全天', () => {
  const at = (h) => new Date(2026, 8, 28, h, 0);
  const all = { activeHours: { enabled: true, start: '08:00', end: '08:00' } };
  assert.equal(isWithinActiveHours(all, at(0)), true);
  assert.equal(isWithinActiveHours(all, at(23)), true);
});

test('旧版 state（没有 history/likes 字段）加载后自动补默认结构', () => {
  const state = sanitizeState({ processed: {}, totals: { runs: 3, liked: 5 } });
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.likes, []);
  assert.deepEqual(state.credentialReminder, { lastWarnDate: '' });
  assert.equal(state.totals.runs, 3);
});

test('recordRun 会把摘要压进 history 环（新的在前，封顶 HISTORY_LIMIT）', () => {
  const store = new Store(undefined); // 不落盘，直接操作内存 state
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
    store.recordRun({
      startedAt: new Date(2026, 8, 28, 0, i).toISOString(),
      ok: i % 2 === 0,
      stats: { scanned: 10, matched: 2, liked: i % 3, skipped: 8 },
      durationMs: 5000,
      jitterMs: 1000,
      matchedItems: [{ title: 'x' }],
    });
  }
  assert.equal(store.state.history.length, HISTORY_LIMIT);
  assert.ok(store.state.history[0].at >= store.state.history[1].at, '新的在前');
  assert.equal(store.state.history[0].matchedItems, undefined, '历史不带明细');
  assert.equal(store.state.history[0].liked, (HISTORY_LIMIT + 4) % 3);
});

test('compactHistoryEntry 只保留画图需要的字段', () => {
  const entry = compactHistoryEntry({ startedAt: '2026-09-28T00:00:00Z', ok: false, skipped: 'cooldown', stats: { scanned: 1, matched: 0, liked: 0, skipped: 1 }, durationMs: 12, jitterMs: 0, error: { message: 'x' } });
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'dryRun', 'durationMs', 'error', 'jitterMs', 'liked', 'matched', 'ok', 'scanned', 'skipped'].sort());
});

test('recordLike 留档新的在前，封顶 LIKES_LOG_LIMIT', () => {
  const store = new Store(undefined);
  for (let i = 0; i < LIKES_LOG_LIMIT + 5; i += 1) {
    store.recordLike({ at: new Date(2026, 8, 28, 0, 0, i).toISOString(), title: `t${i}`, type: 'talks', url: 'u', key: `k${i}` });
  }
  assert.equal(store.state.likes.length, LIKES_LOG_LIMIT);
  assert.equal(store.state.likes[0].key, `k${LIKES_LOG_LIMIT + 4}`);
});

test('凭证到期提醒每天只发一次', () => {
  const store = new Store(undefined);
  assert.equal(store.consumeCredentialReminderDay(10), true);
  assert.equal(store.consumeCredentialReminderDay(9), false);
  assert.equal(store.consumeCredentialReminderDay(9), false);
});

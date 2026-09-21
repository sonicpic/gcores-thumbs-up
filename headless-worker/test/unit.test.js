'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateItem } = require('../src/lib/rules');
const { sanitizeState, resetDailyCounter, acquireLock } = require('../src/lib/store');
const { sanitizeConfig, DEFAULT_CONFIG } = require('../src/lib/config');

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

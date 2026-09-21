'use strict';

const path = require('path');
const { cleanText } = require('./config');
const { Logger } = require('./logger');
const { Store } = require('./store');
const { createNotifier } = require('./notify');
const { evaluateItem } = require('./rules');
const {
  BlockedRequestError,
  SessionExpiredError,
  waitForFeed,
  createVoteTracker,
  clickLike,
  captureErrorScreenshot,
  gotoFeeds,
} = require('./gcores');
const { launchBrowser, newSessionContext, loadStorageState, saveStorageState, inspectStorageState } = require('./session');

function randomBetween(minValue, maxValue) {
  if (maxValue <= minValue) return minValue;
  return Math.floor(minValue + Math.random() * (maxValue - minValue + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function projectPath(root, relativePath) {
  return path.resolve(root, relativePath);
}

function createLogger(config, root, options = {}) {
  return new Logger({
    file: options.silentFile ? null : projectPath(root, config.paths.logFile),
    level: options.level || config.logging.level,
    maxBytes: config.logging.maxBytes,
    keepFiles: config.logging.keepFiles,
    mirrorToConsole: options.mirrorToConsole !== false,
  });
}

/**
 * 执行一轮。整个函数是"短生命周期"的：跑完即退出，不留常驻进程。
 * 崩溃、断电、RDP 断开都不会让它处于半死状态 —— 下一次调度重新来过。
 */
async function runRound({ config, root, dryRun = false, logger = null }) {
  const log = logger || createLogger(config, root);
  const notifier = createNotifier(config, log);
  const store = new Store(projectPath(root, config.paths.stateFile));
  const sessionFile = projectPath(root, config.paths.sessionFile);
  const screenshotFile = projectPath(root, config.paths.errorScreenshotFile);
  const stats = { scanned: 0, matched: 0, liked: 0, skipped: 0, consecutiveErrors: 0 };
  // 实际开始工作的时间戳；抖动之前就声明，供 finish() 统一取用。
  let summaryStartedAt = Date.now();

  const summary = {
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    ok: false,
    dryRun,
    sessionState: null,
    stats,
    matchedItems: [],
    error: null,
    jitterMs: 0,
  };

  const finish = async (extra = {}) => {
    Object.assign(summary, extra);
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - summaryStartedAt;
    store.recordRun(summary);
    store.save();
    await notifier.runSummary({ stats, durationMs: summary.durationMs, dryRun });
    return summary;
  };

  if (store.isCoolingDown()) {
    const until = new Date(store.state.cooldown.blockedUntil).toLocaleString('zh-CN', { hour12: false });
    log.info(`仍在冷却期（${store.state.cooldown.reason || '风控'}），跳过本轮，冷却至 ${until}`);
    return finish({ ok: true, skipped: 'cooldown' });
  }

  if (store.hasReachedDailyLimit(config)) {
    log.info(`今日点赞数已达上限 ${config.limits.maxLikesPerDay}，跳过本轮`);
    return finish({ ok: true, skipped: 'daily-limit' });
  }

  // 随机抖动：计划任务的触发间隔本身做不到随机，所以在这里睡一小段，
  // 让实际开始工作的时刻围绕「计划触发时刻 + 固定偏移」随机分布，避免过于规律。
  // 放在冷却/上限检查之后、启动浏览器之前 —— 冷却期与已达上限时不必白睡。
  const jitterMs = randomBetween(...config.timing.jitterMsRange);
  if (jitterMs > 0) {
    log.info(`随机抖动 ${Math.round(jitterMs / 1000)} 秒后开始本轮`);
    await sleep(jitterMs);
  }
  summary.jitterMs = jitterMs;
  summaryStartedAt = Date.now();
  summary.startedAt = new Date(summaryStartedAt).toISOString();

  let browser;
  let context;
  let page;
  let tracker;
  let aborted = false;
  const watchdog = setTimeout(() => {
    aborted = true;
    log.error(`单轮执行超过硬超时 ${config.run.maxRunMs}ms，强制中断`);
    if (context) context.close().catch(() => {});
  }, config.run.maxRunMs);
  watchdog.unref?.();

  try {
    const storageState = loadStorageState(sessionFile);
    summary.sessionState = storageState ? 'loaded' : 'missing';
    if (!storageState) {
      throw new SessionExpiredError('缺少登录态文件，请先执行 npm run gc:session:import');
    }

    log.info(`无头模式启动浏览器（channel=${config.browser.executablePath || config.browser.channel}, headless=${config.browser.headless}）`);
    browser = await launchBrowser(config);
    context = await newSessionContext(browser, config, storageState);
    page = context.pages()[0] || (await context.newPage());
    tracker = createVoteTracker(page);

    await gotoFeeds(page, config, log);

    const items = await waitForFeed(page, config.run.waitForFeedMs);
    if (!items.length) {
      log.error('当前页没有发现可处理的点赞按钮，可能页面结构变化或加载异常');
      if (config.run.screenshotOnError) {
        await captureErrorScreenshot(page, screenshotFile, log);
      }
      store.setSessionResult({ ok: true, cookieExpiresAt: 0 });
      return finish({ ok: false, error: { message: 'no-items', at: Date.now() } });
    }

    store.setSessionResult({ ok: true });
    log.info(`本轮发现 ${items.length} 个当前页点赞按钮${dryRun ? '（试运行，不会真的点赞）' : ''}`);

    for (const item of items) {
      if (aborted) {
        log.warn('已超时中断，停止处理剩余动态');
        break;
      }
      stats.scanned += 1;

      if (store.wasProcessed(item.itemKey)) {
        stats.skipped += 1;
        continue;
      }
      if (config.filters.onlyUnliked && item.alreadyLiked) {
        store.markProcessed(item.itemKey, 'already-liked');
        stats.skipped += 1;
        continue;
      }

      const evaluation = evaluateItem(item, config.filters);
      if (!evaluation.matched) {
        stats.skipped += 1;
        continue;
      }

      stats.matched += 1;
      summary.matchedItems.push({
        key: item.itemKey,
        title: item.title,
        url: item.url,
        reasons: evaluation.allowHits,
      });
      log.info(`命中：${item.title}（${item.itemKey}）`, { reasons: evaluation.allowHits });

      if (dryRun) {
        continue;
      }

      if (store.hasReachedDailyLimit(config)) {
        log.info('达到每日上限，提前结束本轮');
        break;
      }
      if (Number(config.limits.maxLikesPerRun) > 0 && stats.liked >= Number(config.limits.maxLikesPerRun)) {
        log.info('达到单轮上限，提前结束本轮');
        break;
      }

      try {
        const result = await clickLike(page, item, tracker, config);
        if (result && result.ok) {
          stats.liked += 1;
          stats.consecutiveErrors = 0;
          store.markProcessed(item.itemKey, result.mode || 'liked');
          store.incrementDailyLikes();
          log.info(`已点赞：${item.title}`);
          await notifier.likeResult({ item, resultText: '成功', detailText: result.mode || 'liked', stats });
        }
      } catch (error) {
        if (error instanceof BlockedRequestError) {
          store.setCooldown(config.timing.cooldownAfterBlockMs, `HTTP ${error.status}`);
          log.error(`检测到风控（HTTP ${error.status}），进入冷却期`);
          await notifier.likeResult({ item, resultText: '失败', detailText: `触发风控（HTTP ${error.status}）`, stats });
          throw error;
        }
        stats.consecutiveErrors += 1;
        log.error(`点赞失败：${item.title} | ${cleanText(error.message)}`);
        await notifier.likeResult({ item, resultText: '失败', detailText: error.message || '点赞失败', stats });
        if (stats.consecutiveErrors >= config.run.maxConsecutiveErrors) {
          log.warn(`连续失败 ${stats.consecutiveErrors} 次，熔断本轮`);
          break;
        }
      }

      await sleep(randomBetween(...config.timing.actionDelayMsRange));
    }

    // 顺手把（可能被服务端刷新过的）cookie 写回去，延长免登录寿命。
    if (!dryRun) {
      try {
        const refreshed = await context.storageState();
        saveStorageState(sessionFile, refreshed);
        const info = inspectStorageState(refreshed);
        store.setSessionResult({ ok: true, cookieExpiresAt: info.authExpiresAt });
        if (info.authDaysLeft !== null && info.authDaysLeft <= 7) {
          log.warn(`登录凭证将在约 ${info.authDaysLeft} 天后过期，建议提前重新导入登录态`);
        }
      } catch (error) {
        log.debug(`回写登录态失败：${cleanText(error.message)}`);
      }
    }

    log.info(
      `本轮完成：扫描 ${stats.scanned}，命中 ${stats.matched}，点赞 ${stats.liked}，跳过 ${stats.skipped}，今日累计 ${store.state.dailyCounter.likes}`
    );
    return finish({ ok: true });
  } catch (error) {
    const message = cleanText((error && error.message) || error);

    if (error instanceof BlockedRequestError) {
      store.setSessionResult({ ok: true, error: null });
      return finish({ ok: false, error: { message, kind: 'blocked' } });
    }

    if (error instanceof SessionExpiredError) {
      store.setSessionResult({ ok: false, error: message });
      if (page) await captureErrorScreenshot(page, screenshotFile, log);
      log.error(`登录态失效：${message}`);
      await notifier.sessionExpired({ message });
      return finish({ ok: false, error: { message, kind: 'session-expired' } });
    }

    store.setSessionResult({ ok: false, error: message });
    log.error(`本轮异常：${message}`);
    if (page && config.run.screenshotOnError) {
      await captureErrorScreenshot(page, screenshotFile, log);
    }
    await notifier.failure({ message, stats });
    return finish({ ok: false, error: { message, kind: 'unexpected' } });
  } finally {
    clearTimeout(watchdog);
    if (tracker) tracker.dispose();
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runRound, createLogger, projectPath, randomBetween, sleep };

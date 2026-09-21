'use strict';

const { cleanText } = require('./config');

class BlockedRequestError extends Error {
  constructor(status, message) {
    super(message || `vote request blocked with HTTP ${status}`);
    this.name = 'BlockedRequestError';
    this.status = status;
  }
}

class SessionExpiredError extends Error {
  constructor(message) {
    super(message || '检测到登录态失效');
    this.name = 'SessionExpiredError';
  }
}

/**
 * 页面侧actor。整段逻辑运行在浏览器上下文里，宿主侧只负责调度。
 *
 * 选择器沿用 v0.2 已验证可用的那套（.o_vote-up 等），
 * 因为它们是跑通过的，换掉只会带来无谓风险。
 */
async function pageDomAction(page, action, payload = {}) {
  return page.evaluate(({ action, payload }) => {
    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }
    function normalizeToken(value) {
      return cleanText(value).toLowerCase();
    }
    function uniqueStrings(values) {
      return Array.from(new Set(values.map((item) => cleanText(item)).filter(Boolean)));
    }
    function pickFirstText(values) {
      for (const value of values) {
        const text = cleanText(value);
        if (text) return text;
      }
      return '';
    }
    function hashString(value) {
      const text = String(value || '');
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }
    function normalizePublishedAt(text) {
      const raw = cleanText(text);
      if (!raw) return null;
      const now = Date.now();
      if (/^\d{13}$/.test(raw)) return new Date(Number(raw)).toISOString();
      if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000).toISOString();
      if (/(刚刚|刚才)/.test(raw)) return new Date(now).toISOString();
      if (/(\d+)\s*分钟前/.test(raw)) return new Date(now - Number(RegExp.$1) * 60 * 1000).toISOString();
      if (/(\d+)\s*小时前/.test(raw)) return new Date(now - Number(RegExp.$1) * 60 * 60 * 1000).toISOString();
      if (/昨天/.test(raw)) return new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const parsed = Date.parse(raw.replace(/[./]/g, '-'));
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    }
    function parseEntryPath(urlOrPath) {
      try {
        const url = new URL(urlOrPath, location.origin);
        const match = url.pathname.match(
          /^\/(articles|videos|radios|talks|discussions|originals|timelines|albums|collections|products|games|films|external_links|external-links)\/([^/?#]+)/i
        );
        if (!match) return null;
        return {
          targetType: normalizeToken(match[1]).replace(/_/g, '-'),
          targetId: String(match[2]),
          url: url.toString(),
        };
      } catch (error) {
        return null;
      }
    }
    function findFeedContainer(button) {
      return (
        button.closest(
          '.talk, .original-feed, .original, .am_card, [data-feed-id], [data-entry-id], article, li, section, .feedItem, .flowCard'
        ) || button.closest('div')
      );
    }
    function findPrimaryEntryLink(container) {
      if (!container) return null;
      return Array.from(container.querySelectorAll('a[href]')).find((link) => Boolean(parseEntryPath(link.href))) || null;
    }
    function inferEntryType(container) {
      const className = normalizeToken(container && container.className ? container.className : '');
      if (className.includes('original')) return 'originals';
      if (className.includes('discussion')) return 'discussions';
      if (className.includes('video')) return 'videos';
      if (className.includes('radio')) return 'radios';
      if (className.includes('timeline')) return 'timelines';
      if (className.includes('article')) return 'articles';
      if (className.includes('talk')) return 'talks';
      return 'dom';
    }
    function findLikeButton(container) {
      if (!container) return null;
      return (
        container.querySelector('.o_vote-up') ||
        container.querySelector('[class*="o_vote-up"]') ||
        container.querySelector('[aria-label*="喜欢"]') ||
        container.querySelector('[data-action*="like"]') ||
        null
      );
    }
    function isLikeButtonActive(button) {
      if (!button) return false;
      return (
        /\bis_active\b/.test(button.className || '') ||
        button.getAttribute('aria-pressed') === 'true' ||
        (button.dataset && button.dataset.active === 'true')
      );
    }
    function hasLoginPrompt() {
      return Array.from(document.querySelectorAll('button, p, h1, div')).some((node) => {
        const text = cleanText(node.textContent || '');
        return text.includes('需登录后才可显示内容') || text.includes('登录机核');
      });
    }
    function collect() {
      const scope =
        document.querySelector('.pageContainer .flowLayout_main') ||
        document.querySelector('.flowLayout_main') ||
        document.querySelector('main') ||
        document.body;
      const buttons = Array.from(
        scope.querySelectorAll('a.o_vote-up[role="button"], .o_vote-up[role="button"], a.o_vote-up, .o_vote-up')
      ).filter((button) => !button.closest('.flowLayout_side, aside, footer'));
      const seen = new Set();
      const records = [];
      buttons.forEach((button) => {
        const container = findFeedContainer(button);
        const entryLink = findPrimaryEntryLink(container);
        const parsed = entryLink ? parseEntryPath(entryLink.href) : null;
        const title = pickFirstText([
          entryLink && entryLink.textContent,
          container && container.querySelector('h1, h2, h3, h4') && container.querySelector('h1, h2, h3, h4').textContent,
          container && container.querySelector('[class*="title"]') && container.querySelector('[class*="title"]').textContent,
          container && container.querySelector('p') && container.querySelector('p').textContent,
        ]);
        const summary = pickFirstText([
          container && container.querySelector('[class*="summary"]') && container.querySelector('[class*="summary"]').textContent,
          container && container.querySelector('[class*="desc"]') && container.querySelector('[class*="desc"]').textContent,
        ]);
        const publishedAt = normalizePublishedAt(
          (container && container.querySelector('time[datetime]') && container.querySelector('time[datetime]').getAttribute('datetime')) ||
            (container && container.querySelector('[data-time]') && container.querySelector('[data-time]').getAttribute('data-time')) ||
            (container && container.textContent) ||
            ''
        );
        const itemKey = parsed
          ? `${parsed.targetType}:${parsed.targetId}`
          : `dom:${hashString([title, summary, publishedAt, cleanText(container && container.className)].join('|'))}`;
        if (seen.has(itemKey)) return;
        seen.add(itemKey);
        records.push({
          itemKey,
          targetType: parsed ? parsed.targetType : inferEntryType(container),
          targetId: parsed ? parsed.targetId : itemKey.replace(/^dom:/, ''),
          alreadyLiked: isLikeButtonActive(button),
          authorIds: uniqueStrings(
            Array.from(container && container.querySelectorAll('a[href*="/users/"]') ? container.querySelectorAll('a[href*="/users/"]') : [])
              .map((link) => {
                const match = (link.getAttribute('href') || '').match(/\/users\/(\d+)/);
                return match ? match[1] : '';
              })
              .filter(Boolean)
          ),
          topicIds: uniqueStrings(
            Array.from(container && container.querySelectorAll('a[href*="/topics/"]') ? container.querySelectorAll('a[href*="/topics/"]') : []).flatMap(
              (link) => {
                const href = link.getAttribute('href') || '';
                const match = href.match(/\/topics\/([^/?#]+)/);
                const values = [];
                if (match) values.push(match[1]);
                const text = cleanText(link.textContent || '');
                if (text) values.push(text);
                return values;
              }
            )
          ),
          title: title || itemKey,
          summary,
          url: (parsed && parsed.url) || (entryLink && entryLink.href) || location.href,
          publishedAt,
          button,
        });
      });
      return records;
    }

    if (action === 'loginPrompt') return hasLoginPrompt();
    if (action === 'extract') return collect().map(({ button, ...item }) => item);
    if (action === 'isLiked') {
      const target = collect().find((item) => item.itemKey === payload.itemKey);
      return target ? target.alreadyLiked : false;
    }
    if (action === 'click') {
      const target = collect().find((item) => item.itemKey === payload.itemKey);
      if (!target || !target.button) return { ok: false, reason: 'not-found' };
      if (isLikeButtonActive(target.button)) return { ok: true, alreadyLiked: true };
      if (typeof target.button.click === 'function') {
        target.button.click();
      } else {
        const MouseEventCtor =
          target.button.ownerDocument && target.button.ownerDocument.defaultView
            ? target.button.ownerDocument.defaultView.MouseEvent
            : MouseEvent;
        target.button.dispatchEvent(new MouseEventCtor('click', { bubbles: true, cancelable: true, composed: true }));
      }
      return { ok: true, alreadyLiked: false };
    }
    throw new Error(`unsupported action: ${action}`);
  }, { action, payload });
}

async function hasLoginPrompt(page) {
  return pageDomAction(page, 'loginPrompt');
}

async function extractItems(page) {
  return pageDomAction(page, 'extract');
}

/** 轮询等待动态列表渲染出来；同时把"登录失效"当作独立的返回状态。 */
async function waitForFeed(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let items = [];
  while (Date.now() < deadline) {
    if (await pageDomAction(page, 'loginPrompt')) {
      throw new SessionExpiredError('页面提示需登录后才可显示内容');
    }
    items = await pageDomAction(page, 'extract');
    if (items.length > 0) {
      return items;
    }
    await page.waitForTimeout(500);
  }
  return items;
}

/** 记录 /votes 请求的响应码，用来识别风控（401/403/429）。 */
function createVoteTracker(page) {
  const records = [];
  const handler = (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch (error) {
      return;
    }
    if (!/\/votes(?:\/|$|\.json)/i.test(url.pathname) && !/vote/i.test(url.pathname)) {
      return;
    }
    records.push({ status: response.status(), at: Date.now() });
    if (records.length > 200) records.shift();
  };
  page.on('response', handler);
  return {
    blockedSince(timestamp) {
      return records.find((item) => item.at >= timestamp && [401, 403, 429].includes(item.status)) || null;
    },
    dispose() {
      page.off('response', handler);
    },
  };
}

async function clickLike(page, item, tracker, config) {
  const startedAt = Date.now();
  const clicked = await pageDomAction(page, 'click', { itemKey: item.itemKey });
  if (!clicked || !clicked.ok) {
    throw new Error('没有找到可点击的点赞按钮');
  }
  if (clicked.alreadyLiked) {
    return { ok: true, mode: 'already-liked' };
  }
  const deadline = Date.now() + config.run.clickTimeoutMs;
  while (Date.now() < deadline) {
    const blocked = tracker.blockedSince(startedAt);
    if (blocked) {
      throw new BlockedRequestError(blocked.status, `vote request blocked with HTTP ${blocked.status}`);
    }
    if (await pageDomAction(page, 'isLiked', { itemKey: item.itemKey })) {
      return { ok: true, mode: 'dom' };
    }
    await page.waitForTimeout(200);
  }
  const blocked = tracker.blockedSince(startedAt);
  if (blocked) {
    throw new BlockedRequestError(blocked.status, `vote request blocked with HTTP ${blocked.status}`);
  }
  throw new Error('点击后点赞按钮没有进入激活状态');
}

async function captureErrorScreenshot(page, file, logger) {
  if (!page || page.isClosed()) return;
  try {
    await page.screenshot({ path: file, fullPage: true });
    logger.warn(`已保存失败截图：${file}`);
  } catch (error) {
    logger.debug(`截图失败：${cleanText(error.message)}`);
  }
}

/** 带退避重试的导航：网络抖动不应该直接判死刑。 */
async function gotoFeeds(page, config, logger, attempts = config.run.navigationRetries) {
  page.setDefaultTimeout(config.run.navigationTimeoutMs);
  page.setDefaultNavigationTimeout(config.run.navigationTimeoutMs);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(config.target.feedsUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      return;
    } catch (error) {
      lastError = error;
      logger.warn(`第 ${attempt}/${attempts} 次打开动态页失败：${cleanText(error.message)}`);
      if (attempt < attempts) {
        await page.waitForTimeout(1500 * attempt).catch(() => {});
      }
    }
  }
  throw lastError;
}

module.exports = {
  BlockedRequestError,
  SessionExpiredError,
  pageDomAction,
  hasLoginPrompt,
  extractItems,
  waitForFeed,
  createVoteTracker,
  clickLike,
  captureErrorScreenshot,
  gotoFeeds,
};

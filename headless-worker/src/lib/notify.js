'use strict';

const { cleanText } = require('./config');
const { formatTimestamp } = require('./logger');

const PUSHPLUS_API = 'https://www.pushplus.plus/send';

function getPushPlusToken(config) {
  return cleanText(process.env.PUSHPLUS_TOKEN || (config.notifications && config.notifications.pushplusToken) || '');
}

async function sendPushPlusMessage({ token, title, content, template = 'markdown' }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 10000) : null;
  try {
    const response = await fetch(PUSHPLUS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, title, content, template }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.code !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function buildLines(title, fields) {
  const lines = [`# ${title}`, ''];
  fields.forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    lines.push(`- ${key}: ${value}`);
  });
  return lines.join('\n');
}

/**
 * 通知器：通知永远是"附加能力"，任何异常都不能反向影响点赞主流程，
 * 这一点与旧版一致 —— 但新版把它收敛成一个带开关的对象。
 */
function createNotifier(config, logger) {
  const enabled = config.notifications && config.notifications.enabled !== false;
  const token = getPushPlusToken(config);

  async function send(title, content) {
    if (!enabled || !token) return false;
    try {
      await sendPushPlusMessage({ token, title, content });
      return true;
    } catch (error) {
      logger.warn(`PushPlus 推送失败：${cleanText(error && error.message ? error.message : error)}`);
      return false;
    }
  }

  return {
    available: Boolean(enabled && token),

    /** 忽略各 on* 开关，只验证推送链路本身是否通。 */
    async test({ message }) {
      if (!token) return false;
      return send(
        'GCORES 自动化测试通知',
        buildLines('GCORES 自动化测试通知', [
          ['时间', formatTimestamp()],
          ['说明', cleanText(message)],
        ])
      );
    },

    async likeResult({ item, resultText, detailText, stats }) {
      if (!config.notifications.onLike) return false;
      return send(
        `GCORES 点赞${resultText}`,
        buildLines('GCORES 点赞结果', [
          ['时间', formatTimestamp()],
          ['结果', resultText],
          ['标题', cleanText(item.title || item.itemKey)],
          ['链接', cleanText(item.url || '') || '未知'],
          ['类型', cleanText(item.targetType || '未知')],
          ['本轮统计', `扫描 ${stats.scanned} / 命中 ${stats.matched} / 成功 ${stats.liked} / 跳过 ${stats.skipped}`],
          ['详情', detailText ? cleanText(detailText) : ''],
        ])
      );
    },

    async failure({ message, stats }) {
      if (!config.notifications.onFailure) return false;
      return send(
        'GCORES 自动化异常',
        buildLines('GCORES 自动化异常', [
          ['时间', formatTimestamp()],
          ['错误', cleanText(message)],
          [
            '本轮统计',
            stats ? `扫描 ${stats.scanned} / 命中 ${stats.matched} / 成功 ${stats.liked} / 跳过 ${stats.skipped}` : '',
          ],
        ])
      );
    },

    async sessionExpired({ message }) {
      if (!config.notifications.onSessionExpired) return false;
      return send(
        'GCORES 登录态失效',
        buildLines('GCORES 登录态失效', [
          ['时间', formatTimestamp()],
          ['原因', cleanText(message)],
          ['处理', '在能连上桌面时执行 npm run gc:session:import 重新导入登录态'],
        ])
      );
    },

    async runSummary({ stats, durationMs, dryRun }) {
      if (!config.notifications.onRunSummary) return false;
      return send(
        `GCORES 巡检报告${dryRun ? '（试运行）' : ''}`,
        buildLines('GCORES 巡检报告', [
          ['时间', formatTimestamp()],
          ['耗时', `${Math.round(durationMs / 1000)} 秒`],
          ['扫描', stats.scanned],
          ['命中', stats.matched],
          ['点赞', stats.liked],
          ['跳过', stats.skipped],
        ])
      );
    },
  };
}

module.exports = { createNotifier, getPushPlusToken };

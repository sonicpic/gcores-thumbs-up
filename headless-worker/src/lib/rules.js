'use strict';

const { normalizeToken, normalizeStringList } = require('./config');

function hasAnyAllowRules(filters) {
  return [filters.allowAuthors, filters.allowTopics, filters.allowKeywords, filters.allowEntryTypes].some(
    (list) => Array.isArray(list) && list.length > 0
  );
}

function matchesAnyToken(sourceValues, filterValues) {
  const sourceSet = new Set(sourceValues.map((item) => normalizeToken(item)).filter(Boolean));
  return filterValues.some((value) => sourceSet.has(normalizeToken(value)));
}

function matchesAnyKeyword(text, keywords) {
  const normalizedText = normalizeToken(text);
  return keywords.some((keyword) => normalizedText.includes(normalizeToken(keyword)));
}

/**
 * 单条动态的命中判定：先看 deny*（一票否决），再看 allow*（任一命中）。
 * 没有任何 allow 规则时视为"默认全收"，与旧版行为保持一致。
 */
function evaluateItem(item, filters, now = Date.now()) {
  const denyReasons = [];
  const allowHits = [];
  const itemText = `${item.title || ''} ${item.summary || ''}`;
  const hasAllowRules = hasAnyAllowRules(filters);
  const authorIds = normalizeStringList(item.authorIds);
  const topicIds = normalizeStringList(item.topicIds);
  const entryType = normalizeToken(item.targetType);

  if (filters.onlyUnliked && item.alreadyLiked) {
    denyReasons.push('already-liked');
  }
  if (filters.maxAgeHours && item.publishedAt) {
    const ageHours = (now - new Date(item.publishedAt).getTime()) / (60 * 60 * 1000);
    if (!Number.isFinite(ageHours) || ageHours > filters.maxAgeHours) {
      denyReasons.push('too-old');
    }
  }
  if (filters.denyAuthors.length && matchesAnyToken(authorIds, filters.denyAuthors)) {
    denyReasons.push('deny-author');
  }
  if (filters.denyTopics.length && matchesAnyToken(topicIds, filters.denyTopics)) {
    denyReasons.push('deny-topic');
  }
  if (filters.denyKeywords.length && matchesAnyKeyword(itemText, filters.denyKeywords)) {
    denyReasons.push('deny-keyword');
  }

  if (hasAllowRules) {
    if (filters.allowAuthors.length && matchesAnyToken(authorIds, filters.allowAuthors)) allowHits.push('author');
    if (filters.allowTopics.length && matchesAnyToken(topicIds, filters.allowTopics)) allowHits.push('topic');
    if (filters.allowKeywords.length && matchesAnyKeyword(itemText, filters.allowKeywords)) allowHits.push('keyword');
    if (filters.allowEntryTypes.length && matchesAnyToken([entryType], filters.allowEntryTypes)) allowHits.push('entry-type');
  } else {
    allowHits.push('default-visible');
  }

  return {
    matched: denyReasons.length === 0 && allowHits.length > 0,
    allowHits,
    denyReasons,
  };
}

module.exports = { evaluateItem, hasAnyAllowRules };

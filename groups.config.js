'use strict';

const GROUPS = Object.freeze({
  G01: Object.freeze({
    code: 'G01',
    source_key: 'group_1894427947317950',
    group_id: '1894427947317950',
    source_name: 'Hội đam mê loa, âm thanh cổ toàn quốc',
    source_url: 'https://www.facebook.com/groups/1894427947317950/',
  }),
  G02: Object.freeze({
    code: 'G02',
    source_key: 'group_1533748640064116',
    group_id: '1533748640064116',
    source_name: 'Hội Đam Mê JBL Toàn Quốc',
    source_url: 'https://www.facebook.com/groups/1533748640064116/',
  }),
  G03: Object.freeze({
    code: 'G03',
    source_key: 'group_211209436218489',
    group_id: '211209436218489',
    source_name: 'Hội Đam Mê Loa ALTEC LANSING Toàn Quốc',
    source_url: 'https://www.facebook.com/groups/211209436218489/',
  }),
  G04: Object.freeze({
    code: 'G04',
    source_key: 'group_336751110133869',
    group_id: '336751110133869',
    source_name: 'Hội những Người Yêu Thích Loa Altec',
    source_url: 'https://www.facebook.com/groups/336751110133869/',
  }),
});

const GROUP_LIST = Object.freeze(Object.values(GROUPS));

function normalize(value) {
  return String(value ?? '').trim();
}

function groupIdFromUrl(value) {
  return normalize(value).match(/facebook\.com\/groups\/(\d+)/i)?.[1] || '';
}

function resolveGroup(input = {}) {
  const requestedId = normalize(input.group_id) || groupIdFromUrl(input.source_url || input.group_url);
  const requestedKey = normalize(input.source_key);

  const group = GROUP_LIST.find((candidate) =>
    (requestedId && candidate.group_id === requestedId) ||
    (requestedKey && candidate.source_key === requestedKey)
  );

  if (!group) {
    const allowed = GROUP_LIST.map((g) => ({
      code: g.code,
      group_id: g.group_id,
      source_key: g.source_key,
      source_name: g.source_name,
    }));
    const err = new Error('group_not_allowed');
    err.code = 'group_not_allowed';
    err.allowed = allowed;
    throw err;
  }

  return group;
}

module.exports = {
  GROUPS,
  GROUP_LIST,
  resolveGroup,
  groupIdFromUrl,
};

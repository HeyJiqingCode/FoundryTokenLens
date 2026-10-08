import type { MessageValue } from '../../types.js';

export default {
  'navigation.version': 'Foundry Token Lens v{version}',
  'navigation.dataManagement': '数据管理',
  'navigation.account': '账户',
  'navigation.analysis': '用量分析',
  'navigation.authentication': '身份认证',
  'navigation.backToOverview': '返回概览',
  'navigation.main': '主导航',
  'navigation.notFound': '页面不存在',
  'navigation.overview': '概览',
  'navigation.platform': '平台设置',
  'navigation.prices': '单价设置',
  'navigation.requests': '请求明细',
  'navigation.settings': '设置',
  'navigation.settingsSections': '设置分类',
} as const satisfies Record<string, MessageValue>;

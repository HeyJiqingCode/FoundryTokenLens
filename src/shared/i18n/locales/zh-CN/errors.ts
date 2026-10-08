import type { MessageValue } from '../../types.js';

export default {
  'errors.fieldValidation': '{field}：{error}',
  'errors.joinMessages': '{first}；{next}',
  'errors.recordConflict': '记录已存在或与现有配置冲突。',
  'errors.invalidRequest': '请求格式不正确。',

  'errors.pageFailed': '页面暂时无法显示',
  'errors.pageFailedHint': '请重试，或从菜单打开其他页面。',
  'errors.retryPage': '重试',

  'errors.serviceUnavailable': '服务暂时不可用，正在重新连接…',
  'errors.serviceUnavailableTitle': '服务暂时不可用',
  'errors.serviceUnavailableHint': '正在自动重新连接，服务恢复后会继续。',
  'errors.invalidValue': '请输入有效的值。',
  'errors.invalidId': '请输入有效的 ID（UUID）。',
  'errors.invalidFormat': '输入格式不正确。',
  'errors.invalidSelection': '请选择有效选项。',
  'errors.unsupportedFields': '请求包含不支持的字段。',
  'errors.minLength': '至少输入 {count} 个字符。',
  'errors.maxLength': '最多输入 {count} 个字符。',
  'errors.minItems': '至少包含 {count} 项。',
  'errors.maxItems': '最多包含 {count} 项。',
  'errors.minimumValue': '数值不能小于 {count}。',
  'errors.maximumValue': '数值不能大于 {count}。',
  'errors.greaterThan': '数值必须大于 {count}。',
  'errors.lessThan': '数值必须小于 {count}。',
  'errors.httpStatus': '请求失败（{status}）。',
  'errors.operationFailed': '操作失败，请重试。',
  'errors.operationIncomplete': '操作未完成，请稍后重试。',
  'errors.rateLimited': '操作过于频繁，请稍后再试。',
} as const satisfies Record<string, MessageValue>;

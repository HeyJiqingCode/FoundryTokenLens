import type { MessageValue } from '../../types.js';

export default {
  'common.chooseTime': '选择时间',
  'common.hour': '小时',
  'common.minute': '分钟',
  'common.clearDate': '清除日期',
  'common.chooseDate': '选择日期',
  'common.previousMonth': '上个月',
  'common.nextMonth': '下个月',
  'common.now': '现在',
  'common.done': '完成',
  'common.timeZone': '时区',
  'common.searchTimeZone': '搜索时区',
  'common.chooseTimeZone': '选择时区',
  'common.noTimeZones': '没有匹配的时区',
  'common.switchToEnglish': 'Switch to English',
  'common.switchToChinese': '切换为简体中文',
  'common.actions': '操作',
  'common.cancel': '取消',
  'common.checkTheURLOrReturnToTheOverview': '请检查地址，或返回概览。',

  'common.closeNamed': '关闭{name}',
  'common.completed': '完成',
  'common.containerCannotBeSelectedMoreThanOnce': '容器不能重复选择',

  'common.creating': '正在创建…',
  'common.dayCount': '{count} 天',

  'common.deleting': '正在删除…',
  'common.disabled': '已停用',

  'common.dismissNotification': '关闭提示',

  'common.empty': '',

  'common.enabled': '已启用',
  'common.endTime': '结束时间',
  'common.enterANonNegativeUSDRateWithUp': '输入非负美元单价，最多 12 位小数',
  'common.failed': '失败',
  'common.foundryTokenLensOverview': 'Foundry Token Lens 概览',
  'common.input': '输入',
  'common.interrupted': '已中断',
  'common.invalidManagedIdentityClientIDFormat': 'Managed identity 的 Client ID 格式不正确。',

  'common.languageChinese': '简体中文',
  'common.languageEnglish': 'English',
  'common.loadingSettings': '正在读取配置…',
  'common.model': '模型',
  'common.next': '下一页',
  'common.notifications': '消息通知',
  'common.output': '输出',
  'common.partial': '部分完成',

  'common.previous': '上一页',
  'common.processing': '正在处理…',

  'common.running': '处理中',
  'common.savedSecretHint': '已保存密钥，输入新值可替换。',
  'common.saving': '正在保存…',
  'common.selectOnlyOneAuthenticationMethod': '认证方式只能选择一种。',
  'common.selectedContainerIsMissingOrUnreadable': '所选容器不存在或无法读取，请重新测试连接。',
  'common.startTime': '开始时间',
  'common.status': '状态',
  'common.time': '时间',

  'common.unableToConnectToTheApplicationService': '暂时无法连接应用服务。',
  'common.updating': '正在更新…',

  'common.useHHMmFormat': '使用 HH:mm 格式',

  'common.verifyingAndSaving': '正在验证并保存…',
} as const satisfies Record<string, MessageValue>;

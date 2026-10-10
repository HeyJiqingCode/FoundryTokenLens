import type { MessageValue } from '../../types.js';

export default {
  'pricing.pricing': '价格',
  'pricing.noStartDate': '不限起始时间',
  'pricing.cacheRead': '缓存读取',
  'pricing.cacheWrite': '缓存写入',
  'pricing.textInput': '文本输入',
  'pricing.imageInput': '图像输入',
  'pricing.textCacheRead': '文本缓存读取',
  'pricing.imageCacheRead': '图像缓存读取',
  'pricing.imageOutput': '图像输出',
  'pricing.priceUnitGlobal': 'USD / 1M Tokens · 默认使用 Global Standard 价格',
  'pricing.backToEditor': '返回编辑',
  'pricing.invalidPriceTemplate': '计费项与模型的价格模板不匹配。',
  'pricing.usePrice': '填入草稿',
  'pricing.endTime': '结束时间',
  'pricing.modelAdded': '模型已添加。',
  'pricing.displayName': '显示名称',
  'pricing.modelAlreadyExists': '该 Model ID 已存在，请直接编辑现有模型价格。',
  'pricing.logModelIdReadOnly': '来自日志的 Model ID 不可修改。',
  'pricing.prefillUnsupported': '该模型的计费项超出当前价格模板，暂不支持自动填入。',
  'pricing.pricesFilled': '价格与有效期已填入草稿。',
  'pricing.fetchingPrices': '获取中…',
  'pricing.fetchPrices': '获取价格',
  'pricing.choosePrefillPrice': '选择价格',

  'pricing.enterPrice': '请至少填写一项单价。',
  'pricing.enterLongPrice': '请至少填写一项长上下文单价。',
  'pricing.chooseStartTime': '请选择生效时间。',
  'pricing.unitPrices': '单价',
  'pricing.startTime': '生效时间',
  'pricing.backToVersion': '返回当前版本',
  'pricing.contextTiers': '按上下文长度分档',
  'pricing.contextThreshold': '输入 Token 分界值',
  'pricing.inputTokens': '输入 Token 数',
  'pricing.invalidContextThreshold': '分界值需为 1–9,999,999,999 的整数。',
  'pricing.priceFetchFailed': '获取价格失败，请稍后重试。',
  'pricing.modelIdLabel': 'Model ID: {id}',
  'pricing.modelIdCopied': '模型 ID 已复制。',
  'pricing.copyModelId': '复制模型 ID',
  'pricing.deleteModelNotice':
    '删除该模型的价格历史和已计算费用，并从模型列表移除。日志与用量保留；重新添加模型后可重新设置价格。',
  'pricing.deleteModel': '删除模型',
  'pricing.deleteNamedModel': '删除 {model}',
  'pricing.modelDeleted': '模型已删除。',
  'pricing.confirmModelId': '确认模型 ID',
  'pricing.confirmModelDeletion': '确认删除',
  'pricing.modelNotFound': '模型不存在。',
  'pricing.modelConfirmationMismatch': '模型 ID 不匹配。',
  'pricing.endAfterStart': '结束时间必须晚于生效时间。',
  'pricing.periodOverlap': '有效期与相邻价格版本重叠，请调整日期。',
  'pricing.modelList': '模型列表',
  'pricing.refreshModels': '刷新模型',
  'pricing.modelsRefreshed': '模型列表已刷新。',
  'pricing.addModel': '添加模型',

  'pricing.noModels': '还没有模型',
  'pricing.noModelsHint': '导入日志后刷新，或添加模型。',

  'pricing.editPrice': '编辑价格',
  'pricing.editModelPrice': '编辑 {model} 的价格',

  'pricing.priceHistory': '价格历史',
  'pricing.modelHistory': '{model} 的价格历史',

  'pricing.noRetailMatch': 'Retail 暂无匹配价格',

  'pricing.effectivePeriod': '有效期',
  'pricing.multiplePeriods': '多个有效期',
  'pricing.alwaysValid': '长期有效',
  'pricing.startsOnDate': '{date} 开始',
  'pricing.endsOnDate': '{date} 结束',

  'pricing.newVersion': '新增版本',

  'pricing.currentVersion': '生效中',
  'pricing.futureVersion': '待生效',
  'pricing.pastVersion': '已结束',
  'pricing.noHistory': '还没有价格记录',
  'pricing.shortContext': '短上下文',
  'pricing.longContext': '长上下文',

  'pricing.addPriceVersion': '新增价格版本',

  'pricing.cacheReads': '缓存读取',

  'pricing.cacheWrites': '缓存写入',
  'pricing.effectivePeriodOverlapsALaterPriceVersion': '有效期与后续价格版本重叠。',
  'pricing.endTimeOptional': '结束时间（可选）',

  'pricing.invalidRegionFormatOrTooManyRegionsSelected': '区域格式不正确或一次同步区域过多。',

  'pricing.meterKeysMustBeUnique': '计费项标识不能重复',

  'pricing.noResourceRegionHasBeenDiscovered': '尚未发现资源区域，请指定要同步的 Azure 区域。',

  'pricing.priceSaved': '价格已保存。',

  'pricing.priceVersionNotFound': '价格版本不存在。',

  'pricing.priceWithTheSameScopeAndEffectiveTime':
    '同一适用范围已有相同生效时间的价格，请使用修正功能。',
  'pricing.retailReturnedMultipleRatesForTheSameMeter':
    'Retail 同一计费项返回多个不同单价，需手工确认。',
  'pricing.savePrice': '保存价格',
} as const satisfies Record<string, MessageValue>;

import type { MessageValue } from '../../types.js';

export default {
  'ingestion.selectedSourcesUnavailable': '所选数据源已禁用或不存在，请重新选择。',
  'ingestion.configureADataSourceFirst': '请先配置数据源。',
  'ingestion.serviceIsStopping': '服务正在停止，请稍后重试。',
  'ingestion.taskIsRunning': '当前任务执行中。',
} as const satisfies Record<string, MessageValue>;

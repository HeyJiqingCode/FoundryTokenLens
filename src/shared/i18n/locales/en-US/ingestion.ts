import type source from '../zh-CN/ingestion.js';
import type { LocaleMessages } from '../../types.js';

export default {
  'ingestion.selectedSourcesUnavailable':
    'A selected data source is disabled or no longer exists. Select the sources again.',
  'ingestion.configureADataSourceFirst': 'Configure a data source first.',
  'ingestion.serviceIsStopping': 'The service is stopping. Please try again later.',
  'ingestion.taskIsRunning': 'A task is running.',
} satisfies LocaleMessages<typeof source>;

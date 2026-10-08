import zhAnalytics from './locales/zh-CN/analytics.js';
import enAnalytics from './locales/en-US/analytics.js';
import zhAuth from './locales/zh-CN/auth.js';
import enAuth from './locales/en-US/auth.js';
import zhCommon from './locales/zh-CN/common.js';
import enCommon from './locales/en-US/common.js';
import zhErrors from './locales/zh-CN/errors.js';
import enErrors from './locales/en-US/errors.js';
import zhInsights from './locales/zh-CN/insights.js';
import enInsights from './locales/en-US/insights.js';
import zhIngestion from './locales/zh-CN/ingestion.js';
import enIngestion from './locales/en-US/ingestion.js';
import zhNavigation from './locales/zh-CN/navigation.js';
import enNavigation from './locales/en-US/navigation.js';
import zhPlatform from './locales/zh-CN/platform.js';
import enPlatform from './locales/en-US/platform.js';
import zhPricing from './locales/zh-CN/pricing.js';
import enPricing from './locales/en-US/pricing.js';
import zhSchedule from './locales/zh-CN/schedule.js';
import enSchedule from './locales/en-US/schedule.js';
import zhSources from './locales/zh-CN/sources.js';
import enSources from './locales/en-US/sources.js';

export const zhCN = {
  ...zhAnalytics,
  ...zhAuth,
  ...zhCommon,
  ...zhErrors,
  ...zhIngestion,
  ...zhInsights,
  ...zhNavigation,
  ...zhPlatform,
  ...zhPricing,
  ...zhSchedule,
  ...zhSources,
};
export const enUS = {
  ...enAnalytics,
  ...enAuth,
  ...enCommon,
  ...enErrors,
  ...enIngestion,
  ...enInsights,
  ...enNavigation,
  ...enPlatform,
  ...enPricing,
  ...enSchedule,
  ...enSources,
};

export type MessageKey = keyof typeof zhCN;
export const catalogs = { 'zh-CN': zhCN, 'en-US': enUS };
export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(zhCN, value);
}

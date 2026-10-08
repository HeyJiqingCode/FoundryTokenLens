export type Locale = 'zh-CN' | 'en-US';
export type MessageValue = string | { one: string; other: string };
export type LocaleMessages<Source> = { [Key in keyof Source]: MessageValue };

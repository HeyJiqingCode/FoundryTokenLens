import { translate, useLocale, type MessageKey, type MessageParams } from '../i18n';

export function LocalizedLabel({
  message,
  params,
}: {
  message: MessageKey;
  params?: MessageParams;
}) {
  const locale = useLocale();
  return <span className="localized-label">{translate(message, locale, params)}</span>;
}

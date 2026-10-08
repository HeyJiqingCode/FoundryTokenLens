import { LocalizedLabel } from './LocalizedLabel';
import { Languages } from 'lucide-react';
import { setLocale, t, useLocale } from '../i18n';

export function LanguageSwitch({ menu = false }: { menu?: boolean }) {
  const locale = useLocale();
  return (
    <button
      className={menu ? undefined : 'language-toggle'}
      type="button"
      role={menu ? 'menuitem' : undefined}
      tabIndex={menu ? -1 : undefined}
      title={t(locale === 'zh-CN' ? 'common.switchToEnglish' : 'common.switchToChinese')}
      onClick={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')}
    >
      <Languages size={menu ? 17 : 16} strokeWidth={menu ? 1.7 : 2} aria-hidden="true" />
      <span>
        <LocalizedLabel
          message={locale === 'zh-CN' ? 'common.languageChinese' : 'common.languageEnglish'}
        />
      </span>
    </button>
  );
}

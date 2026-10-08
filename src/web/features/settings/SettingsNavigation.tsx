import { t, useLocale } from '../../i18n';
import { SETTINGS_SECTIONS, type SettingsSection } from '../../../shared/navigation';
import { SectionTabs } from '../../components/SectionTabs';

export function SettingsNavigation({
  section,
  canManage,
}: {
  section: SettingsSection;
  canManage: boolean;
}) {
  useLocale();
  return (
    <SectionTabs
      id="settings"
      label={t('navigation.settingsSections')}
      value={section}
      items={SETTINGS_SECTIONS.filter((item) => canManage || item.id === 'platform')}
      hrefFor={(value) => `/settings/${value}`}
    />
  );
}

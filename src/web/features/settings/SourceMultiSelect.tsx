import type { SourceSettings } from '../../../shared/settings';
import { Pill } from '../../components/Pill';
import { MultiSelect } from '../../components/MultiSelect';
import { t, useLocale } from '../../i18n';
export function SourceMultiSelect({
  sources,
  value,
  onChange,
  disabled,
}: {
  sources: SourceSettings[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
}) {
  useLocale();
  return (
    <MultiSelect
      label={t('schedule.linkedSources')}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder={t('schedule.selectSourcePlaceholder')}
      emptyText={t('sources.noSources')}
      options={sources.map((source) => ({
        value: source.id,
        label: source.accountName,
        aside: !source.enabled && (
          <Pill capsule tone="error">
            {t('common.disabled')}
          </Pill>
        ),
      }))}
    />
  );
}

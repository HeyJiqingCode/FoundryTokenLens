import { Check, ChevronDown } from 'lucide-react';
import {
  Button,
  ComboBox,
  I18nProvider,
  Input,
  Label,
  ListBox,
  ListBoxItem,
} from 'react-aria-components';
import { t, useLocale } from '../../i18n';
import { PickerPopover } from './PickerPopover';

const timeZones = [
  ...new Set([
    'Asia/Shanghai',
    'UTC',
    'America/Los_Angeles',
    'America/New_York',
    'Europe/London',
    'Europe/Paris',
    'Asia/Tokyo',
    'Asia/Singapore',
    ...Intl.supportedValuesOf('timeZone'),
  ]),
].map((id) => ({ id }));

export function TimeZoneField({
  value,
  onChange,
  disabled = false,
  date,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  date?: Date;
}) {
  const locale = useLocale();
  const offset = new Intl.DateTimeFormat('en', { timeZone: value, timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')
    ?.value.replace('GMT', 'UTC');
  return (
    <I18nProvider locale={locale}>
      <ComboBox
        className="field timezone-field"
        defaultItems={timeZones}
        selectedKey={value}
        onSelectionChange={(key) => {
          if (key) onChange(String(key));
        }}
        isDisabled={disabled}
        menuTrigger="focus"
      >
        <div className="picker-label-row">
          <Label className="field-label">{t('common.timeZone')}</Label>
          <span>{offset}</span>
        </div>
        <div className="picker-control">
          <Input placeholder={t('common.searchTimeZone')} />
          <Button className="picker-icon-button" aria-label={t('common.chooseTimeZone')}>
            <ChevronDown size={16} />
          </Button>
        </div>
        <PickerPopover className="timezone-popover" placement="bottom start" maxHeight={250}>
          <ListBox<{ id: string }>
            className="timezone-options"
            renderEmptyState={() => <div className="timezone-empty">{t('common.noTimeZones')}</div>}
          >
            {(zone) => (
              <ListBoxItem id={zone.id} textValue={zone.id} className="timezone-option">
                {({ isSelected }) => (
                  <>
                    <span>{zone.id}</span>
                    {isSelected && <Check size={15} />}
                  </>
                )}
              </ListBoxItem>
            )}
          </ListBox>
        </PickerPopover>
      </ComboBox>
    </I18nProvider>
  );
}

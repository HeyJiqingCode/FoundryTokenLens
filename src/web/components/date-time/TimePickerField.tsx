import { useId, useState } from 'react';
import { Time } from '@internationalized/date';
import {
  Button,
  DateInput,
  DateSegment,
  Dialog,
  DialogTrigger,
  I18nProvider,
  TimeField,
} from 'react-aria-components';
import { Clock3 } from 'lucide-react';
import { TimeWheel } from './TimeWheel';
import { PickerPopover } from './PickerPopover';
import { t, useLocale } from '../../i18n';

export function TimePickerField({
  label,
  name,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const locale = useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [hour, minute] = value.split(':').map(Number);
  const time = new Time(hour, minute);
  return (
    <I18nProvider locale={locale}>
      <div className="field clock-field">
        <span className="field-label" id={id}>
          {label}
        </span>
        <div className="picker-control" data-disabled={disabled || undefined}>
          <TimeField
            aria-labelledby={id}
            name={name}
            value={time}
            hourCycle={24}
            granularity="minute"
            isDisabled={disabled}
            isRequired
            onChange={(next) => {
              if (next)
                onChange(
                  `${String(next.hour).padStart(2, '0')}:${String(next.minute).padStart(2, '0')}`,
                );
            }}
          >
            <DateInput className="date-input">
              {(segment) => <DateSegment className="date-segment" segment={segment} />}
            </DateInput>
          </TimeField>
          <DialogTrigger isOpen={open} onOpenChange={setOpen}>
            <Button
              className="picker-icon-button"
              aria-label={`${label} · ${t('common.chooseTime')}`}
              isDisabled={disabled}
            >
              <Clock3 size={15} />
            </Button>
            <PickerPopover className="clock-popover" placement="bottom start" maxHeight={400}>
              <Dialog className="clock-options" aria-label={label}>
                <div className="time-wheels">
                  <TimeWheel
                    label={t('common.hour')}
                    count={24}
                    value={hour}
                    onChange={(next) =>
                      onChange(
                        `${String(next).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
                      )
                    }
                  />
                  <TimeWheel
                    label={t('common.minute')}
                    count={12}
                    step={5}
                    value={minute}
                    onChange={(next) =>
                      onChange(`${String(hour).padStart(2, '0')}:${String(next).padStart(2, '0')}`)
                    }
                  />
                </div>
                <div className="time-wheel-actions">
                  <Button className="button primary" onPress={() => setOpen(false)}>
                    {t('common.done')}
                  </Button>
                </div>
              </Dialog>
            </PickerPopover>
          </DialogTrigger>
        </div>
      </div>
    </I18nProvider>
  );
}

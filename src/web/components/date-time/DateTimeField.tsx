import { LocalizedLabel } from '../LocalizedLabel';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, X } from 'lucide-react';
import { now, toTime, Time, type ZonedDateTime } from '@internationalized/date';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DateInput,
  DatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  I18nProvider,
  Label,
  TimeField,
} from 'react-aria-components';
import { t, useLocale, type MessageKey } from '../../i18n';
import { PickerPopover } from './PickerPopover';

export function DateTimeField({
  label,
  name,
  value,
  onChange,
  timeZone,
  required = false,
  disabled = false,
  unbounded,
}: {
  label: string;
  name: string;
  value: ZonedDateTime | null;
  onChange: (value: ZonedDateTime | null) => void;
  timeZone: string;
  required?: boolean;
  disabled?: boolean;
  unbounded?: { label: MessageKey; selected: boolean; onSelect: () => void };
}) {
  const locale = useLocale();
  const placeholder = now(timeZone).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
  return (
    <I18nProvider locale={locale}>
      <DatePicker<ZonedDateTime>
        className="field date-time-field"
        name={name}
        value={value}
        onChange={onChange}
        granularity="minute"
        hourCycle={24}
        hideTimeZone
        placeholderValue={placeholder}
        isRequired={required && !unbounded?.selected}
        isDisabled={disabled}
        shouldCloseOnSelect={false}
      >
        {({ state }) => (
          <>
            <Label className="field-label">{label}</Label>
            <Group className="picker-control">
              {unbounded?.selected ? (
                <Button
                  slot={null}
                  className="date-unbounded-value"
                  aria-label={`${label} · ${t(unbounded.label)}`}
                  aria-haspopup="dialog"
                  aria-expanded={state.isOpen}
                  isDisabled={disabled}
                  onPress={() => state.setOpen(true)}
                >
                  <LocalizedLabel message={unbounded.label} />
                </Button>
              ) : (
                <DateInput className="date-input">
                  {(segment) => <DateSegment className="date-segment" segment={segment} />}
                </DateInput>
              )}
              {!required && value && (
                <Button
                  slot={null}
                  className="picker-icon-button"
                  aria-label={t('common.clearDate')}
                  onPress={() => onChange(null)}
                >
                  <X size={14} />
                </Button>
              )}
              <Button className="picker-icon-button" aria-label={t('common.chooseDate')}>
                <CalendarDays size={17} />
              </Button>
            </Group>
            <PickerPopover className="calendar-popover" placement="bottom end">
              <Dialog className="calendar-dialog" aria-label={label}>
                <Calendar className="date-calendar" firstDayOfWeek="mon">
                  <header className="calendar-heading">
                    <Heading />
                    <div>
                      <Button
                        slot="previous"
                        className="picker-icon-button"
                        aria-label={t('common.previousMonth')}
                      >
                        <ChevronLeft size={17} />
                      </Button>
                      <Button
                        slot="next"
                        className="picker-icon-button"
                        aria-label={t('common.nextMonth')}
                      >
                        <ChevronRight size={17} />
                      </Button>
                    </div>
                  </header>
                  <CalendarGrid>
                    <CalendarGridHeader>
                      {(day) => <CalendarHeaderCell>{day}</CalendarHeaderCell>}
                    </CalendarGridHeader>
                    <CalendarGridBody>
                      {(date) => <CalendarCell className="calendar-day" date={date} />}
                    </CalendarGridBody>
                  </CalendarGrid>
                </Calendar>
                <div className="calendar-time-row">
                  <span>
                    <Clock3 size={15} />
                    {t('common.time')}
                  </span>
                  <TimeField<Time>
                    aria-label={t('common.time')}
                    value={
                      state.timeValue
                        ? new Time(state.timeValue.hour, state.timeValue.minute)
                        : toTime(placeholder)
                    }
                    hourCycle={24}
                    granularity="minute"
                    onChange={(time) => {
                      if (time)
                        state.setTimeValue(
                          (value ?? placeholder).set({
                            hour: time.hour,
                            minute: time.minute,
                            second: 0,
                            millisecond: 0,
                          }),
                        );
                    }}
                  >
                    <DateInput className="time-input">
                      {(segment) => <DateSegment className="date-segment" segment={segment} />}
                    </DateInput>
                  </TimeField>
                </div>
                <footer className="calendar-actions">
                  <div className="calendar-shortcuts">
                    <Button
                      className="text-button"
                      onPress={() => onChange(now(timeZone).set({ second: 0, millisecond: 0 }))}
                    >
                      <LocalizedLabel message="common.now" />
                    </Button>
                    {unbounded && (
                      <Button
                        slot={null}
                        className="text-button"
                        onPress={() => {
                          state.setOpen(false);
                          unbounded.onSelect();
                        }}
                      >
                        <LocalizedLabel message={unbounded.label} />
                      </Button>
                    )}
                  </div>
                  <Button className="button primary" onPress={() => state.setOpen(false)}>
                    <LocalizedLabel message="common.done" />
                  </Button>
                </footer>
              </Dialog>
            </PickerPopover>
          </>
        )}
      </DatePicker>
    </I18nProvider>
  );
}

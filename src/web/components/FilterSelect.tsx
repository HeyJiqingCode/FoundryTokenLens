import { Button, ListBox, ListBoxItem, Select } from 'react-aria-components';
import { Check, ChevronDown } from 'lucide-react';
import { t } from '../i18n';
import { PickerPopover } from './date-time/PickerPopover';

const ALL = '__all__';
/** A filter chip showing its label and current value; `fallback` is the value that reads as unfiltered. */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
  fallback = '',
  allOption = true,
  allLabel = t('insights.filterAll'),
  display,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
  fallback?: string;
  allOption?: boolean;
  allLabel?: string;
  display?: string;
}) {
  const items = [
    ...(allOption ? [{ id: ALL, label: allLabel }] : []),
    ...options.filter((option) => option.id !== ALL),
  ];
  const selected = items.find((item) => item.id === (value || ALL));
  return (
    <Select
      aria-label={label}
      value={value || ALL}
      onChange={(key) => onChange(key === null || key === ALL ? '' : String(key))}
    >
      <Button className={`filter-chip${value !== fallback ? ' active' : ''}`}>
        <span className="filter-chip-label">{label}</span>
        <span className="filter-chip-value">{display ?? selected?.label ?? value}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </Button>
      <PickerPopover className="filter-popover" placement="bottom start" maxHeight={320}>
        <ListBox className="filter-options" items={items}>
          {(item) => (
            <ListBoxItem id={item.id} textValue={item.label} className="filter-option">
              {({ isSelected }) => (
                <>
                  <span>{item.label}</span>
                  {isSelected && <Check size={14} aria-hidden="true" />}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </PickerPopover>
    </Select>
  );
}

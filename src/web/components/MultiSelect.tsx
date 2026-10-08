import { useId, type ReactNode } from 'react';
import { Button, Dialog, DialogTrigger } from 'react-aria-components';
import { ChevronDown } from 'lucide-react';
import { useLocale } from '../i18n';
import { PickerPopover } from './date-time/PickerPopover';

export function MultiSelect<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  placeholder,
  emptyText,
  separator,
}: {
  label: string;
  options: { value: T; label: string; aside?: ReactNode }[];
  value: T[];
  onChange: (value: T[]) => void;
  disabled?: boolean;
  placeholder: string;
  emptyText?: string;
  separator?: string;
}) {
  const id = useId();
  const locale = useLocale();
  const names = options
    .filter((option) => value.includes(option.value))
    .map((option) => option.label)
    .join(separator ?? (locale === 'zh-CN' ? '、' : ', '));
  return (
    <div className="field multi-select">
      <span className="field-label" id={id}>
        {label}
      </span>
      <DialogTrigger>
        <Button
          className="multi-select-trigger"
          aria-labelledby={id}
          aria-describedby={`${id}-selection`}
          isDisabled={disabled}
        >
          <span id={`${id}-selection`} title={names}>
            {names || placeholder}
          </span>
          <ChevronDown size={15} />
        </Button>
        <PickerPopover className="multi-select-popover" placement="bottom start" maxHeight={260}>
          <Dialog aria-label={label} className="multi-select-options">
            {options.map((option) => (
              <label className="checkbox-label" key={option.value}>
                <input
                  type="checkbox"
                  checked={value.includes(option.value)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...value, option.value]
                        : value.filter((item) => item !== option.value),
                    )
                  }
                />
                <span>{option.label}</span>
                {option.aside}
              </label>
            ))}
            {!options.length && <p className="field-hint">{emptyText}</p>}
          </Dialog>
        </PickerPopover>
      </DialogTrigger>
    </div>
  );
}

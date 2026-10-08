import { t, useLocale } from '../i18n';
import { useState, type InputHTMLAttributes } from 'react';

const SAVED_SECRET_MASK = '************';

export function SecretInput({
  hasSavedValue,
  value,
  onFocus,
  onBlur,
  title,
  placeholder,
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue'> & {
  hasSavedValue: boolean;
  value: string;
}) {
  useLocale();
  const [editing, setEditing] = useState(false);
  const showingSavedValue = hasSavedValue && !value && !editing;
  return (
    <input
      {...props}
      type="password"
      value={showingSavedValue ? SAVED_SECRET_MASK : value}
      onFocus={(event) => {
        setEditing(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setEditing(false);
        onBlur?.(event);
      }}
      autoComplete="off"
      spellCheck={false}
      className={`secret-input${showingSavedValue ? ' has-saved-value' : ''} ${className}`.trim()}
      placeholder={placeholder}
      title={showingSavedValue ? t('common.savedSecretHint') : title}
      aria-description={hasSavedValue ? t('common.savedSecretHint') : undefined}
    />
  );
}

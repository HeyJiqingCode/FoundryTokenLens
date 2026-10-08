import { LocalizedLabel } from './LocalizedLabel';
export function EnabledToggle({
  value,
  onChange,
  disabled = false,
  title,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      title={title}
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      className={`enabled-toggle${value ? ' is-enabled' : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className="enabled-toggle-track" aria-hidden="true" />
      <LocalizedLabel message={value ? 'common.enabled' : 'common.disabled'} />
    </button>
  );
}

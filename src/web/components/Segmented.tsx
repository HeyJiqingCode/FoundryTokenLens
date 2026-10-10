/**
 * A row of mutually exclusive options, such as a split or a metric switch. Every option keeps the
 * width of its selected (bold) label, so choosing one never resizes the control.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          <span className="segmented-label" data-label={option.label}>
            {option.label}
          </span>
        </button>
      ))}
    </div>
  );
}

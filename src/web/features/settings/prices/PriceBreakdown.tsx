import { t, useLocale, type MessageKey } from '../../../i18n';
import { rateRange, type PriceValues } from './model-prices';
import { priceTemplate } from '../../../../shared/price-form';
import { LocalizedLabel } from '../../../components/LocalizedLabel';

const fields: [string, MessageKey, string][] = [
  ['input', 'common.input', 'blue'],
  ['cache_read', 'pricing.cacheRead', 'teal'],
  ['cache_write', 'pricing.cacheWrite', 'amber'],
  ['output', 'common.output', 'violet'],
];

export function PriceBreakdown({
  values,
  model = '',
  stacked = false,
}: {
  values: PriceValues;
  model?: string;
  stacked?: boolean;
}) {
  useLocale();
  const template = priceTemplate(model);
  const visible: typeof fields =
    template === 'image'
      ? [
          ['input_text', 'pricing.textInput', 'blue'],
          ['input_image', 'pricing.imageInput', 'slate'],
          ['cache_read_text', 'pricing.textCacheRead', 'teal'],
          ['cache_read_image', 'pricing.imageCacheRead', 'amber'],
          ['output_image', 'pricing.imageOutput', 'violet'],
        ]
      : fields;
  return (
    <div className={`price-breakdown ${template}${stacked ? ' stacked' : ''}`}>
      {visible.map(([key, label, tone]) => (
        <span className={`price-breakdown-item tone-${tone}`} key={key}>
          <span className="price-breakdown-label">
            {stacked ? <LocalizedLabel message={label} /> : t(label)}
          </span>
          <strong className={`price-breakdown-value ${!values[key]?.length ? 'price-empty' : ''}`}>
            {values[key]?.length ? `$${rateRange(values[key])}` : '—'}
          </strong>
        </span>
      ))}
    </div>
  );
}

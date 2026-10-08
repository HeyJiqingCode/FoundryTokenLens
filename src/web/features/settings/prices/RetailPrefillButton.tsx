import { useEffect, useRef, useState, type RefObject } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import type { FormPrices, RetailPrefillOption } from '../../../../shared/price-form';
import { api, errorMessage } from '../../../api';
import { t, useLocale } from '../../../i18n';
import { contextLabel } from '../../analytics/format';
import { FormNotice, type Notice } from '../../../components/Form';
import { LocalizedLabel } from '../../../components/LocalizedLabel';
import { PriceBreakdown } from './PriceBreakdown';
import type { PriceValues } from './model-prices';

export function RetailPrefillButton({
  model,
  disabled,
  onReady,
  onLoading,
  buttonRef,
}: {
  model: string;
  disabled: boolean;
  onReady: (options: RetailPrefillOption[]) => void;
  onLoading: (loading: boolean) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function fetchPrices() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    onLoading(true);
    setNotice(null);
    try {
      const result = await api<{ options: RetailPrefillOption[] }>('/api/pricing/prefill', {
        method: 'POST',
        body: { model: model.trim() },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.options.length) onReady(result.options);
      else setNotice({ kind: 'error', text: 'pricing.noRetailMatch' });
    } catch (error) {
      if (!controller.signal.aborted) setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        onLoading(false);
      }
    }
  }
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`button secondary toolbar-button price-fetch-button${loading ? ' spinning' : ''}`}
        disabled={disabled || loading || !model.trim()}
        onClick={() => void fetchPrices()}
      >
        {loading ? <LoaderCircle size={14} /> : <Download size={14} />}
        <LocalizedLabel message={loading ? 'pricing.fetchingPrices' : 'pricing.fetchPrices'} />
      </button>
      <FormNotice notice={notice} />
    </>
  );
}

export function RetailPriceOptions({
  options,
  model,
  timeZone,
  onFill,
}: {
  options: RetailPrefillOption[];
  model: string;
  timeZone: string;
  onFill: (option: RetailPrefillOption) => void;
}) {
  const locale = useLocale();
  const format = (value: string) =>
    `${new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value))} (${timeZone})`;
  const values = (prices: FormPrices): PriceValues =>
    Object.fromEntries(
      Object.entries(prices)
        .filter(([, value]) => value !== '')
        .map(([key, value]) => [key, [value]]),
    );
  return (
    <div className="price-dialog-body price-quote-body">
      {options.map((option) => (
        <article key={option.id} className="price-history-entry">
          <div className="price-history-heading">
            <div>
              <strong>{`${t('pricing.startTime')} · ${format(option.validFrom)}`}</strong>
              {option.validTo && <p>{`${t('pricing.endTime')} · ${format(option.validTo)}`}</p>}
              <p>
                {option.family} · {option.regions.join(' · ')}
              </p>
            </div>
            <button type="button" className="button secondary" onClick={() => onFill(option)}>
              <LocalizedLabel message="pricing.usePrice" />
            </button>
          </div>
          <div className={`price-history-bands ${!option.longPrices ? 'unified' : ''}`}>
            {[option.prices, ...(option.longPrices ? [option.longPrices] : [])].map(
              (prices, index) => (
                <div className="price-history-column" key={index}>
                  {option.longPrices && (
                    <div className="price-history-band-heading">
                      <strong>{t(contextLabel(index === 0 ? 'short' : 'long'))}</strong>
                    </div>
                  )}
                  <PriceBreakdown values={values(prices)} model={model} stacked />
                </div>
              ),
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

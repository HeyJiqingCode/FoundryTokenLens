import { LocalizedLabel } from '../../../components/LocalizedLabel';
import { Coins, History, Pencil } from 'lucide-react';
import type { PriceVersion } from '../../../../shared/settings';
import { comparePriceStarts } from '../../../../shared/price-period';
import { t, useLocale } from '../../../i18n';
import { contextLabel } from '../../analytics/format';
import { PriceBreakdown } from './PriceBreakdown';
import { Dialog } from '../../../components/Dialog';
import { manualPriceBands, periodLabel, versionStatus, type ModelPrices } from './model-prices';

export function PriceHistoryDialog({
  model,
  onClose,
  onEdit,
}: {
  model: ModelPrices;
  onClose: () => void;
  onEdit: (price: PriceVersion) => void;
}) {
  const locale = useLocale();
  const history = [...model.prices].sort((a, b) => comparePriceStarts(b.validFrom, a.validFrom));
  return (
    <Dialog
      title={t('pricing.priceHistory')}
      subtitle={model.displayName ? `${model.displayName} · ${model.name}` : model.name}
      icon={History}
      tone="violet"
      busy={false}
      onClose={onClose}
    >
      <div className="price-dialog-body price-history-list">
        {!history.length && (
          <div className="empty-state">
            <Coins size={28} />
            <h3>
              <LocalizedLabel message="pricing.noHistory" />
            </h3>
          </div>
        )}
        {history.map((price) => {
          const status = versionStatus(price);
          const bands = manualPriceBands(price);
          return (
            <article key={price.id} className="price-history-entry">
              <div className="price-history-heading">
                <div>
                  <strong>{periodLabel(price.validFrom, price.validTo)}</strong>
                </div>
                <span
                  className={`price-source tone-${status === 'pricing.pastVersion' ? 'error' : status === 'pricing.currentVersion' ? 'success' : 'blue'}`}
                >
                  <LocalizedLabel message={status} />
                </span>
                <button
                  className="icon-button accent"
                  aria-label={t('pricing.editPrice')}
                  onClick={() => onEdit(price)}
                >
                  <Pencil size={17} />
                </button>
              </div>
              <div className={`price-history-bands ${bands.length === 1 ? 'unified' : ''}`}>
                {bands.map((band) => (
                  <div className="price-history-column" key={band.kind}>
                    {band.kind !== 'all' && (
                      <div className="price-history-band-heading">
                        <strong>{t(contextLabel(band.kind))}</strong>
                        {band.threshold && (
                          <span>
                            {band.kind === 'short' ? '≤' : '>'}{' '}
                            {Number(band.threshold).toLocaleString(locale)} tokens
                          </span>
                        )}
                      </div>
                    )}
                    <PriceBreakdown values={band.values} model={model.name} stacked />
                  </div>
                ))}
              </div>
              {price.notes && <p className="price-history-notes">{price.notes}</p>}
            </article>
          );
        })}
      </div>
    </Dialog>
  );
}

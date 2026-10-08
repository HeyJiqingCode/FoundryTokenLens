import { LocalizedLabel } from '../../../components/LocalizedLabel';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Coins, History, Plus, RefreshCw } from 'lucide-react';
import openaiLogo from '../../../assets/openai.svg';
import type { PricingState } from '../../../../shared/pricing';
import type { PriceVersion } from '../../../../shared/settings';
import { priceAppliesAt } from '../../../../shared/price-period';
import { api, errorMessage } from '../../../api';
import { t, useLocale } from '../../../i18n';
import { FormNotice, type Notice } from '../../../components/Form';
import { Card } from '../../../components/Card';
import { Dialog } from '../../../components/Dialog';
import { PriceHistoryDialog } from './PriceHistoryDialog';
import { PriceBreakdown } from './PriceBreakdown';
import { PriceDeleteDialog } from './PriceDeleteDialog';
import { CardLoading, EmptyState, RowActions } from '../settings-table';
import { contextLabel } from '../../analytics/format';
import {
  modelPrices,
  modelSummary,
  modelTitle,
  modelProvider,
  type ModelPrices,
} from './model-prices';

const PriceEditorDialog = lazy(() =>
  import('./PriceEditorDialog').then((module) => ({ default: module.PriceEditorDialog })),
);

type OpenDialog = { kind: 'edit' | 'history' | 'delete'; model: ModelPrices; price?: PriceVersion };
export function PriceSettings() {
  useLocale();
  const [data, setData] = useState<{ state: PricingState; prices: PriceVersion[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const generation = useRef(0);
  const load = useCallback(async (notify = false) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const [state, { prices }] = await Promise.all([
        notify
          ? api<PricingState>('/api/pricing/models/refresh', { method: 'POST', body: {} })
          : api<PricingState>('/api/pricing'),
        api<{ prices: PriceVersion[] }>('/api/settings/prices'),
      ]);
      if (current !== generation.current) return;
      setData({ state, prices });
      if (notify) setNotice({ kind: 'success', text: 'pricing.modelsRefreshed' });
    } catch (error) {
      if (current === generation.current) setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const counter = generation;
    void load();
    return () => {
      counter.current++;
    };
  }, [load]);
  const models = modelPrices(
    data?.state.detected ?? [],
    data?.prices ?? [],
    data?.state.excludedModels,
    data?.state.models,
  );
  function saved(text: string) {
    setDialog(null);
    setNotice({ kind: 'success', text });
    void load();
  }
  return (
    <>
      <Card
        title={<LocalizedLabel message="navigation.prices" />}
        icon={Coins}
        tone="violet"
        actions={
          <>
            <button
              className={`button secondary toolbar-button${loading ? ' spinning' : ''}`}
              disabled={loading}
              onClick={() => void load(true)}
            >
              <RefreshCw size={14} />
              <LocalizedLabel message="pricing.refreshModels" />
            </button>
            <button
              className="button secondary toolbar-button"
              onClick={() =>
                setDialog({ kind: 'edit', model: { name: '', scopes: [], prices: [] } })
              }
            >
              <Plus size={14} />
              <LocalizedLabel message="pricing.addModel" />
            </button>
          </>
        }
      >
        {loading && !data ? (
          <CardLoading />
        ) : !models.length ? (
          <EmptyState title="pricing.noModels" hint="pricing.noModelsHint" />
        ) : (
          <table className="data-table list model-price-table" aria-label={t('pricing.modelList')}>
            <thead>
              <tr>
                <th>
                  <LocalizedLabel message="common.model" />
                </th>
                <th>
                  <LocalizedLabel message="pricing.pricing" />
                </th>
                <th>
                  <LocalizedLabel message="pricing.startTime" />
                </th>
                <th>
                  <LocalizedLabel message="common.actions" />
                </th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const summary = modelSummary(model);
                const provider = modelProvider(model.name);
                return (
                  <tr key={model.name.toLowerCase()}>
                    <td>
                      <div className="price-model-identity">
                        {provider ? (
                          <img
                            className="price-model-logo"
                            src={openaiLogo}
                            width={28}
                            height={28}
                            alt="OpenAI"
                            draggable={false}
                          />
                        ) : (
                          <span className="price-model-initial" aria-hidden="true">
                            {Array.from(model.name)[0]?.toLocaleUpperCase()}
                          </span>
                        )}
                        <div>
                          <strong
                            className="price-model-name"
                            title={model.displayName || modelTitle(model.name)}
                          >
                            {model.displayName || modelTitle(model.name)}
                          </strong>
                          <div className="price-model-meta" title={model.name}>
                            {t('pricing.modelIdLabel', { id: model.name })}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {summary.bands.length ? (
                        <div className="price-list-pricing">
                          {summary.bands.map((band) => (
                            <div className="price-context-line" key={band.kind}>
                              {band.kind !== 'all' && (
                                <>
                                  <span className="price-context-label">
                                    {t(contextLabel(band.kind))}
                                  </span>
                                  <span className="price-context-dash" aria-hidden="true">
                                    –
                                  </span>
                                </>
                              )}
                              <PriceBreakdown values={band.values} model={model.name} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="price-empty">—</span>
                      )}
                    </td>
                    <td className="price-list-period">{summary.period}</td>
                    <td>
                      <RowActions
                        className="model-price-actions"
                        edit={{
                          label: t('pricing.editModelPrice', { model: model.name }),
                          title: t('pricing.editPrice'),
                          onClick: () =>
                            setDialog({
                              kind: 'edit',
                              model,
                              price:
                                model.prices.find((price) =>
                                  priceAppliesAt(price, new Date().toISOString()),
                                ) ?? model.prices[0],
                            }),
                        }}
                        remove={{
                          label: t('pricing.deleteNamedModel', { model: model.name }),
                          title: t('pricing.deleteModel'),
                          onClick: () => setDialog({ kind: 'delete', model }),
                        }}
                      >
                        <span className="row-action-divider" aria-hidden="true" />
                        <button
                          className="icon-button price-history-action"
                          aria-label={t('pricing.modelHistory', { model: model.name })}
                          title={t('pricing.priceHistory')}
                          onClick={() => setDialog({ kind: 'history', model })}
                        >
                          <History size={16} />
                        </button>
                      </RowActions>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <FormNotice notice={notice} />
      </Card>
      {dialog?.kind === 'edit' && (
        <Suspense
          fallback={
            <Dialog title={t('pricing.editPrice')} busy={false} onClose={() => setDialog(null)}>
              <div className="price-dialog-body">{t('common.loadingSettings')}</div>
            </Dialog>
          }
        >
          <PriceEditorDialog
            model={dialog.model}
            existingModels={
              data?.state.models ??
              models.map((model) => ({
                model: model.name,
                displayName: model.displayName ?? null,
                fromLogs: Boolean(model.fromLogs || model.scopes.length),
              }))
            }
            price={dialog.price}
            onClose={() => setDialog(null)}
            onSaved={() => saved(dialog.model.name ? 'pricing.priceSaved' : 'pricing.modelAdded')}
          />
        </Suspense>
      )}
      {dialog?.kind === 'history' && (
        <PriceHistoryDialog
          model={dialog.model}
          onClose={() => setDialog(null)}
          onEdit={(price) => setDialog({ kind: 'edit', model: dialog.model, price })}
        />
      )}
      {dialog?.kind === 'delete' && (
        <PriceDeleteDialog
          model={dialog.model}
          onClose={() => setDialog(null)}
          onDeleted={() => saved('pricing.modelDeleted')}
        />
      )}
    </>
  );
}

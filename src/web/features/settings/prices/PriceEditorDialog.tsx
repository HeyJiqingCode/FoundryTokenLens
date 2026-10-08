import { LocalizedLabel } from '../../../components/LocalizedLabel';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, CalendarDays, Coins, Plus, Undo2 } from 'lucide-react';
import { now, parseAbsolute, toTimeZone } from '@internationalized/date';
import type { PriceItem, PriceVersion } from '../../../../shared/settings';
import type { PriceModelIdentity } from '../../../../shared/pricing';
import { modelIdKey } from '../../../../shared/price-identity';
import {
  formPrices,
  emptyPrices,
  priceFields,
  PRICE_UNIT,
  priceTemplate,
  type FormPrices,
  type RetailPrefillOption,
} from '../../../../shared/price-form';
import { api } from '../../../api';
import { t, useLocale } from '../../../i18n';
import { Dialog } from '../../../components/Dialog';
import { Field, FormNotice } from '../../../components/Form';
import { SectionTitle } from '../../../components/SectionTitle';
import { useAction } from '../../../components/useAction';
import { DateTimeField } from '../../../components/date-time/DateTimeField';
import { TimeZoneField } from '../../../components/date-time/TimeZoneField';
import { RetailPrefillButton, RetailPriceOptions } from './RetailPrefillButton';
import { meterLabels, modelTitle, type ModelPrices } from './model-prices';
import { contextLabel } from '../../analytics/format';
import { DEFAULT_TIME_ZONE } from '../../../../shared/time-window';

const MIDNIGHT = { hour: 0, minute: 0, second: 0, millisecond: 0 };
const THRESHOLD = /^[1-9]\d{0,9}$/;

/** The form fields of a stored price version, with its period in `timeZone`. */
function draftFromPrice(price: PriceVersion, model: string, timeZone: string) {
  return {
    prices: formPrices(price.items, model),
    longPrices: formPrices(price.contextPricing?.longItems ?? []),
    tiered: Boolean(price.contextPricing),
    threshold: price.contextPricing?.threshold ?? '',
    unboundedFrom: price.validFrom === null,
    from: price.validFrom === null ? null : parseAbsolute(price.validFrom, timeZone),
    to: price.validTo ? parseAbsolute(price.validTo, timeZone) : null,
  };
}
type Draft = ReturnType<typeof draftFromPrice>;

export function PriceEditorDialog({
  model,
  existingModels,
  price,
  onClose,
  onSaved,
}: {
  model: ModelPrices;
  existingModels: PriceModelIdentity[];
  price?: PriceVersion;
  onClose: () => void;
  onSaved: () => void;
}) {
  const locale = useLocale();
  const [modelId, setModelId] = useState(model.name);
  const template = priceTemplate(modelId);
  const fields = priceFields(modelId);
  const [displayName, setDisplayName] = useState(model.displayName || modelTitle(model.name));
  const fromLogs = Boolean(model.fromLogs || model.scopes.length);
  const duplicateId = existingModels.some(
    (existing) =>
      modelIdKey(existing.model) === modelIdKey(modelId) &&
      (!model.name || modelIdKey(existing.model) !== modelIdKey(model.name)),
  );
  const [editing, setEditing] = useState(Boolean(price));
  const [timeZone, setTimeZone] = useState(DEFAULT_TIME_ZONE);
  const [draft, setDraft] = useState<Draft>(() => {
    if (price) return draftFromPrice(price, model.name, DEFAULT_TIME_ZONE);
    const firstSeen = model.scopes
      .map((scope) => scope.firstSeen)
      .filter((value): value is string => !!value)
      .sort()[0];
    return {
      prices: formPrices([], model.name),
      longPrices: formPrices([]),
      tiered: false,
      threshold: '',
      unboundedFrom: false,
      from: parseAbsolute(firstSeen ?? new Date().toISOString(), DEFAULT_TIME_ZONE).set(MIDNIGHT),
      to: null,
    };
  });
  const { prices, longPrices, tiered, threshold, unboundedFrom, from, to } = draft;
  const change = (fields: Partial<Draft>) => setDraft((current) => ({ ...current, ...fields }));
  const contextTiers = template === 'text' && tiered;
  const { busy, notice, setNotice, run } = useAction();
  const [fetching, setFetching] = useState(false);
  const [quotes, setQuotes] = useState<RetailPrefillOption[] | null>(null);
  const fetchButton = useRef<HTMLButtonElement>(null);
  const quoteView = useRef<HTMLElement>(null);
  const wasChoosing = useRef(false);
  useEffect(() => {
    if (quotes) quoteView.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else if (wasChoosing.current) fetchButton.current?.focus();
    wasChoosing.current = Boolean(quotes);
  }, [quotes]);

  function changeTimeZone(zone: string) {
    setTimeZone(zone);
    setDraft((current) => ({
      ...current,
      from: current.from ? toTimeZone(current.from, zone) : null,
      to: current.to ? toTimeZone(current.to, zone) : null,
    }));
  }
  function changeVersion() {
    setNotice(null);
    if (editing) {
      setEditing(false);
      change({ unboundedFrom: false, from: now(timeZone).set(MIDNIGHT), to: null });
    } else if (price) {
      setEditing(true);
      setDraft(draftFromPrice(price, modelId, timeZone));
    }
  }
  function fillPrices(option: RetailPrefillOption) {
    change({
      prices: option.prices,
      longPrices: option.longPrices ?? emptyPrices(),
      tiered: Boolean(option.longPrices),
      unboundedFrom: false,
      from: parseAbsolute(option.validFrom, timeZone),
      to: option.validTo ? parseAbsolute(option.validTo, timeZone) : null,
    });
    setQuotes(null);
    setNotice({ kind: 'success', text: 'pricing.pricesFilled' });
  }
  function toItems(values: FormPrices): PriceItem[] {
    return fields
      .filter((key) => values[key]?.trim())
      .map((key) => ({
        key,
        label: key,
        unitQuantity: PRICE_UNIT,
        unitPriceUsd: values[key]!.trim(),
      }));
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (busy || fetching) return;
    if (duplicateId) {
      setNotice({ kind: 'error', text: 'pricing.modelAlreadyExists' });
      return;
    }
    const items = toItems(prices);
    const contextPricing = contextTiers
      ? { threshold: threshold.trim(), longItems: toItems(longPrices) }
      : null;
    if (contextPricing && !contextPricing.longItems.length) {
      setNotice({ kind: 'error', text: 'pricing.enterLongPrice' });
      return;
    }
    if (contextPricing && !THRESHOLD.test(contextPricing.threshold)) {
      setNotice({ kind: 'error', text: 'pricing.invalidContextThreshold' });
      return;
    }
    if (!items.length) {
      setNotice({ kind: 'error', text: 'pricing.enterPrice' });
      return;
    }
    if (!unboundedFrom && !from) {
      setNotice({ kind: 'error', text: 'pricing.chooseStartTime' });
      return;
    }
    if (from && to && to.compare(from) <= 0) {
      setNotice({ kind: 'error', text: 'pricing.endAfterStart' });
      return;
    }
    const dates = {
      validFrom: from?.toAbsoluteString() ?? null,
      validTo: to?.toAbsoluteString() ?? null,
    };
    void run(async () => {
      await api('/api/pricing/models', {
        method: model.name ? 'PUT' : 'POST',
        body: {
          ...(model.name
            ? { originalModel: model.name, priceId: editing ? price?.id : undefined }
            : {}),
          displayName: displayName.trim(),
          price: {
            model: modelId.trim(),
            modelVersion: price?.modelVersion ?? '*',
            region: price?.region ?? '*',
            deploymentType: price?.deploymentType ?? '*',
            notes: '',
            items,
            contextPricing,
            ...dates,
          },
        },
      });
      onSaved();
    });
  }
  const boundary = THRESHOLD.test(threshold) ? Number(threshold).toLocaleString(locale) : '—';
  const title = !model.name
    ? 'pricing.addModel'
    : price && !editing
      ? 'pricing.addPriceVersion'
      : 'pricing.editPrice';
  return (
    <Dialog
      title={t(title)}
      subtitle={model.name ? t('pricing.modelIdLabel', { id: model.name }) : undefined}
      icon={Coins}
      tone="violet"
      busy={busy}
      onClose={onClose}
      className="price-editor-dialog"
      headerAction={
        quotes ? (
          <button type="button" className="button secondary" onClick={() => setQuotes(null)}>
            <ArrowLeft size={16} />
            <LocalizedLabel message="pricing.backToEditor" />
          </button>
        ) : (
          <RetailPrefillButton
            key={modelId}
            model={modelId}
            buttonRef={fetchButton}
            disabled={busy}
            onReady={setQuotes}
            onLoading={setFetching}
          />
        )
      }
    >
      <div className="price-editor-workspace">
        <form
          onSubmit={save}
          className={`price-editor-form ${quotes ? 'price-editor-inactive' : ''}`}
          inert={Boolean(quotes)}
          aria-hidden={quotes ? true : undefined}
        >
          <div className="price-dialog-body">
            {!fromLogs && (
              <div className="price-model-fields">
                <Field label="Model ID">
                  <input
                    name="model"
                    required
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={160}
                    value={modelId}
                    aria-invalid={duplicateId || undefined}
                    disabled={busy || fetching}
                    onBlur={() => {
                      if (duplicateId)
                        setNotice({ kind: 'error', text: 'pricing.modelAlreadyExists' });
                    }}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDisplayName((current) =>
                        !current || current === modelTitle(modelId.trim())
                          ? modelTitle(value.trim())
                          : current,
                      );
                      setModelId(value);
                      setNotice(null);
                    }}
                  />
                </Field>
                <Field label={<LocalizedLabel message="pricing.displayName" />}>
                  <input
                    name="displayName"
                    required
                    maxLength={120}
                    value={displayName}
                    disabled={busy || fetching}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </Field>
              </div>
            )}
            <div className="price-editor-grid">
              <section className="price-editor-section" aria-labelledby="unit-prices-heading">
                <div className="price-section-heading">
                  <SectionTitle id="unit-prices-heading" icon={Coins} tone="violet">
                    <LocalizedLabel message="pricing.unitPrices" />
                  </SectionTitle>
                  <small className="price-unit-note">
                    <LocalizedLabel message="pricing.priceUnitGlobal" />
                  </small>
                </div>
                <fieldset disabled={busy || fetching} className="price-fixed-rates">
                  {template === 'text' && (
                    <>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={tiered}
                          onChange={(event) => change({ tiered: event.target.checked })}
                        />
                        <LocalizedLabel message="pricing.contextTiers" />
                      </label>
                      {tiered && (
                        <Field label={<LocalizedLabel message="pricing.contextThreshold" />}>
                          <input
                            name="contextThreshold"
                            inputMode="numeric"
                            pattern="[1-9][0-9]{0,9}"
                            required
                            placeholder={t('pricing.inputTokens')}
                            value={threshold}
                            onChange={(event) => change({ threshold: event.target.value })}
                          />
                        </Field>
                      )}
                    </>
                  )}
                  <table className="price-rate-table">
                    {contextTiers && (
                      <colgroup>
                        <col className="price-context-column" />
                        <col span={4} />
                      </colgroup>
                    )}
                    <thead>
                      <tr>
                        {contextTiers && <td />}
                        {fields.map((key) => (
                          <th key={key} scope="col">
                            <LocalizedLabel message={meterLabels[key]} />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(contextTiers ? (['short', 'long'] as const) : (['short'] as const)).map(
                        (band) => (
                          <tr key={band}>
                            {contextTiers && (
                              <th scope="row" className="price-band-heading">
                                <LocalizedLabel message={contextLabel(band)} />
                                <small>
                                  {band === 'short' ? '≤' : '>'} {boundary} tokens
                                </small>
                              </th>
                            )}
                            {fields.map((key) => (
                              <td key={key}>
                                <div className="price-amount-control">
                                  <span aria-hidden="true">$</span>
                                  <input
                                    aria-label={`${contextTiers ? `${t(contextLabel(band))} · ` : ''}${t(meterLabels[key])}`}
                                    name={`${band}_${key}`}
                                    inputMode="decimal"
                                    pattern="(0|[1-9][0-9]*)(\.[0-9]{1,12})?"
                                    placeholder="—"
                                    value={(band === 'short' ? prices : longPrices)[key] ?? ''}
                                    onChange={(event) => {
                                      const value = event.target.value;
                                      const field = band === 'short' ? 'prices' : 'longPrices';
                                      setDraft((current) => ({
                                        ...current,
                                        [field]: { ...current[field], [key]: value },
                                      }));
                                    }}
                                  />
                                </div>
                              </td>
                            ))}
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </fieldset>
              </section>
              <section className="price-editor-section" aria-labelledby="price-period-heading">
                <div className="price-section-heading">
                  <SectionTitle id="price-period-heading" icon={CalendarDays} tone="blue">
                    <LocalizedLabel message="pricing.effectivePeriod" />
                  </SectionTitle>
                </div>
                <div className="price-period-fields">
                  <TimeZoneField
                    value={timeZone}
                    onChange={changeTimeZone}
                    disabled={busy || fetching}
                    date={from?.toDate()}
                  />
                  <DateTimeField
                    label={t('pricing.startTime')}
                    name="validFrom"
                    value={from}
                    onChange={(value) => change({ from: value, unboundedFrom: false })}
                    unbounded={{
                      label: 'pricing.noStartDate',
                      selected: unboundedFrom,
                      onSelect: () => change({ from: null, unboundedFrom: true }),
                    }}
                    timeZone={timeZone}
                    required
                    disabled={busy || fetching}
                  />
                  <DateTimeField
                    label={t('pricing.endTimeOptional')}
                    name="validTo"
                    value={to}
                    onChange={(value) => change({ to: value })}
                    timeZone={timeZone}
                    disabled={busy || fetching}
                  />
                </div>
              </section>
            </div>
          </div>
          <footer className="dialog-actions">
            {price && (
              <button
                className="text-button price-version-action"
                type="button"
                disabled={busy || fetching}
                onClick={changeVersion}
              >
                {editing ? <Plus size={16} /> : <Undo2 size={16} />}
                <LocalizedLabel
                  message={editing ? 'pricing.newVersion' : 'pricing.backToVersion'}
                />
              </button>
            )}
            <button className="button secondary" type="button" disabled={busy} onClick={onClose}>
              <LocalizedLabel message="common.cancel" />
            </button>
            <button className="button primary" type="submit" disabled={busy || fetching}>
              <LocalizedLabel message={busy ? 'common.saving' : 'pricing.savePrice'} />
            </button>
          </footer>
        </form>
        {quotes && (
          <section
            ref={quoteView}
            className="price-quote-view"
            aria-label={t('pricing.choosePrefillPrice')}
          >
            <RetailPriceOptions
              options={quotes}
              model={modelId}
              timeZone={timeZone}
              onFill={fillPrices}
            />
          </section>
        )}
      </div>
      <FormNotice notice={notice} />
    </Dialog>
  );
}

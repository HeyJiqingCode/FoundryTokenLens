import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { Copy, FileStack, Gauge, Info, ReceiptText, X } from 'lucide-react';
import { pricePerMillion } from '../../../shared/price-form';
import { t, useLocale, type DisplayMessage } from '../../i18n';
import type { RecordEvidence, RequestFact } from '../../../shared/ingestion';
import { logSourceLabels, mergeLogFields, type LogField } from '../../../shared/log-fields';
import { api, errorMessage } from '../../api';
import { FormNotice, type Notice } from '../../components/Form';
import { copyText } from '../../components/copy-text';
import { ScrollViewport } from '../../components/ScrollViewport';
import { count, latency, money, ratio } from '../analytics/format';
import { billingLabel, resourceName } from '../analytics/series';
import { ChartLegend } from '../analytics/charts';
import { Muted, StatusCode } from '../analytics/ui';
import { TitleIcon } from '../../components/Card';

const groupLabels = {
  identity: 'analytics.identityGroup',
  model: 'analytics.modelGroup',
  usage: 'analytics.usageGroup',
  time: 'analytics.timeGroup',
  response: 'analytics.responseGroup',
  other: 'analytics.otherGroup',
} as const;
type EvidenceResponse = { records: RecordEvidence[] };
type RequestDetailResponse = { request: RequestFact | null };
type Row = Pick<RequestFact, 'resourceId' | 'correlationId'> & Partial<RequestFact>;
/**
 * The call's duration split at the first and the last token: waiting for the first token,
 * generating, and wrapping up after the last one. Shown only when all three times are known.
 */
function TimeSplit({
  request,
}: {
  request: Partial<Pick<RequestFact, 'durationMs' | 'timeToFirstTokenMs' | 'timeToLastTokenMs'>>;
}) {
  const total = request.durationMs,
    first = request.timeToFirstTokenMs,
    last = request.timeToLastTokenMs;
  if (total == null || first == null || last == null) return null;
  const phases = [
    { key: 'wait', name: t('insights.firstTokenWait'), color: 'var(--teal)', ms: first },
    {
      key: 'generation',
      name: t('insights.generation'),
      color: 'var(--violet)',
      ms: Math.max(0, last - first),
    },
    {
      key: 'wrapUp',
      name: t('insights.wrapUp'),
      color: 'var(--chart-other)',
      ms: Math.max(0, total - last),
    },
  ];
  return (
    <>
      <span className="time-split-bar" aria-hidden="true">
        {phases.map((phase) =>
          phase.ms > 0 ? (
            <i key={phase.key} style={{ flexGrow: phase.ms, background: phase.color }} />
          ) : null,
        )}
      </span>
      <ChartLegend
        compact
        items={phases.map((phase) => ({ ...phase, name: `${phase.name} ${latency(phase.ms)}` }))}
      />
    </>
  );
}
/**
 * Readable field values: scalar arrays (diagnostic logs often wrap a single number in one)
 * are listed without brackets, token counts get digit grouping, and objects stay JSON.
 */
function fieldText(value: unknown, path: string): string {
  if (typeof value === 'string' && isResourcePath(path, value)) {
    const parts = value.split('/').filter(Boolean);
    return parts.length > 4
      ? `/${parts[0]}/${parts[1].slice(0, 8)}…/${parts.slice(-2).join('/')}`
      : value;
  }
  if (typeof value === 'string') return value || t('analytics.emptyString');
  if (typeof value === 'number') return /tokens$/i.test(path) ? count(value) : String(value);
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object'))
    return value.length ? value.map((item) => fieldText(item, path)).join(', ') : '—';
  return JSON.stringify(value, null, 2);
}
// Field values shorten a full ARM resource path to the start of its subscription ID and its last
// two segments; the hover title keeps the full path.
const isResourcePath = (path: string, value: string) =>
  /(^|\.)resourceId$/i.test(path) && value.startsWith('/');
/** Single-line values from several sources share one line, with their sources in the same order. */
function FieldValues({ field }: { field: LogField }) {
  const texts = field.values.map((entry) => fieldText(entry.value, field.path));
  const full = field.values.some(
    (entry) => typeof entry.value === 'string' && isResourcePath(field.path, entry.value),
  )
    ? field.values.map((entry) => String(entry.value)).join(' / ')
    : undefined;
  if (texts.every((text) => !text.includes('\n')))
    return (
      <div className="log-field-value">
        <pre title={full}>{texts.join(' / ')}</pre>
        <small>{field.values.map((entry) => entry.sources.join(' · ')).join(' / ')}</small>
      </div>
    );
  return field.values.map((entry, index) => (
    <div className="log-field-value" key={index}>
      <pre>{texts[index]}</pre>
      <small>{entry.sources.join(' · ')}</small>
    </div>
  ));
}

/**
 * Non-modal detail panel anchored to the request table body. It leaves the table header and
 * the rows to its left visible; Esc closes it unless a dialog or picker is open above it.
 * Keyed by request, so each opened request starts from a fresh state.
 */
export function RequestDrawer({
  row,
  timeZone,
  onClose,
}: {
  row: Row;
  timeZone: string;
  onClose: () => void;
}) {
  const locale = useLocale();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [detail, setDetail] = useState<RequestFact | null>(null);
  const [records, setRecords] = useState<RecordEvidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DisplayMessage | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [mode, setMode] = useState<'summary' | 'fields' | 'raw'>('summary');
  useEffect(() => {
    const abort = new AbortController();
    const q = new URLSearchParams({ resourceId: row.resourceId, correlationId: row.correlationId });
    void Promise.all([
      api<EvidenceResponse>(`/api/requests/evidence?${q}`, { signal: abort.signal }),
      api<RequestDetailResponse>(`/api/requests/detail?${q}`, { signal: abort.signal }),
    ])
      .then(([value, result]) => {
        if (!abort.signal.aborted) {
          setRecords(value.records);
          setDetail(result.request);
          setError(null);
        }
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [row.resourceId, row.correlationId]);
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (document.querySelector('dialog[open], .picker-popover')) return;
    onClose();
  });
  // Focus moves in on open and back to where it came from on close, once per request.
  useEffect(() => {
    const previous = document.activeElement;
    headingRef.current?.focus();
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const request: Row = detail ?? row;
  const items = request.cost?.items ?? [];
  const priced = items.filter((item) => item.costUsd !== null && Number(item.costUsd) > 0);
  const input = request.inputTokens == null ? null : Number(request.inputTokens);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const labels = logSourceLabels(records.map((record) => record.category));
  const fields = mergeLogFields(
    records.map((record) => ({ category: record.category, data: record.data ?? {} })),
  );
  const copy = async (text: string, copied: DisplayMessage) =>
    setNotice(await copyText(text, copied));
  return (
    <aside className="request-drawer" aria-labelledby={headingId}>
      <FormNotice error={error} />
      <FormNotice notice={notice} />
      <header className="request-drawer-head">
        <div className="request-drawer-title">
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>
            {request.model ?? request.operation ?? t('analytics.unknownModel')}
          </h2>
          <StatusCode code={request.statusConflict ? 'conflict' : (request.statusCode ?? null)} />
          {request.streamType === 'Streaming' && (
            <span className="drawer-tag">{t('insights.streaming')}</span>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={t('insights.closeDetail')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p className="request-drawer-sub">
          {request.time ? time.format(new Date(request.time)) : '—'} ·{' '}
          <span title={request.resourceId}>{resourceName(request.resourceId)}</span>
        </p>
        <div className="request-drawer-cost">
          {request.cost?.knownUsd == null ? (
            <Muted>{t('insights.notBilled')}</Muted>
          ) : (
            money(request.cost.knownUsd)
          )}
        </div>
        <p className="request-drawer-sub">
          {request.cost?.knownUsd != null
            ? priced.map((item) => `${billingLabel(item.key)} ${money(item.costUsd)}`).join(' · ')
            : request.hasUsage === false
              ? t('insights.noUsageRecord')
              : request.cost
                ? t('insights.noMatchedPrice')
                : ''}
        </p>
      </header>
      <ScrollViewport
        className="request-drawer-viewport"
        contentClassName="request-drawer-body"
        label={t('analytics.requestDetail')}
      >
        <h3>
          <TitleIcon icon={Gauge} tone="blue" />
          {t('insights.usageAndPerformance')}
        </h3>
        <dl className="drawer-metrics">
          <div>
            <dt title={t('insights.inputIncludesCache')}>{t('insights.inputTotal')}</dt>
            <dd>{input === null ? '—' : count(input)}</dd>
          </div>
          <div>
            <dt>{t('insights.cacheRead')}</dt>
            <dd>
              {request.hasUsage === false ? '—' : count(Number(request.cachedTokens ?? 0))}
              {input && request.cachedTokens != null ? (
                <small>{ratio(Number(request.cachedTokens) / input)}</small>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>{t('insights.cacheWrites')}</dt>
            <dd>
              {request.hasUsage === false ? '—' : count(Number(request.cacheWriteTokens ?? 0))}
            </dd>
          </div>
          <div>
            <dt>{t('insights.output')}</dt>
            <dd>{request.outputTokens == null ? '—' : count(Number(request.outputTokens))}</dd>
          </div>
          <div>
            <dt>{t('insights.ttft')}</dt>
            <dd>{latency(request.timeToFirstTokenMs)}</dd>
          </div>
          <div>
            <dt>{t('insights.ttlt')}</dt>
            <dd>{latency(request.timeToLastTokenMs)}</dd>
          </div>
          <div className="drawer-duration">
            <dt>{t('insights.latency')}</dt>
            <dd>
              {latency(request.durationMs)}
              <TimeSplit request={request} />
            </dd>
          </div>
        </dl>
        {!!items.length && (
          <>
            <h3>
              <TitleIcon icon={ReceiptText} tone="amber" />
              {t('insights.billing')}
            </h3>
            <table className="data-table drawer-billing">
              <thead>
                <tr>
                  <th>{t('insights.billingItem')}</th>
                  <th>{t('insights.quantity')}</th>
                  <th>{t('insights.unitPricePerMillion')}</th>
                  <th>{t('insights.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.key}>
                    <td>{billingLabel(item.key)}</td>
                    <td>
                      {item.quantity === null ? (
                        <Muted>{t('insights.notRecorded')}</Muted>
                      ) : (
                        count(Number(item.quantity))
                      )}
                    </td>
                    <td>${pricePerMillion(item.unitPriceUsd, item.unitQuantity)}</td>
                    <td>{item.costUsd === null ? <Muted /> : `$${item.costUsd}`}</td>
                  </tr>
                ))}
                <tr className="drawer-billing-total">
                  <td>{t('insights.total')}</td>
                  <td />
                  <td />
                  <td>
                    {request.cost?.knownUsd == null ? <Muted /> : `$${request.cost.knownUsd}`}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="drawer-note">{t('insights.billedInputNote')}</p>
            {items[0]?.reference && (
              <p className="drawer-note">
                {t('insights.priceSource', { reference: items[0].reference })}
              </p>
            )}
          </>
        )}
        <h3>
          <TitleIcon icon={Info} tone="slate" />
          {t('insights.requestInfo')}
        </h3>
        <dl className="drawer-fields">
          <dt>{t('insights.requestId')}</dt>
          <dd className="mono">
            {request.correlationId}
            <button
              type="button"
              className="text-button"
              onClick={() => void copy(request.correlationId, 'insights.copied')}
            >
              {t('insights.copy')}
            </button>
          </dd>
          <dt>{t('insights.filterResource')}</dt>
          <dd title={request.resourceId}>{resourceName(request.resourceId)}</dd>
          <dt>{t('insights.deploymentVersion')}</dt>
          <dd>
            {request.deployment ?? '—'} · {request.modelVersion ?? '—'}
          </dd>
          <dt>{t('insights.region')}</dt>
          <dd>{request.region ?? '—'}</dd>
          <dt>{t('insights.operation')}</dt>
          <dd className="mono">{request.operation ?? '—'}</dd>
          <dt>{t('insights.filterIp')}</dt>
          <dd className="mono">{request.callerIp ?? <Muted>{t('insights.notRecorded')}</Muted>}</dd>
        </dl>
        <h3>
          <TitleIcon icon={FileStack} tone="teal" />
          {t('insights.logSources')}
        </h3>
        <ul className="value-list">
          <li>
            {t('insights.usageLog')}
            <LinkState linked={request.hasUsage} />
          </li>
          <li>
            {t('insights.requestLog')}
            <LinkState linked={request.hasRequest} />
          </li>
          {records.flatMap((record) =>
            (record.locations ?? [record]).map((location, i) => (
              <li key={`${record.sourceKey}/${record.hash}/${i}`} className="drawer-location">
                <span className="mono" title={location.blobName}>
                  {record.sourceName ? `${record.sourceName} / ` : ''}
                  {location.container.replace(/^insights-logs-/, '')} · …
                  {location.blobName.slice(Math.max(0, location.blobName.indexOf('/y=')))}
                </span>
                <Muted>@{count(location.byteOffset)}</Muted>
              </li>
            )),
          )}
        </ul>
        <div className="drawer-actions">
          <button
            type="button"
            className="button secondary toolbar-button"
            aria-pressed={mode === 'fields'}
            disabled={loading || !records.length}
            onClick={() => setMode(mode === 'fields' ? 'summary' : 'fields')}
          >
            {mode === 'fields' ? t('insights.hideFields') : t('analytics.fields')}
          </button>
          <button
            type="button"
            className="button secondary toolbar-button"
            aria-pressed={mode === 'raw'}
            disabled={loading || !records.length}
            onClick={() => setMode(mode === 'raw' ? 'summary' : 'raw')}
          >
            {mode === 'raw' ? t('insights.hideFields') : t('analytics.rawRecords')}
          </button>
          <button
            type="button"
            className="button secondary toolbar-button"
            disabled={!records.length}
            onClick={() =>
              void copy(
                records
                  .flatMap((record) =>
                    Array.from(
                      { length: record.locations?.length ?? 1 },
                      () => record.raw ?? JSON.stringify(record.data),
                    ),
                  )
                  .join('\n'),
                'analytics.jsonCopied',
              )
            }
          >
            <Copy size={14} aria-hidden="true" />
            {t('analytics.copyJson')}
          </button>
        </div>
        {loading && <p className="drawer-note">{t('analytics.loadingEvidence')}</p>}
        {!loading && !records.length && <p className="drawer-note">{t('analytics.noEvidence')}</p>}
        {mode === 'raw' &&
          records.map((record, i) => (
            <section className="raw-log-record" key={`${record.sourceKey}/${record.hash}`}>
              <h4>{labels[i]}</h4>
              <pre>{record.raw ?? JSON.stringify(record.data, null, 2)}</pre>
            </section>
          ))}
        {mode === 'fields' &&
          Object.entries(groupLabels).map(([group, label]) => {
            const list = fields.filter((field) => field.group === group);
            return list.length ? (
              <section className="log-field-group" key={group}>
                <h4>{t(label)}</h4>
                <dl>
                  {list.map((field) => (
                    <div
                      className={`log-field ${field.values.length > 1 ? 'has-conflict' : ''}`}
                      key={field.path}
                    >
                      <dt>{field.path}</dt>
                      <dd>
                        <FieldValues field={field} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null;
          })}
      </ScrollViewport>
    </aside>
  );
}

function LinkState({ linked }: { linked: boolean | undefined }) {
  if (linked === undefined) return <Muted />;
  return (
    <span className={`status-code ${linked ? 'ok' : 'warn'}`}>
      {linked ? t('insights.linked') : t('insights.missing')}
    </span>
  );
}

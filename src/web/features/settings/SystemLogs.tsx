import { useEffect, useState } from 'react';
import { FileText, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { CleanupResult, LogPolicy, SystemLogPage } from '../../../shared/platform';
import { api, errorMessage } from '../../api';
import { FormNotice, type Notice } from '../../components/Form';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FilterSelect } from '../../components/FilterSelect';
import { Pager } from '../../components/Pager';
import { ScrollViewport } from '../../components/ScrollViewport';
import { Pill } from '../../components/Pill';
import { t, useLocale, systemMessage, type MessageKey } from '../../i18n';
import {
  LOG_CATEGORY_LABELS,
  LOG_LEVEL_LABELS,
  LOG_LEVEL_TONES,
  logActionLabel,
  logStatusLabel,
} from './log-labels';
import { LogPolicyDialog } from './LogPolicyDialog';

const PAGE_SIZE = 50;
const filterOptions = (labels: Record<string, MessageKey>) =>
  Object.entries(labels).map(([id, key]) => ({ id, label: t(key) }));
export function SystemLogs({
  canRead,
  revision,
  onChanged,
}: {
  canRead: boolean;
  /** Raised by the parent after `onChanged`, which reloads the page. */
  revision: number;
  onChanged: () => void;
}) {
  const locale = useLocale();
  const [policy, setPolicy] = useState<LogPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [data, setData] = useState<SystemLogPage>({ logs: [], total: 0 });
  const [category, setCategory] = useState('');
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => {
    if (!canRead) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (category) params.set('category', category);
      if (level) params.set('level', level);
      if (search) params.set('search', search);
      void api<SystemLogPage>(`/api/platform/logs?${params}`, { signal: abort.signal })
        .then((value) => {
          if (!abort.signal.aborted) {
            setData(value);
            setNotice(null);
          }
        })
        .catch((error) => {
          if (!abort.signal.aborted) setNotice({ kind: 'error', text: errorMessage(error) });
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [category, level, search, offset, revision, canRead]);
  return (
    <Card
      title={t('platform.systemLogs')}
      icon={FileText}
      tone="violet"
      actions={
        canRead && (
          <>
            <button
              type="button"
              className="button secondary destructive toolbar-button"
              onClick={() => setClearing(true)}
            >
              <Trash2 size={14} />
              {t('platform.clearSystemLogs')}
            </button>
            <button
              type="button"
              className="button secondary toolbar-button"
              disabled={policyLoading}
              onClick={async () => {
                setPolicyLoading(true);
                try {
                  setPolicy(await api<LogPolicy>('/api/platform/log-policy'));
                } catch (error) {
                  setNotice({ kind: 'error', text: errorMessage(error) });
                } finally {
                  setPolicyLoading(false);
                }
              }}
            >
              <SlidersHorizontal size={14} />
              {t('platform.logPolicy')}
            </button>
          </>
        )
      }
    >
      {canRead ? (
        <>
          <div className="card-toolbar">
            <FilterSelect
              label={t('platform.logCategory')}
              value={category}
              allLabel={t('platform.allLogs')}
              options={filterOptions(LOG_CATEGORY_LABELS)}
              onChange={(value) => {
                setCategory(value);
                setOffset(0);
              }}
            />
            <FilterSelect
              label={t('platform.logLevel')}
              value={level}
              allLabel={t('platform.allLevels')}
              options={filterOptions(LOG_LEVEL_LABELS)}
              onChange={(value) => {
                setLevel(value);
                setOffset(0);
              }}
            />
            <label className="search-box">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                value={search}
                placeholder={t('platform.searchLogs')}
                aria-label={t('platform.searchLogs')}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
          </div>
          <ScrollViewport
            className="table-viewport system-log-viewport"
            label={t('platform.systemLogs')}
            showScrollbar={false}
          >
            <table className="data-table records system-log-table" aria-busy={loading}>
              <thead>
                <tr>
                  {(
                    [
                      'common.time',
                      'platform.logCategory',
                      'platform.logLevel',
                      'platform.logAction',
                      'platform.logSubject',
                      'platform.logActor',
                      'common.status',
                      'platform.logDetails',
                    ] as const
                  ).map((key) => (
                    <th key={key}>{t(key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.logs.map((log) => (
                  <tr key={log.id}>
                    <td>{new Date(log.time).toLocaleString(locale, { hour12: false })}</td>
                    <td>{t(LOG_CATEGORY_LABELS[log.category])}</td>
                    <td>
                      <Pill capsule tone={LOG_LEVEL_TONES[log.level]}>
                        {t(LOG_LEVEL_LABELS[log.level])}
                      </Pill>
                    </td>
                    <td>{logActionLabel(log.action)}</td>
                    <td>{log.subject || '—'}</td>
                    <td>{log.actor || '—'}</td>
                    <td>{logStatusLabel(log.status)}</td>
                    <td>
                      {log.details ? (
                        <span className="log-details" title={systemMessage(log.details)}>
                          {systemMessage(log.details)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.logs.length && (
              <p className="card-empty">
                {t(loading ? 'common.loadingSettings' : 'platform.noLogs')}
              </p>
            )}
          </ScrollViewport>
          <Pager
            className="system-log-pager"
            summary={t('platform.logCount', { count: data.total })}
            page={Math.floor(offset / PAGE_SIZE) + 1}
            pages={Math.max(1, Math.ceil(data.total / PAGE_SIZE))}
            previousLabel={t('platform.previousLogs')}
            nextLabel={t('platform.nextLogs')}
            disabled={loading}
            onPage={(page) => setOffset((page - 1) * PAGE_SIZE)}
          />
        </>
      ) : (
        <p className="card-empty">{t('platform.logsAdminOnly')}</p>
      )}
      <FormNotice notice={notice} />
      {policy && (
        <LogPolicyDialog
          initial={policy}
          onClose={() => setPolicy(null)}
          onSaved={() => {
            setPolicy(null);
            setOffset(0);
            onChanged();
            setNotice({ kind: 'success', text: 'platform.logPolicySaved' });
          }}
        />
      )}
      {clearing && (
        <ConfirmDialog
          title={t('platform.clearSystemLogs')}
          icon={Trash2}
          message={t('platform.clearSystemLogsNotice')}
          confirmLabel={t('platform.clearSystemLogs')}
          onConfirm={async () => {
            const result = await api<CleanupResult>('/api/platform/clear-system-logs', {
              method: 'POST',
              body: { confirmation: 'clear-system-logs' },
            });
            setClearing(false);
            onChanged();
            setOffset(0);
            setNotice({
              kind: result.spaceReclaimed ? 'success' : 'error',
              text: result.spaceReclaimed
                ? 'platform.systemLogsCleared'
                : 'platform.systemLogsClearedSpacePending',
            });
          }}
          onClose={() => setClearing(false)}
        />
      )}
    </Card>
  );
}

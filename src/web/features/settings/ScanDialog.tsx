import { useState } from 'react';
import { Database, Play } from 'lucide-react';
import type { SourceSettings } from '../../../shared/settings';
import { api, errorMessage } from '../../api';
import { Dialog } from '../../components/Dialog';
import { Field, FormNotice, type Notice } from '../../components/Form';
import { t, useLocale } from '../../i18n';

export function ScanDialog({
  sources,
  onClose,
  onStarted,
}: {
  sources: SourceSettings[];
  onClose: () => void;
  onStarted: () => void;
}) {
  useLocale();
  const enabled = sources.filter((source) => source.enabled);
  const [selected, setSelected] = useState(() => enabled.map((source) => source.id));
  const [search, setSearch] = useState('');
  const filtered = enabled.filter((source) =>
    source.accountName.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const allSelected = enabled.length > 0 && enabled.every((source) => selected.includes(source.id));
  return (
    <Dialog
      title={t('schedule.selectScanSources')}
      icon={Database}
      busy={busy}
      onClose={onClose}
      autoFocusInput={false}
      headerAction={
        <button
          type="button"
          className="text-button"
          disabled={busy || !enabled.length}
          onClick={() => setSelected(allSelected ? [] : enabled.map((source) => source.id))}
        >
          {t(allSelected ? 'schedule.deselectAllSources' : 'schedule.selectAllSources')}
        </button>
      }
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !selected.length) return;
          setBusy(true);
          setNotice(null);
          try {
            await api('/api/ingestion/run', {
              method: 'POST',
              body: { mode: 'scan', sourceIds: selected },
            });
            onStarted();
          } catch (error) {
            setNotice({ kind: 'error', text: errorMessage(error) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="dialog-body" disabled={busy}>
          {enabled.length > 6 && (
            <Field label={t('schedule.searchSources')}>
              <input
                type="search"
                value={search}
                placeholder={t('schedule.sourceName')}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
          )}
          <div className="scan-source-list">
            {filtered.map((source) => (
              <label className="scan-source-option" key={source.id}>
                <Database size={18} aria-hidden="true" />
                <span title={source.accountName}>{source.accountName}</span>
                <input
                  type="checkbox"
                  checked={selected.includes(source.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, source.id]
                        : selected.filter((id) => id !== source.id),
                    )
                  }
                />
              </label>
            ))}
            {!filtered.length && (
              <p className="field-hint">
                {t(
                  enabled.length
                    ? 'schedule.noMatchingSources'
                    : 'ingestion.configureADataSourceFirst',
                )}
              </p>
            )}
          </div>
        </fieldset>
        <div className="dialog-actions">
          <span className="scan-selection-count">
            {t('schedule.selectedSources', { count: selected.length })}
          </span>
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="button primary" disabled={busy || !selected.length}>
            <Play size={16} />
            {t(busy ? 'schedule.startingScan' : 'schedule.startScan')}
          </button>
        </div>
        <FormNotice notice={notice} />
      </form>
    </Dialog>
  );
}

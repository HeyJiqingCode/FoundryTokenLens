import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { LOG_EVENT_TYPES, LOG_LEVELS, type LogPolicy } from '../../../shared/platform';
import { api, errorMessage } from '../../api';
import { Dialog } from '../../components/Dialog';
import { Field, FormNotice, type Notice } from '../../components/Form';
import { MultiSelect } from '../../components/MultiSelect';
import { t, useLocale } from '../../i18n';
import { LOG_EVENT_LABELS, LOG_LEVEL_LABELS } from './log-labels';
export function LogPolicyDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: LogPolicy;
  onClose: () => void;
  onSaved: () => void;
}) {
  useLocale();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  return (
    <Dialog
      title={t('platform.logPolicy')}
      icon={SlidersHorizontal}
      tone="violet"
      busy={busy}
      onClose={onClose}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          try {
            await api('/api/platform/log-policy', { method: 'PUT', body: value });
            onSaved();
          } catch (error) {
            setNotice({ kind: 'error', text: errorMessage(error) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="dialog-body" disabled={busy}>
          <div className="form-grid">
            <Field label={t('platform.logMaxSize')}>
              <input
                type="number"
                min={1}
                max={10240}
                step={1}
                required
                value={value.maxSizeMiB || ''}
                onChange={(event) => setValue({ ...value, maxSizeMiB: Number(event.target.value) })}
              />
            </Field>
            <Field label={t('platform.logRetentionDays')}>
              <input
                type="number"
                min={1}
                max={3650}
                step={1}
                required
                value={value.retentionDays || ''}
                onChange={(event) =>
                  setValue({ ...value, retentionDays: Number(event.target.value) })
                }
              />
            </Field>
            <MultiSelect
              label={t('platform.logEventTypes')}
              options={LOG_EVENT_TYPES.map((key) => ({
                value: key,
                label: t(LOG_EVENT_LABELS[key]),
              }))}
              value={value.eventTypes}
              onChange={(eventTypes) => setValue({ ...value, eventTypes })}
              disabled={busy}
              placeholder={t('platform.noRecording')}
            />
            <MultiSelect
              label={t('platform.logLevels')}
              options={LOG_LEVELS.map((key) => ({ value: key, label: t(LOG_LEVEL_LABELS[key]) }))}
              value={value.levels}
              onChange={(levels) => setValue({ ...value, levels })}
              disabled={busy}
              placeholder={t('platform.noRecording')}
            />
          </div>
          <p className="field-hint">{t('platform.logPolicyHint')}</p>
        </fieldset>
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {t(busy ? 'common.saving' : 'platform.savePolicy')}
          </button>
        </div>
        <FormNotice notice={notice} />
      </form>
    </Dialog>
  );
}

import { useState } from 'react';
import { Database, Trash2 } from 'lucide-react';
import type { IngestionStatus } from '../../../shared/ingestion';
import type { CleanupResult, SystemData } from '../../../shared/platform';
import { api } from '../../api';
import { t, useLocale } from '../../i18n';
import { Kpi, KpiStrip } from '../../components/Kpi';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FormNotice, type Notice } from '../../components/Form';
import { useApiResource } from '../../components/useApiResource';
import { SystemLogs } from './SystemLogs';
import { bytes } from '../analytics/format';

export function PlatformSettings({
  ingestion,
  canEdit,
  onImportChanged,
}: {
  ingestion: IngestionStatus | null;
  canEdit: boolean;
  onImportChanged: () => void;
}) {
  useLocale();
  const [revision, setRevision] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // Sizes change when an import finishes.
  const { data, error } = useApiResource<SystemData>(
    '/api/platform/system-data',
    `${revision}/${ingestion?.runs[0]?.finishedAt}`,
  );
  return (
    <>
      <KpiStrip
        label={t('platform.systemData')}
        icon={Database}
        tone="teal"
        actions={
          canEdit && (
            <button
              type="button"
              className="button secondary destructive toolbar-button"
              onClick={() => setClearing(true)}
            >
              <Trash2 size={14} />
              {t('platform.clearLogData')}
            </button>
          )
        }
      >
        <Kpi
          label={t('platform.databaseSize')}
          value={bytes(data?.databaseBytes)}
          sub={t('platform.sqliteHint')}
        />
        <Kpi
          label={t('platform.monitoringData')}
          value={bytes(data?.logBytes)}
          sub={t('platform.monitoringHint', { count: data?.records ?? '—' })}
        />
        <Kpi
          label={t('platform.otherData')}
          value={bytes(data?.otherBytes)}
          sub={t('platform.platformDataHint')}
        />
        <Kpi
          label={t('platform.systemLogs')}
          value={bytes(data?.systemLogBytes)}
          sub={t('platform.systemLogHint')}
        />
      </KpiStrip>
      <FormNotice error={error} />
      <FormNotice notice={notice} />
      <SystemLogs
        canRead={canEdit}
        revision={revision}
        onChanged={() => setRevision((value) => value + 1)}
      />
      {clearing && (
        <ConfirmDialog
          title={t('platform.clearLogData')}
          icon={Trash2}
          message={t('platform.clearLogNotice')}
          confirmation={{
            label: t('platform.typeDelete'),
            expected: 'DELETE',
            caseSensitive: true,
          }}
          confirmLabel={t('platform.clearLogData')}
          onConfirm={async () => {
            const result = await api<CleanupResult>('/api/platform/clear-log-data', {
              method: 'POST',
              body: { confirmation: 'clear-log-data' },
            });
            setClearing(false);
            setRevision((value) => value + 1);
            onImportChanged();
            setNotice({
              kind: result.spaceReclaimed ? 'success' : 'error',
              text: result.spaceReclaimed
                ? 'platform.logDataCleared'
                : 'platform.logDataClearedSpacePending',
            });
          }}
          onClose={() => setClearing(false)}
        />
      )}
    </>
  );
}

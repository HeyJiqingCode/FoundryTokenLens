import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { SourceStatistics } from '../../../shared/source-statistics';
import { api, errorMessage } from '../../api';
import { FormNotice, type Notice } from '../../components/Form';
import { t, useLocale } from '../../i18n';
import { bytes } from '../analytics/format';

export function SourceVolume({ id, revision }: { id: string; revision: string }) {
  const locale = useLocale();
  const [volume, setVolume] = useState<SourceStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const path = `/api/settings/sources/${encodeURIComponent(id)}/statistics`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setNotice(null);
    void api<{ statistics: SourceStatistics | null }>(path, { signal: controller.signal })
      .then(({ statistics }) => {
        if (!controller.signal.aborted) setVolume(statistics);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setNotice({ kind: 'error', text: errorMessage(error) });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  async function refresh() {
    setRefreshing(true);
    setNotice(null);
    try {
      const { statistics } = await api<{ statistics: SourceStatistics }>(`${path}/refresh`, {
        method: 'POST',
      });
      setVolume(statistics);
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <div className="source-volume">
      <small>
        {volume
          ? t('sources.volumeSummary', { count: volume.files, size: bytes(volume.bytes) })
          : loading
            ? t('sources.loadingStatistics')
            : t('sources.volumeSummary', { count: '—', size: '—' })}
      </small>
      <button
        type="button"
        className="icon-button source-volume-refresh"
        disabled={loading || refreshing}
        aria-label={t('sources.refreshStatistics')}
        aria-busy={refreshing}
        title={
          volume
            ? t('sources.statisticsUpdatedAt', {
                time: new Date(volume.checkedAt).toLocaleString(locale),
              })
            : t('sources.refreshStatistics')
        }
        onClick={() => void refresh()}
      >
        <RefreshCw size={13} aria-hidden="true" />
      </button>
      <FormNotice notice={notice} />
    </div>
  );
}

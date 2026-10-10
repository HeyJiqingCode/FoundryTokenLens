import { useRef, useState } from 'react';
import { Database, Plus } from 'lucide-react';
import type { SourceSettings as SourceValue } from '../../../shared/settings';
import { api } from '../../api';
import { LocalizedLabel } from '../../components/LocalizedLabel';
import { Card } from '../../components/Card';
import { TypedDeleteDialog } from '../../components/ConfirmDialog';
import { FormNotice, type Notice } from '../../components/Form';
import { t, useLocale, type DisplayMessage } from '../../i18n';
import { SourceEditorDialog } from './SourceEditorDialog';
import { SourceVolume } from './SourceVolume';
import { CardLoading, EmptyState, EnabledPill, RowActions } from './settings-table';

export function SourceSettings({
  sources,
  loading,
  error,
  onChanged,
}: {
  sources: SourceValue[];
  loading: boolean;
  error: DisplayMessage | null;
  onChanged: () => void;
}) {
  useLocale();
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<SourceValue | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<SourceValue | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Card
        title={<LocalizedLabel message="sources.blobStorage" />}
        icon={Database}
        tone="blue"
        actions={
          <button
            ref={addButton}
            type="button"
            className="button secondary toolbar-button"
            aria-haspopup="dialog"
            onClick={() => setEditing(null)}
          >
            <Plus size={14} /> <LocalizedLabel message="sources.addSource" />
          </button>
        }
      >
        <FormNotice error={error} />
        <FormNotice notice={notice} />
        {!loading && sources.length === 0 ? (
          <EmptyState title="sources.noSources" hint="sources.noSourcesHint" />
        ) : (
          <table className="data-table list" aria-busy={loading}>
            <thead>
              <tr>
                <th>
                  <LocalizedLabel message="sources.blobStorage" />
                </th>
                <th>
                  <LocalizedLabel message="sources.authMethod" />
                </th>
                <th>
                  <LocalizedLabel message="common.status" />
                </th>
                <th>
                  <LocalizedLabel message="common.actions" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>
                    <div className="member-identity">
                      <span className="member-avatar tone-blue" aria-hidden="true">
                        <Database size={15} />
                      </span>
                      <div>
                        <strong>{source.accountName}</strong>
                        <SourceVolume id={source.id} revision={source.updatedAt} />
                      </div>
                    </div>
                  </td>
                  <td>
                    {source.authMode === 'managed_identity'
                      ? 'Managed identity'
                      : 'Connection string'}
                  </td>
                  <td>
                    <EnabledPill enabled={source.enabled} />
                  </td>
                  <td>
                    <RowActions
                      edit={{ label: t('sources.editSource'), onClick: () => setEditing(source) }}
                      remove={{
                        label: t('sources.deleteSource'),
                        onClick: () => setDeleting(source),
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {loading && <CardLoading />}
      </Card>
      {editing !== undefined && (
        <SourceEditorDialog
          key={editing?.id ?? 'new'}
          source={editing ?? undefined}
          onClose={() => setEditing(undefined)}
          onStateChanged={(source) => {
            setEditing(source);
            onChanged();
          }}
          onSaved={() => {
            setEditing(undefined);
            setNotice({ kind: 'success', text: 'sources.saved' });
            onChanged();
          }}
        />
      )}
      {deleting && (
        <TypedDeleteDialog
          title={t('sources.deleteSource')}
          subtitle={deleting.accountName}
          message={<LocalizedLabel message="sources.deleteNotice" />}
          copy={{ label: t('auth.copyDisplayName'), copied: 'sources.accountNameCopied' }}
          confirmation={{
            label: <LocalizedLabel message="sources.confirmName" />,
            expected: deleting.accountName,
          }}
          confirmLabel={<LocalizedLabel message="sources.deleteSource" />}
          onConfirm={async (confirmation) => {
            await api(`/api/settings/sources/${encodeURIComponent(deleting.id)}`, {
              method: 'DELETE',
              body: { confirmation },
            });
            setDeleting(null);
            setNotice({ kind: 'success', text: 'sources.sourceDeleted' });
            onChanged();
            window.requestAnimationFrame(() => addButton.current?.focus());
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

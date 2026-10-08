import { lazy, Suspense, useState } from 'react';
import { Clock3, Plus, RotateCcw, Play, Trash2 } from 'lucide-react';
import { TASK_LABELS, type ScheduledTask } from '../../../shared/scheduled-tasks';
import type { IngestionStatus } from '../../../shared/ingestion';
import type { SourceSettings } from '../../../shared/settings';
import { api } from '../../api';
import { t, useLocale } from '../../i18n';
import { LocalizedLabel } from '../../components/LocalizedLabel';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { FormNotice, type Notice } from '../../components/Form';
import { useApiResource } from '../../components/useApiResource';
import { count, hourLabel } from '../analytics/format';
import { ScanDialog } from './ScanDialog';
import { CardLoading, EmptyState, EnabledPill, RowActions } from './settings-table';
const TaskEditorDialog = lazy(() =>
  import('./TaskEditorDialog').then((module) => ({ default: module.TaskEditorDialog })),
);

export function TaskSettings({
  sources,
  revision,
  ingestion,
  onImportChanged,
}: {
  sources: SourceSettings[];
  /** Changes with the sources, which tasks link to. */
  revision: number;
  ingestion: IngestionStatus | null;
  onImportChanged: () => void;
}) {
  useLocale();
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useApiResource<{ tasks: ScheduledTask[] }>(
    '/api/settings/tasks',
    `${revision}/${version}`,
  );
  const tasks = data?.tasks ?? [];
  const [editing, setEditing] = useState<ScheduledTask | null | undefined>();
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null);
  const [resetting, setResetting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const changed = () => setVersion((value) => value + 1);
  const taskName = (task: ScheduledTask) =>
    task.name === 'schedule.defaultTask' ? t(TASK_LABELS[task.type]) : task.name;
  return (
    <>
      <Card
        title={<LocalizedLabel message="schedule.tasks" />}
        icon={Clock3}
        tone="violet"
        actions={
          <>
            <button
              type="button"
              className="button secondary destructive toolbar-button"
              onClick={() => setResetting(true)}
            >
              <RotateCcw size={14} />
              <LocalizedLabel message="schedule.resetHistory" />
            </button>
            <button
              type="button"
              className="button secondary toolbar-button"
              disabled={loading || !sources.some((source) => source.enabled) || ingestion?.running}
              aria-haspopup="dialog"
              onClick={() => setScanning(true)}
            >
              <Play size={14} />
              <LocalizedLabel message="schedule.scanNow" />
            </button>
            <button
              type="button"
              className="button secondary toolbar-button"
              onClick={() => setEditing(null)}
            >
              <Plus size={14} />
              <LocalizedLabel message="schedule.addTask" />
            </button>
          </>
        }
      >
        {!loading && tasks.length === 0 ? (
          <EmptyState title="schedule.noTasks" hint="schedule.noTasksHint" />
        ) : (
          <table className="data-table list" aria-busy={loading}>
            <thead>
              <tr>
                {(
                  [
                    'schedule.taskName',
                    'schedule.taskType',
                    'schedule.executionRule',
                    'schedule.linkedSources',
                    'schedule.executionCount',
                    'common.status',
                    'common.actions',
                  ] as const
                ).map((key) => (
                  <th key={key}>
                    <LocalizedLabel message={key} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <div className="member-identity">
                      <span className="member-avatar tone-violet" aria-hidden="true">
                        <Clock3 size={15} />
                      </span>
                      <div>
                        <strong>{taskName(task)}</strong>
                        <small>{task.timezone}</small>
                      </div>
                    </div>
                  </td>
                  <td>{t(TASK_LABELS[task.type])}</td>
                  <td>
                    {task.type === 'review' ? (
                      <div className="task-rule-line">
                        <strong>{hourLabel(task.hour)}</strong>
                        <span> · {t('schedule.everyDays', { count: task.frequencyDays })}</span>
                      </div>
                    ) : (
                      <>
                        <div className="task-rule-line">
                          <strong>
                            {t('schedule.dayPeriod')} {task.daytime.startTime} —{' '}
                            {task.daytime.endTime}
                          </strong>
                          <span>
                            {' '}
                            · {t('schedule.everyMinutes', { count: task.daytime.intervalMinutes })}
                          </span>
                        </div>
                        <div className="task-rule-line">
                          <strong>
                            {t('schedule.nightPeriod')} {task.daytime.endTime} —{' '}
                            {task.daytime.startTime}
                          </strong>
                          <span>
                            {' '}
                            ·{' '}
                            {t('schedule.everyHours', {
                              count: task.nighttime.intervalMinutes / 60,
                            })}
                          </span>
                        </div>
                      </>
                    )}
                  </td>
                  <td>
                    <div className="task-linked-sources">
                      {task.sourceIds.length
                        ? task.sourceIds.map((id) => (
                            <span key={id}>
                              {sources.find((s) => s.id === id)?.accountName ?? '—'}
                            </span>
                          ))
                        : '—'}
                    </div>
                  </td>
                  <td>{count(task.executionCount ?? 0)}</td>
                  <td>
                    <EnabledPill enabled={task.enabled} />
                  </td>
                  <td>
                    <RowActions
                      edit={{ label: t('schedule.editTask'), onClick: () => setEditing(task) }}
                      remove={{ label: t('schedule.deleteTask'), onClick: () => setDeleting(task) }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {loading && <CardLoading />}
        <FormNotice error={error} />
        <FormNotice notice={notice} />
      </Card>
      {scanning && (
        <ScanDialog
          sources={sources}
          onClose={() => setScanning(false)}
          onStarted={() => {
            setScanning(false);
            onImportChanged();
            changed();
            setNotice({ kind: 'success', text: 'schedule.scanStarted' });
          }}
        />
      )}
      {resetting && (
        <ConfirmDialog
          title={t('schedule.resetHistory')}
          icon={RotateCcw}
          message={t('schedule.resetHistoryNotice')}
          confirmLabel={<LocalizedLabel message="schedule.confirmReset" />}
          onConfirm={async () => {
            await api('/api/settings/tasks/reset-history', {
              method: 'POST',
              body: { confirmation: 'reset-task-history' },
            });
            setResetting(false);
            setNotice({ kind: 'success', text: 'schedule.historyReset' });
            changed();
          }}
          onClose={() => setResetting(false)}
        />
      )}
      {editing !== undefined && (
        <Suspense
          fallback={
            <Dialog
              title={t(editing ? 'schedule.editTask' : 'schedule.addTask')}
              busy={false}
              onClose={() => setEditing(undefined)}
            >
              <div className="price-dialog-body">{t('common.loadingSettings')}</div>
            </Dialog>
          }
        >
          <TaskEditorDialog
            task={editing ?? undefined}
            tasks={tasks}
            sources={sources}
            onStateChanged={changed}
            onClose={() => setEditing(undefined)}
            onSaved={() => {
              setEditing(undefined);
              setNotice({ kind: 'success', text: 'schedule.taskSaved' });
              changed();
            }}
          />
        </Suspense>
      )}
      {deleting && (
        <ConfirmDialog
          title={t('schedule.deleteTask')}
          subtitle={taskName(deleting)}
          icon={Trash2}
          message={t('schedule.deleteTaskNotice')}
          confirmLabel={t('schedule.deleteTask')}
          onConfirm={async () => {
            await api(`/api/settings/tasks/${encodeURIComponent(deleting.id)}`, {
              method: 'DELETE',
            });
            setDeleting(null);
            setNotice({ kind: 'success', text: 'schedule.taskDeleted' });
            changed();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

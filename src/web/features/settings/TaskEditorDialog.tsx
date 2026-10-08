import { useState } from 'react';
import { Clock3, Moon, Save, Sun } from 'lucide-react';
import {
  TASK_LABELS,
  TASK_TYPES,
  taskDefaults,
  taskConflict,
  dailyIntervalError,
  setDailyBoundary,
  type ScheduledTask,
  type ScheduledTaskInput,
  type TaskType,
} from '../../../shared/scheduled-tasks';
import type { SourceSettings } from '../../../shared/settings';
import { EnabledToggle } from '../../components/EnabledToggle';
import { SourceMultiSelect } from './SourceMultiSelect';
import { Dialog } from '../../components/Dialog';
import { Field, FormNotice } from '../../components/Form';
import { TimePickerField } from '../../components/date-time/TimePickerField';
import { TimeZoneField } from '../../components/date-time/TimeZoneField';
import { LocalizedLabel } from '../../components/LocalizedLabel';
import { useAction } from '../../components/useAction';
import { api } from '../../api';
import { t, useLocale } from '../../i18n';
import { hourLabel } from '../analytics/format';

export function TaskEditorDialog({
  task,
  tasks,
  sources,
  onClose,
  onSaved,
  onStateChanged,
}: {
  task?: ScheduledTask;
  tasks: ScheduledTask[];
  sources: SourceSettings[];
  onClose: () => void;
  onSaved: () => void;
  onStateChanged: () => void;
}) {
  useLocale();
  const [value, setValue] = useState<ScheduledTaskInput>(() => {
    if (!task) return taskDefaults('daily');
    const { id: _id, updatedAt: _updatedAt, executionCount: _count, ...input } = task;
    return {
      ...structuredClone(input),
    };
  });
  const { busy, notice, setNotice, run } = useAction();
  const [intervals, setIntervals] = useState(() => ({
    daytime: String(task?.type === 'daily' ? task.daytime.intervalMinutes : 5),
    nighttime: String(task?.type === 'daily' ? task.nighttime.intervalMinutes / 60 : 1),
  }));
  function changeType(type: TaskType) {
    setIntervals({ daytime: '5', nighttime: '1' });
    setValue({
      ...taskDefaults(type),
      name: value.name,
      enabled: value.enabled,
      timezone: value.timezone,
      sourceIds: value.sourceIds,
    });
    setNotice(null);
  }
  return (
    <Dialog
      title={t(task ? 'schedule.editTask' : 'schedule.addTask')}
      icon={Clock3}
      busy={busy}
      onClose={onClose}
      headerAction={
        <EnabledToggle
          value={value.enabled}
          disabled={busy}
          onChange={(enabled) => {
            if (!task) {
              setValue({ ...value, enabled });
              return;
            }
            void run(async () => {
              const result = await api<{ task: ScheduledTask }>(
                `/api/settings/tasks/${encodeURIComponent(task.id)}`,
                { method: 'PATCH', body: { enabled } },
              );
              setValue((current) => ({ ...current, enabled: result.task.enabled }));
              onStateChanged();
              return {
                kind: 'success',
                text: enabled ? 'schedule.taskEnabled' : 'schedule.taskDisabled',
              };
            });
          }}
        />
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const submitted =
            value.type === 'daily'
              ? {
                  ...value,
                  daytime: { ...value.daytime, intervalMinutes: Number(intervals.daytime) },
                  nighttime: { intervalMinutes: Number(intervals.nighttime) * 60 },
                }
              : value;
          const validation =
            taskConflict(submitted, tasks, task?.id) ??
            dailyIntervalError(submitted) ??
            (value.type === 'daily' && value.daytime.startTime === value.daytime.endTime
              ? 'schedule.timeRangeInvalid'
              : value.enabled && !value.sourceIds.length
                ? 'schedule.selectSource'
                : null);
          if (validation) {
            setNotice({ kind: 'error', text: validation });
            return;
          }
          void run(async () => {
            await api(
              task ? `/api/settings/tasks/${encodeURIComponent(task.id)}` : '/api/settings/tasks',
              { method: task ? 'PUT' : 'POST', body: submitted },
            );
            onSaved();
          });
        }}
      >
        <fieldset disabled={busy}>
          <div className="task-editor-body">
            <div className="task-editor-meta">
              <Field label={t('schedule.taskName')}>
                <input
                  name="taskName"
                  required
                  maxLength={100}
                  value={
                    value.name === 'schedule.defaultTask' ? t(TASK_LABELS[value.type]) : value.name
                  }
                  onChange={(e) => setValue({ ...value, name: e.target.value })}
                />
              </Field>
              <Field label={t('schedule.taskType')}>
                <select
                  name="taskType"
                  value={value.type}
                  onChange={(e) => changeType(e.target.value as TaskType)}
                >
                  {TASK_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(TASK_LABELS[type])}
                    </option>
                  ))}
                </select>
              </Field>
              <TimeZoneField
                value={value.timezone}
                onChange={(timezone) => setValue({ ...value, timezone })}
                disabled={busy}
              />
              <SourceMultiSelect
                sources={sources}
                value={value.sourceIds}
                disabled={busy}
                onChange={(sourceIds) => setValue({ ...value, sourceIds })}
              />
            </div>
            <div className="task-editor-timing">
              {value.type === 'review' ? (
                <div className="form-grid">
                  <Field label={t('schedule.reconciliationHour')}>
                    <select
                      name="reviewHour"
                      value={value.hour}
                      onChange={(e) => setValue({ ...value, hour: Number(e.target.value) })}
                    >
                      {Array.from({ length: 24 }, (_, hour) => (
                        <option key={hour} value={hour}>
                          {hourLabel(hour)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('schedule.reviewFrequency')}>
                    <select
                      name="reviewDays"
                      value={value.frequencyDays}
                      onChange={(e) =>
                        setValue({ ...value, frequencyDays: Number(e.target.value) })
                      }
                    >
                      {Array.from({ length: 7 }, (_, i) => (
                        <option key={i} value={i + 1}>
                          {t('common.dayCount', { count: i + 1 })}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : (
                <div className="task-daily-periods">
                  {(['daytime', 'nighttime'] as const).map((period) => (
                    <section className="task-period" key={period}>
                      <h4 className={period === 'daytime' ? 'task-day-label' : 'task-night-label'}>
                        {period === 'daytime' ? <Sun size={16} /> : <Moon size={16} />}
                        <LocalizedLabel
                          message={
                            period === 'daytime' ? 'schedule.dayPeriod' : 'schedule.nightPeriod'
                          }
                        />
                      </h4>
                      <div className="task-fields-three">
                        <TimePickerField
                          label={t('common.startTime')}
                          name={`${period}Start`}
                          value={
                            period === 'daytime' ? value.daytime.startTime : value.daytime.endTime
                          }
                          disabled={busy}
                          onChange={(time) =>
                            setValue(setDailyBoundary(value, period, 'startTime', time))
                          }
                        />
                        <TimePickerField
                          label={t('common.endTime')}
                          name={`${period}End`}
                          value={
                            period === 'daytime' ? value.daytime.endTime : value.daytime.startTime
                          }
                          disabled={busy}
                          onChange={(time) =>
                            setValue(setDailyBoundary(value, period, 'endTime', time))
                          }
                        />
                        <Field
                          label={t(
                            period === 'daytime'
                              ? 'schedule.intervalMinutes'
                              : 'schedule.intervalHours',
                          )}
                        >
                          <input
                            type="number"
                            name={`${period}Interval`}
                            required
                            min={period === 'daytime' ? 1 : 1 / 60}
                            step={period === 'daytime' ? 1 : 'any'}
                            max={period === 'daytime' ? 1440 : 24}
                            value={intervals[period]}
                            onChange={(event) =>
                              setIntervals({ ...intervals, [period]: event.target.value })
                            }
                          />
                        </Field>
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </div>
          <footer className="dialog-actions">
            <button type="button" className="button secondary" onClick={onClose}>
              <LocalizedLabel message="common.cancel" />
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              <Save size={16} />
              <LocalizedLabel message={busy ? 'common.saving' : 'schedule.saveTask'} />
            </button>
          </footer>
        </fieldset>
        <FormNotice notice={notice} />
      </form>
    </Dialog>
  );
}

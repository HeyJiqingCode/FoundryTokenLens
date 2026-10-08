import { DEFAULT_TIME_ZONE } from './time-window.js';

export const TASK_TYPES = ['daily', 'review'] as const;
export type TaskType = (typeof TASK_TYPES)[number];
interface TaskBase {
  name: string;
  enabled: boolean;
  sourceIds: string[];
  timezone: string;
}
export type DailyTaskInput = TaskBase & {
  type: 'daily';
  daytime: { startTime: string; endTime: string; intervalMinutes: number };
  nighttime: { intervalMinutes: number };
};
export type ScheduledTaskInput =
  DailyTaskInput | (TaskBase & { type: 'review'; hour: number; frequencyDays: number });
export type ScheduledTask = ScheduledTaskInput & {
  id: string;
  updatedAt: string;
  executionCount?: number;
};
export const TASK_LABELS = { daily: 'schedule.dailyTask', review: 'schedule.reviewTask' } as const;
export function taskDefaults<T extends TaskType>(
  type: T,
): Extract<ScheduledTaskInput, { type: T }> {
  const base = { name: '', enabled: true, sourceIds: [], timezone: DEFAULT_TIME_ZONE };
  const task: ScheduledTaskInput =
    type === 'review'
      ? { ...base, type, hour: 6, frequencyDays: 1 }
      : {
          ...base,
          type: 'daily',
          daytime: { startTime: '06:00', endTime: '22:00', intervalMinutes: 5 },
          nighttime: { intervalMinutes: 60 },
        };
  return task as Extract<ScheduledTaskInput, { type: T }>;
}
export function taskConflict(input: ScheduledTaskInput, tasks: ScheduledTask[], id?: string) {
  return input.enabled &&
    tasks.some(
      (task) =>
        task.id !== id &&
        task.enabled &&
        task.type === input.type &&
        task.sourceIds.some((source) => input.sourceIds.includes(source)),
    )
    ? 'schedule.sameTypeConflict'
    : null;
}
export function setDailyBoundary(
  task: DailyTaskInput,
  period: 'daytime' | 'nighttime',
  boundary: 'startTime' | 'endTime',
  value: string,
): DailyTaskInput {
  const key = period === 'daytime' ? boundary : boundary === 'startTime' ? 'endTime' : 'startTime';
  return { ...task, daytime: { ...task.daytime, [key]: value } };
}

export function dailyIntervalError(task: ScheduledTaskInput) {
  if (task.type !== 'daily') return null;
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const duration = (minutes(task.daytime.endTime) - minutes(task.daytime.startTime) + 1440) % 1440;
  if (!duration) return 'schedule.timeRangeInvalid';
  if (
    duration % task.daytime.intervalMinutes !== 0 ||
    (1440 - duration) % task.nighttime.intervalMinutes !== 0
  )
    return 'schedule.intervalDoesNotFit';
  return null;
}

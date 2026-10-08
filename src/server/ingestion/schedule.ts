const formatters = new Map<string, Intl.DateTimeFormat>();
function localClock(now: Date, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}
const minuteOfDay = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// Only a planned wall-clock minute may start a scheduled scan. Configuration
// revisions are deliberately absent from the identity of a scheduled occurrence.
export function dueTaskSlot(
  task: import('../../shared/scheduled-tasks.js').ScheduledTask,
  now: Date,
  completedAt: string | null = null,
): string | null {
  if (!task.enabled) return null;
  const clock = localClock(now, task.timezone);
  const minute = Math.floor(now.getTime() / 60000) * 60000;
  const updated = Date.parse(task.updatedAt);
  if (updated > minute && updated <= now.getTime()) return null;
  if (task.type === 'review') {
    if (clock.minute !== task.hour * 60) return null;
    const previous = completedAt ? localClock(new Date(completedAt), task.timezone).date : null;
    if (previous && (Date.parse(clock.date) - Date.parse(previous)) / 86400000 < task.frequencyDays)
      return null;
    return `${task.id}/${task.timezone}/${clock.date}/review/${task.hour}`;
  }
  const start = minuteOfDay(task.daytime.startTime),
    end = minuteOfDay(task.daytime.endTime);
  const daytime =
    start < end
      ? clock.minute >= start && clock.minute < end
      : clock.minute >= start || clock.minute < end;
  const anchor = daytime ? start : end;
  const interval = daytime ? task.daytime.intervalMinutes : task.nighttime.intervalMinutes;
  const elapsed = (clock.minute - anchor + 1440) % 1440;
  if (elapsed % interval !== 0) return null;
  return `${task.id}/${task.timezone}/${clock.date}/${daytime ? 'day' : 'night'}/${clock.minute}`;
}

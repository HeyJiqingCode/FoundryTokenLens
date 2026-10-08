export interface LogField {
  path: string;
  group: 'identity' | 'model' | 'usage' | 'time' | 'response' | 'other';
  values: { value: unknown; sources: string[] }[];
}
export function logSourceLabels(categories: string[]) {
  const counts = new Map<string, number>();
  return categories.map((category) => {
    const name = category === 'usage' ? 'Usage' : 'RequestResponse';
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    return `${name} ${count}`;
  });
}
export function mergeLogFields(
  records: { category: string; data: Record<string, unknown> }[],
): LogField[] {
  const fields = new Map<string, LogField>();
  function group(path: string): LogField['group'] {
    const key = path.split('.').at(-1)!;
    if (['resourceId', 'correlationId'].includes(key)) return 'identity';
    if (/model|deployment|operation|streamType|apiName|location/i.test(key)) return 'model';
    if (/tokens$/i.test(key)) return 'usage';
    if (/time|timestamp|duration/i.test(key)) return 'time';
    if (/result|status|length|size|caller|objectId|nwperim/i.test(key)) return 'response';
    return 'other';
  }
  const labels = logSourceLabels(records.map((record) => record.category));
  for (const [index, record] of records.entries()) {
    const source = labels[index];
    function walk(value: unknown, path: string) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length
      ) {
        for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
        return;
      }
      const entry = fields.get(path) ?? { path, group: group(path), values: [] };
      const key = JSON.stringify(value);
      const existing = entry.values.find((v) => JSON.stringify(v.value) === key);
      if (existing) existing.sources.push(source);
      else entry.values.push({ value, sources: [source] });
      fields.set(path, entry);
    }
    walk(record.data, '');
  }
  const groups = ['identity', 'model', 'usage', 'time', 'response', 'other'];
  return [...fields.values()].sort(
    (a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.path.localeCompare(b.path),
  );
}

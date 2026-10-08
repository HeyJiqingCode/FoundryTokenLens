import { createHash } from 'node:crypto';
import type { LogCategory, RequestFact } from '../../shared/ingestion.js';

type JsonObject = Record<string, unknown>;
export interface ParsedRecord {
  hash: string;
  category: LogCategory;
  resourceId: string;
  correlationId: string | null;
  time: string;
  raw: string;
  fact: RequestFact;
  inference: boolean;
  placeholder: boolean;
}

export function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
/** Imported rows are keyed by storage endpoint, not by the source's settings id. */
export const sourceKey = (source: { endpoint: string }) => hash(source.endpoint);

export function parseJson(value: string): unknown {
  return JSON.parse(value, (_key, item: unknown, context?: { source: string }) => {
    // Node 24 supplies the original numeric lexeme, before IEEE-754 rounding.
    if (typeof item === 'number' && Number.isInteger(item) && !Number.isSafeInteger(item)) {
      if (!context?.source) throw new Error('无法保留日志数值精度');
      return context.source;
    }
    return item;
  });
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
}
function scalar(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 1 ? scalar(value[0]) : undefined;
  return value;
}
function text(value: unknown): string | null {
  const item = scalar(value);
  return typeof item === 'string' && item.trim() ? item.trim() : null;
}
function numeric(value: unknown): number | null {
  const item = scalar(value);
  if (item === null || item === undefined || item === '') return null;
  const number = typeof item === 'number' || typeof item === 'string' ? Number(item) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER
    ? number
    : null;
}
export function token(value: unknown): string | null {
  const item = scalar(value);
  if (item === null || item === undefined) return null;
  if (typeof item === 'number' && (!Number.isSafeInteger(item) || item < 0)) return null;
  if (!['number', 'string'].includes(typeof item) || !/^\d+$/.test(String(item))) return null;
  const integer = BigInt(String(item));
  return integer <= 9223372036854775807n ? integer.toString() : null;
}

export function blobPath(name: string) {
  const match =
    /^(resourceId=(\/SUBSCRIPTIONS\/[^/]+\/RESOURCEGROUPS\/[^/]+\/PROVIDERS\/MICROSOFT\.COGNITIVESERVICES\/ACCOUNTS\/[^/]+))\/y=(\d{4})\/m=(\d{2})\/d=(\d{2})\/h=(\d{2})\/m=\d{2}\/PT1H\.json$/i.exec(
      name,
    );
  if (!match) return null;
  const time = `${match[3]}-${match[4]}-${match[5]}T${match[6]}:00:00.000Z`;
  if (!Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time) return null;
  return { resourceId: match[2].toLowerCase(), prefix: `${match[1]}/`, time };
}

export function parseRecord(
  line: string,
  category: LogCategory,
  pathResource: string,
): ParsedRecord[] {
  const parsed = object(parseJson(line.replace(/^\uFEFF/, '')));
  const records = Array.isArray(parsed.records) ? parsed.records : [parsed];
  if (!records.length) return [];
  return records.map((value) => normalize(object(value), category, pathResource));
}

function normalize(raw: JsonObject, category: LogCategory, pathResource: string): ParsedRecord {
  const resourceId = (text(raw.resourceId) ?? '').toLowerCase();
  if (!resourceId || resourceId !== pathResource.toLowerCase())
    throw new Error('资源标识与 Blob 路径不一致');
  const eventTime = text(raw.time) ?? text(raw.timeStamp);
  const timestamp = eventTime ?? text(raw.FluentdIngestTimestamp);
  if (
    !timestamp ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  )
    throw new Error('日志时间无效或缺少时区');
  const time = new Date(timestamp).toISOString();
  const expected = {
    usage: 'azureopenairequestusage',
    requests: 'requestresponse',
  };
  if (raw.category !== undefined && text(raw.category)?.toLowerCase() !== expected[category])
    throw new Error('日志类别与容器不一致');
  let properties = raw.properties;
  if (typeof properties === 'string') properties = parseJson(properties);
  const p = object(properties);
  const correlationId = text(raw.correlationId);
  const rawJson = JSON.stringify(raw);
  const base = {
    hash: hash(`${category}\n${rawJson}`),
    category,
    resourceId,
    correlationId,
    time,
    raw: rawJson,
  };
  if (!correlationId) throw new Error('缺少 correlationId，无法安全关联请求');
  const operation = text(raw.operationName);
  const fact: RequestFact = {
    resourceId,
    correlationId,
    time,
    timeSource: eventTime ? 'event' : 'ingestion',
    model: text(p.modelName) ?? text(p.model),
    modelVersion: text(p.modelVersion),
    deployment: text(p.modelDeploymentName) ?? text(p.deploymentName),
    region: text(raw.location) ?? text(p.region),
    deploymentType: text(p.deploymentType) ?? text(p.deploymentSku),
    operation,
    inputTokens: token(p.promptTokens ?? p.inputTokens ?? p.input_tokens),
    outputTokens: token(
      p.generatedTokens ?? p.completionTokens ?? p.outputTokens ?? p.output_tokens,
    ),
    cachedTokens: token(p.cachedTokens ?? p.cachedInputTokens),
    cacheWriteTokens: token(p.cacheWriteTokens ?? p.cache_write_tokens),
    inputTextTokens: token(p.inputTextTokens),
    inputImageTokens: token(p.inputImageTokens),
    cachedTextTokens: token(p.cachedTextTokens),
    cachedImageTokens: token(p.cachedImageTokens),
    outputImageTokens: token(p.outputImageTokens),
    durationMs: numeric(raw.durationMs) ?? numeric(p.timeToLastTokenMs),
    timeToFirstTokenMs: numeric(p.timeToFirstTokenMs),
    statusCode: numeric(raw.resultSignature) ?? numeric(p.statusCode),
    callerIp: text(raw.callerIpAddress),
    streamType: text(p.streamType),
    timeToLastTokenMs: numeric(p.timeToLastTokenMs),
    requestLength: numeric(p.requestLength),
    responseLength: numeric(p.responseLength),
    apiName: text(p.apiName),
    hasUsage: category === 'usage',
    hasRequest: category === 'requests',
  };
  const inference =
    category === 'usage' ||
    !!fact.model ||
    !!fact.deployment ||
    /(?:chat.?completions|completions|embeddings|create-response|responses|image.?generations|audio.?transcriptions)/i.test(
      operation ?? '',
    );
  return {
    ...base,
    fact,
    inference,
    placeholder:
      category === 'requests' &&
      fact.statusCode === 200 &&
      fact.durationMs === 0 &&
      fact.inputTokens === '0' &&
      fact.outputTokens === '0',
  };
}

export function mergeRequestRecords(records: ParsedRecord[]): RequestFact {
  if (!records.length) throw new Error('Request records required');
  const unique = [...new Map(records.map((record) => [record.hash, record])).values()];
  const usages = unique.filter((record) => record.category === 'usage');
  const responses = unique.filter((record) => record.category === 'requests');
  const meaningful = responses.filter((record) => !record.placeholder);
  const activeResponses = meaningful.length ? meaningful : responses;
  const conflicts: string[] = [];
  function value<T>(items: ParsedRecord[], field: keyof RequestFact): T | null {
    if (items.some((record) => record.fact.conflicts?.includes(String(field)))) {
      conflicts.push(String(field));
      return null;
    }
    const values = [
      ...new Map(
        items.flatMap((record) => {
          const v = record.fact[field];
          return v == null ? [] : [[JSON.stringify(v), v] as const];
        }),
      ).values(),
    ];
    if (values.length > 1) {
      conflicts.push(String(field));
      return null;
    }
    return (values[0] as T) ?? null;
  }
  const base = (usages[0] ?? activeResponses[0]).fact;
  const rrTimes = activeResponses
    .filter((record) => record.fact.timeSource === 'event')
    .map((record) => record.time)
    .sort();
  const usageTimes = usages
    .filter((record) => record.fact.timeSource === 'event')
    .map((record) => record.time)
    .sort();
  const eventTime = usageTimes[0] ?? rrTimes[0];
  const fact: RequestFact = {
    ...base,
    time: eventTime ?? unique.map((record) => record.time).sort()[0],
    timeSource: eventTime ? 'event' : 'ingestion',
    model: value<string>(
      usages.some((r) => r.fact.model !== null) ? usages : activeResponses,
      'model',
    ),
    modelVersion: value<string>(
      usages.some((r) => r.fact.modelVersion !== null) ? usages : activeResponses,
      'modelVersion',
    ),
    deployment: value<string>(
      usages.some((r) => r.fact.deployment !== null) ? usages : activeResponses,
      'deployment',
    ),
    region: value<string>(usages.length ? usages : activeResponses, 'region'),
    inputTokens: value<string>(usages, 'inputTokens'),
    outputTokens: value<string>(usages, 'outputTokens'),
    cachedTokens: value<string>(usages, 'cachedTokens'),
    cacheWriteTokens: value<string>(usages, 'cacheWriteTokens'),
    inputTextTokens: value<string>(usages, 'inputTextTokens'),
    inputImageTokens: value<string>(usages, 'inputImageTokens'),
    cachedTextTokens: value<string>(usages, 'cachedTextTokens'),
    cachedImageTokens: value<string>(usages, 'cachedImageTokens'),
    outputImageTokens: value<string>(usages, 'outputImageTokens'),
    durationMs: value<number>(activeResponses, 'durationMs'),
    timeToFirstTokenMs: value<number>(usages, 'timeToFirstTokenMs'),
    timeToLastTokenMs: value<number>(usages, 'timeToLastTokenMs'),
    statusCode: value<number>(activeResponses, 'statusCode'),
    callerIp: value<string>(activeResponses, 'callerIp'),
    streamType: value<string>(usages.length ? usages : activeResponses, 'streamType'),
    requestLength: value<number>(activeResponses, 'requestLength'),
    responseLength: value<number>(activeResponses, 'responseLength'),
    apiName: value<string>(activeResponses, 'apiName'),
    operation: value<string>(activeResponses.length ? activeResponses : usages, 'operation'),
    hasUsage: usages.length > 0,
    hasRequest: responses.length > 0,
    linkState: usages.length ? (responses.length ? 'linked' : 'usage_only') : 'response_only',
    requestKind: unique.some((record) => record.inference) ? 'model' : 'other',
    usageRecordCount: usages.length,
    responseRecordCount: responses.length,
    responsePlaceholder: responses.length > 0 && meaningful.length === 0,
  };
  fact.statusConflict = conflicts.includes('statusCode');
  fact.conflicts = [...new Set(conflicts)];
  return fact;
}

export function joinRequest(usage?: ParsedRecord, request?: ParsedRecord): RequestFact {
  return mergeRequestRecords(
    [
      usage ? { ...usage, category: 'usage' as const } : undefined,
      request ? { ...request, category: 'requests' as const } : undefined,
    ].filter((record): record is ParsedRecord => Boolean(record)),
  );
}

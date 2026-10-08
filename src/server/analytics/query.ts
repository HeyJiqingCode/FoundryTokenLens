import { z } from 'zod';
import { INTERVALS } from '../../shared/analytics.js';
import { COST_CONTEXTS } from '../../shared/pricing.js';
import type { AnalyticsFilters } from '../../shared/analytics.js';
import { timeZoneSchema } from '../settings/validation.js';
export const filterSchema = z
  .object({
    requestId: z.string().max(512).optional(),
    interval: z.enum(INTERVALS).optional(),
    timezone: timeZoneSchema.optional(),
    status: z
      .string()
      .regex(/^(?:ok|error|[1-5][0-9]{2}|[1-5]xx|unknown|conflict)$/)
      .optional(),
    from: z
      .string()
      .datetime({ offset: true })
      .transform((v) => new Date(v).toISOString())
      .optional(),
    to: z
      .string()
      .datetime({ offset: true })
      .transform((v) => new Date(v).toISOString())
      .optional(),
    model: z.string().max(160).optional(),
    resourceId: z.string().max(2048).optional(),
    ip: z.string().max(200).optional(),
    context: z.enum(COST_CONTEXTS).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from < v.to, 'analytics.endTimeMustBeLaterThanTheStart');
export function requestWhere(filters: AnalyticsFilters) {
  const clauses: string[] = [];
  if (!filters.includeNonModel) clauses.push('r.is_inference = 1');
  const params: (string | number)[] = [];
  if (filters.from) {
    clauses.push('r.time >= ?');
    params.push(new Date(filters.from).toISOString());
  }
  if (filters.to) {
    clauses.push('r.time < ?');
    params.push(new Date(filters.to).toISOString());
  }
  if (filters.requestId) {
    clauses.push('r.correlation_id=?');
    params.push(filters.requestId);
  }
  if (filters.model) {
    clauses.push("json_extract(r.fact_json,'$.model') = ?");
    params.push(filters.model);
  }
  if (filters.resourceId) {
    clauses.push('r.resource_id = ?');
    params.push(filters.resourceId.toLowerCase());
  }
  if (filters.ip) {
    clauses.push("json_extract(r.fact_json,'$.callerIp') = ?");
    params.push(filters.ip);
  }
  if (filters.context) {
    clauses.push("json_extract(c.result_json,'$.context') = ?");
    params.push(filters.context);
  }
  if (filters.status) {
    // 'ok' and 'error' split the calls with a known, unconflicted status exactly as the error rate does.
    if (filters.status === 'ok' || filters.status === 'error')
      clauses.push(
        `json_extract(r.fact_json,'$.hasRequest')=1 AND coalesce(json_extract(r.fact_json,'$.statusConflict'),0)=0 AND json_extract(r.fact_json,'$.statusCode') ${filters.status === 'ok' ? '<' : '>='} 400`,
      );
    else if (filters.status === 'conflict')
      clauses.push("json_extract(r.fact_json,'$.statusConflict')=1");
    else if (filters.status === 'unknown')
      clauses.push(
        "json_extract(r.fact_json,'$.statusCode') IS NULL AND coalesce(json_extract(r.fact_json,'$.statusConflict'),0)=0",
      );
    else if (filters.status.endsWith('xx')) {
      clauses.push("CAST(json_extract(r.fact_json,'$.statusCode')/100 AS INTEGER)=?");
      params.push(Number(filters.status[0]));
    } else {
      clauses.push("json_extract(r.fact_json,'$.statusCode')=?");
      params.push(Number(filters.status));
    }
  }
  if (filters.pricedModels) {
    const models = filters.pricedModels;
    clauses.push(
      models.length
        ? `(r.is_inference = 0 OR json_extract(r.fact_json,'$.model') IN (${models.map(() => '?').join(',')}))`
        : 'r.is_inference = 0',
    );
    params.push(...models);
  }
  return { sql: clauses.join(' AND ') || '1=1', params };
}
export function joinedRequests(keys: string[]) {
  const placeholders = keys.map(() => '?').join(',') || "''";
  const facts =
    keys.length <= 1
      ? `(SELECT *,1 source_count FROM request_facts WHERE source_key IN (${placeholders})) r`
      : `(SELECT merged.*,json_extract(fact_json,'$.time') time FROM (
      SELECT resource_id,correlation_id,min(source_key) source_key,max(is_inference) is_inference,
      CASE WHEN count(*)=1 THEN min(fact_json) ELSE ftl_merge_facts(json_group_array(fact_json)) END fact_json,
      count(*) source_count FROM request_facts WHERE source_key IN (${placeholders}) GROUP BY resource_id,correlation_id) merged) r`;
  return `FROM ${facts} LEFT JOIN request_costs c
    ON c.source_key=r.source_key AND c.resource_id=r.resource_id AND c.correlation_id=r.correlation_id`;
}

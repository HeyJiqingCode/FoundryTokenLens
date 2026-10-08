import type { AppDatabase } from '../database.js';
import type { SettingsRepository } from '../settings/repository.js';
import type { RequestFact } from '../../shared/ingestion.js';
import type { DetectedModel, PricingState } from '../../shared/pricing.js';
import { sourceKey } from '../ingestion/parser.js';
import { retailFamilyMatches } from '../../shared/price-identity.js';
import { HttpError } from '../http/errors.js';
import { calculateCost, scopeKey } from './engine.js';
import { prefillOptions } from './prefill.js';
import { createPriceModelManager } from './models.js';
import {
  decodeCatalog,
  fetchRetailRates,
  groupRates,
  normalizeRegion,
  type RetailFetcher,
} from './retail.js';

const BATCH_SIZE = 200;
// Fact and price changes mark costs dirty; the periodic full check is only a safety net.
const FULL_CHECK_MS = 5 * 60_000;

export function createPricingService(
  database: AppDatabase,
  settings: SettingsRepository,
  fetcher: RetailFetcher = fetchRetailRates,
) {
  const db = database.connection;
  let timer: ReturnType<typeof setInterval> | undefined;
  let next: ReturnType<typeof setImmediate> | undefined;
  let stopped = false;
  const lookups = new Map<string, Promise<ReturnType<typeof decodeCatalog>>>();
  const lookupControllers = new Set<AbortController>();
  const modelManager = createPriceModelManager(database, settings, invalidateManual);
  const insertCost = db.prepare('INSERT OR REPLACE INTO request_costs VALUES (?, ?, ?, ?, ?)');
  function sourceKeys() {
    return settings
      .getSources()
      .filter((source) => source.enabled)
      .map(sourceKey);
  }
  function detected(): DetectedModel[] {
    const keys = sourceKeys();
    if (!keys.length) return [];
    const rows = db
      .prepare(
        `SELECT source_key AS sourceKey, resource_id AS resourceId, json_extract(fact_json, '$.deployment') AS deployment,
      json_extract(fact_json, '$.model') AS model, json_extract(fact_json, '$.modelVersion') AS modelVersion,
      json_extract(fact_json, '$.region') AS region, min(time) AS firstSeen, count(*) AS requests FROM request_facts
      WHERE source_key IN (${keys.map(() => '?').join(',')}) AND is_inference = 1 AND json_extract(fact_json, '$.model') IS NOT NULL
      GROUP BY source_key, resource_id, deployment, model, modelVersion, region ORDER BY model, deployment`,
      )
      .all(...keys) as Omit<DetectedModel, 'scopeKey'>[];
    const combined = new Map<string, DetectedModel>();
    for (const row of rows) {
      const normalized = {
        ...row,
        deployment: row.deployment ?? '',
        modelVersion: row.modelVersion ?? '',
        region: normalizeRegion(row.region ?? ''),
      };
      const id = scopeKey(normalized);
      const scopedId = `${row.sourceKey}/${id}`;
      const previous = combined.get(scopedId);
      if (previous) {
        previous.requests += row.requests;
        if (row.firstSeen && (!previous.firstSeen || row.firstSeen < previous.firstSeen))
          previous.firstSeen = row.firstSeen;
        if (!previous.region) previous.region = normalized.region;
      } else combined.set(scopedId, { ...normalized, scopeKey: id });
    }
    return [...combined.values()];
  }
  function recalculate(limit = BATCH_SIZE) {
    const keys = sourceKeys();
    if (!keys.length) return 0;
    const rows = db
      .prepare(
        `SELECT r.source_key, r.resource_id, r.correlation_id, r.fact_json FROM request_facts r LEFT JOIN request_costs c
      ON c.source_key=r.source_key AND c.resource_id=r.resource_id AND c.correlation_id=r.correlation_id
      WHERE r.source_key IN (${keys.map(() => '?').join(',')}) AND r.is_inference=1 AND c.correlation_id IS NULL ORDER BY r.time DESC LIMIT ?`,
      )
      .all(...keys, limit) as {
      source_key: string;
      resource_id: string;
      correlation_id: string;
      fact_json: string;
    }[];
    if (!rows.length) return 0;
    const manual = settings.listPrices();
    db.transaction(() => {
      for (const row of rows) {
        const cost = calculateCost(JSON.parse(row.fact_json) as RequestFact, manual);
        insertCost.run(
          row.source_key,
          row.resource_id,
          row.correlation_id,
          JSON.stringify(cost),
          cost.calculatedAt,
        );
      }
    }).immediate();
    return rows.length;
  }
  async function fetchModelCatalog(model: string, regions?: string[]) {
    const selected = [
      ...new Set(
        (regions?.length
          ? regions
          : detected()
              .filter((item) => item.model.toLowerCase() === model.toLowerCase())
              .map((item) => item.region)
        )
          .map(normalizeRegion)
          .filter(Boolean),
      ),
    ].sort();
    if (!selected.length) throw new HttpError(400, 'pricing.noResourceRegionHasBeenDiscovered');
    if (selected.length > 20 || selected.some((region) => !/^[a-z0-9]{2,50}$/.test(region)))
      throw new HttpError(400, 'pricing.invalidRegionFormatOrTooManyRegionsSelected');
    const key = JSON.stringify([model.toLowerCase(), selected]);
    const existing = lookups.get(key);
    if (existing) return existing;
    const abort = new AbortController();
    lookupControllers.add(abort);
    const work = (async () => {
      try {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]);
        const rows: Record<string, unknown>[] = [];
        for (const region of selected) rows.push(...(await fetcher(region, signal)));
        signal.throwIfAborted();
        const decoded = decodeCatalog(rows).filter(({ rate }) =>
          retailFamilyMatches(model, rate.family, rate.productName),
        );
        return decoded;
      } catch {
        throw new HttpError(502, 'pricing.priceFetchFailed');
      } finally {
        lookupControllers.delete(abort);
        lookups.delete(key);
      }
    })();
    lookups.set(key, work);
    return work;
  }
  async function prefill(model: string) {
    const regions = detected()
      .filter((item) => item.model.toLowerCase() === model.toLowerCase())
      .map((item) => item.region)
      .filter(Boolean);
    const decoded = await fetchModelCatalog(model, regions.length ? regions : ['eastus2']);
    // A preview for the editor; it never writes prices or calculated costs.
    return prefillOptions(groupRates(decoded.map(({ rate }) => rate)), model);
  }
  function state(): PricingState {
    return {
      models: modelManager.list(),
      excludedModels: settings.excludedPriceModels(),
      detected: detected(),
    };
  }
  function deleteModelPrices(model: string, actor: string) {
    // Logs and usage are facts. Delete only our price configuration and derived cost results.
    return db
      .transaction(() => {
        const logged = db
          .prepare(
            "SELECT 1 FROM request_facts WHERE lower(json_extract(fact_json, '$.model')) = lower(?) LIMIT 1",
          )
          .get(model);
        const prices = settings.deleteModelPrices(model, actor);
        if (!prices && !logged) throw new HttpError(404, 'pricing.modelNotFound');
        const costs = db
          .prepare(
            `DELETE FROM request_costs WHERE EXISTS (SELECT 1 FROM request_facts r
        WHERE r.source_key = request_costs.source_key AND r.resource_id = request_costs.resource_id
        AND r.correlation_id = request_costs.correlation_id AND lower(json_extract(r.fact_json, '$.model')) = lower(?))`,
          )
          .run(model).changes;
        database.markCostsDirty();
        return { prices, costs };
      })
      .immediate();
  }
  function invalidateManual(model: string, from: string | null, to: string | null) {
    db.prepare(
      `DELETE FROM request_costs WHERE EXISTS (SELECT 1 FROM request_facts r WHERE r.source_key=request_costs.source_key
      AND r.resource_id=request_costs.resource_id AND r.correlation_id=request_costs.correlation_id AND lower(json_extract(r.fact_json,'$.model'))=lower(?)
      AND (? IS NULL OR r.time>=?) AND (? IS NULL OR r.time<?))`,
    ).run(model, from, from, to, to);
    database.markCostsDirty();
  }
  return {
    state,
    saveModel: modelManager.save,
    refreshModels(actor: string) {
      settings.rediscoverPriceModels(
        detected().map((model) => model.model),
        actor,
      );
      return state();
    },
    deleteModelPrices,
    detected,
    recalculate,
    prefill,
    invalidateManual,
    /** Recalculates while costs are dirty, yielding between batches so requests stay responsive. */
    start(onError: (error: unknown) => void) {
      let fullCheckAt = 0;
      const tick = () => {
        next = undefined;
        if (stopped) return;
        const fullCheck = Date.now() >= fullCheckAt;
        if (!database.takeCostsDirty() && !fullCheck) return;
        if (fullCheck) fullCheckAt = Date.now() + FULL_CHECK_MS;
        try {
          if (recalculate() < BATCH_SIZE) return;
          database.markCostsDirty();
          next ??= setImmediate(tick);
        } catch (error) {
          onError(error);
        }
      };
      timer = setInterval(tick, 2000);
      timer.unref();
      tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (next) clearImmediate(next);
      for (const abort of lookupControllers) abort.abort();
      await Promise.allSettled([...lookups.values()]);
    },
  };
}
export type PricingService = ReturnType<typeof createPricingService>;

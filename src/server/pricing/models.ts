import type { AppDatabase } from '../database.js';
import type { SettingsRepository } from '../settings/repository.js';
import type { PriceInput, PriceVersion } from '../../shared/settings.js';
import type { PriceModelIdentity } from '../../shared/pricing.js';
import { modelIdKey } from '../../shared/price-identity.js';
import { HttpError } from '../http/errors.js';
import { comparePriceStarts } from '../../shared/price-period.js';
import { sourceKey } from '../ingestion/parser.js';

/** Costs can change anywhere in a price's old or new effective period. */
export function changedPeriod(previous: PriceVersion | undefined, price: PriceVersion) {
  const from =
    previous && comparePriceStarts(previous.validFrom, price.validFrom) < 0
      ? previous.validFrom
      : price.validFrom;
  const to =
    previous?.validTo && price.validTo
      ? previous.validTo > price.validTo
        ? previous.validTo
        : price.validTo
      : null;
  return { from, to };
}

export function createPriceModelManager(
  database: AppDatabase,
  settings: SettingsRepository,
  invalidate: (model: string, from: string | null, to: string | null) => void,
) {
  const db = database.connection;
  function list(): PriceModelIdentity[] {
    const models = new Map<string, PriceModelIdentity>();
    for (const price of settings.listPrices())
      models.set(modelIdKey(price.model), {
        model: price.model,
        displayName: null,
        fromLogs: false,
      });
    // Active sources control discovery; stored logs determine whether an existing
    // price belongs to a log-backed model, even while its source is disabled.
    const keys = settings
      .getSources()
      .filter((source) => source.enabled)
      .map(sourceKey);
    const logged = db
      .prepare(
        `SELECT source_key, min(json_extract(fact_json, '$.model')) AS model
      FROM request_facts WHERE is_inference = 1 AND json_extract(fact_json, '$.model') IS NOT NULL
      GROUP BY source_key, lower(trim(json_extract(fact_json, '$.model')))`,
      )
      .all() as { source_key: string; model: string }[];
    for (const { source_key, model } of logged)
      if (models.has(modelIdKey(model)) || keys.includes(source_key))
        models.set(modelIdKey(model), { model, displayName: null, fromLogs: true });
    for (const profile of settings.modelProfiles()) {
      const model = models.get(modelIdKey(profile.model));
      if (model) model.displayName = profile.displayName;
    }
    return [...models.values()];
  }
  function save(
    input: {
      originalModel?: string;
      displayName: string;
      price: PriceInput;
      priceId?: string;
    },
    actor: string,
  ) {
    return db
      .transaction(() => {
        const catalog = list();
        const previous = input.originalModel
          ? catalog.find((model) => modelIdKey(model.model) === modelIdKey(input.originalModel!))
          : undefined;
        if (input.originalModel && !previous) throw new HttpError(404, 'pricing.modelNotFound');
        const renamed = previous && modelIdKey(previous.model) !== modelIdKey(input.price.model);
        if (renamed && previous.fromLogs) throw new HttpError(409, 'pricing.logModelIdReadOnly');
        if (
          (!previous || renamed) &&
          catalog.some((model) => modelIdKey(model.model) === modelIdKey(input.price.model))
        )
          throw new HttpError(409, 'pricing.modelAlreadyExists');
        const previousPrice = input.priceId
          ? settings.listPrices().find((price) => price.id === input.priceId)
          : undefined;
        if (
          input.priceId &&
          (!previousPrice ||
            !previous ||
            modelIdKey(previousPrice.model) !== modelIdKey(previous.model))
        )
          throw new HttpError(404, 'pricing.priceVersionNotFound');
        const model = previous?.fromLogs ? previous.model : input.price.model;
        if (previous && previous.model !== model)
          settings.renameModelPrices(previous.model, model, actor);
        settings.saveModelProfile(model, input.displayName, actor, previous?.model);
        const price = input.priceId
          ? settings.correctPrice(input.priceId, input.price, actor)
          : settings.addPrice({ ...input.price, model }, actor);
        const { from, to } = changedPeriod(previousPrice, price);
        invalidate(model, from, to);
        return price;
      })
      .immediate();
  }
  return { list, save };
}

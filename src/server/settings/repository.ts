import { recordAudit } from '../platform/audit-format.js';
import { LOG_DATA_TABLES } from '../platform/service.js';
import {
  taskConflict,
  dailyIntervalError,
  type ScheduledTask,
  type ScheduledTaskInput,
} from '../../shared/scheduled-tasks.js';
import { randomUUID } from 'node:crypto';
import { LOG_CONTAINERS } from '../../shared/settings.js';
import type {
  PriceInput,
  PriceItem,
  PriceVersion,
  SourceInput,
  SourceInspection,
  SourceSettings,
} from '../../shared/settings.js';
import type { AppDatabase } from '../database.js';
import { HttpError } from '../http/errors.js';
import type { SecretStore } from '../security/secrets.js';
import { normalizeManagedIdentityEndpoint, type ResolvedSource } from '../sources/azure-blob.js';
import type { PriceModelProfile } from '../../shared/pricing.js';
import { modelIdKey } from '../../shared/price-identity.js';
import { priceTemplateMatches } from '../../shared/price-form.js';
import { comparePriceStarts } from '../../shared/price-period.js';

interface SavedSource extends Omit<SourceSettings, 'hasConnectionString'> {
  encryptedCredential: string | null;
  availableContainers: SourceInspection['containers'];
}
interface PriceRow {
  id: string;
  scope_key: string;
  model: string;
  model_version: string;
  region: string;
  deployment_type: string;
  valid_from: string | null;
  valid_to: string | null;
  items_json: string;
  context_pricing_json: string | null;
  notes: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export function createSettingsRepository(database: AppDatabase, secrets: SecretStore) {
  const db = database.connection;
  function getSetting<T>(key: string): T | null {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : null;
  }
  function setSetting(key: string, value: unknown) {
    db.prepare(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    ).run(key, JSON.stringify(value), new Date().toISOString());
  }
  function audit(
    actor: string,
    action: string,
    subject: string,
    before: unknown,
    after: unknown = null,
    secretChanged = false,
  ) {
    recordAudit(database, { actor, action, subject, before, after, secretChanged });
  }
  function savedSources(): SavedSource[] {
    return getSetting<SavedSource[]>('sources') ?? [];
  }
  function getSources(): SourceSettings[] {
    return savedSources().map(({ encryptedCredential, ...value }) => ({
      ...value,
      hasConnectionString: Boolean(encryptedCredential),
    }));
  }
  function getTasks(): ScheduledTask[] {
    // Routine tasks are listed before reconciliation tasks.
    return (getSetting<ScheduledTask[]>('scheduled_tasks') ?? []).sort(
      (a, b) => (a.type === 'daily' ? 0 : 1) - (b.type === 'daily' ? 0 : 1),
    );
  }
  /** The settings list also shows how often each task has run. */
  function listTasks(): ScheduledTask[] {
    const counts = new Map(
      (
        db.prepare('SELECT task_id, count(*) n FROM task_executions GROUP BY task_id').all() as {
          task_id: string;
          n: number;
        }[]
      ).map((row) => [row.task_id, row.n]),
    );
    return getTasks().map((task) => ({ ...task, executionCount: counts.get(task.id) ?? 0 }));
  }
  function tasksForSource(sourceId: string) {
    return getTasks().filter((task) => task.enabled && task.sourceIds.includes(sourceId));
  }
  function saveTask(input: ScheduledTaskInput, actor: string, id?: string) {
    return db
      .transaction(() => {
        const tasks = getTasks();
        const previous = id ? tasks.find((task) => task.id === id) : null;
        if (id && !previous) throw new HttpError(404, 'schedule.taskNotFound');
        if (input.sourceIds.some((id) => !getSources().some((source) => source.id === id)))
          throw new HttpError(400, 'sources.sourceNotFound');
        const conflict =
          (input.enabled ? dailyIntervalError(input) : null) ?? taskConflict(input, tasks, id);
        if (conflict) throw new HttpError(409, conflict);
        const task: ScheduledTask = {
          ...input,
          id: id ?? randomUUID(),
          updatedAt: new Date().toISOString(),
        };
        audit(actor, previous ? 'task.update' : 'task.create', task.id, previous ?? null, task);
        setSetting(
          'scheduled_tasks',
          previous ? tasks.map((item) => (item.id === task.id ? task : item)) : [...tasks, task],
        );
        return task;
      })
      .immediate();
  }
  function resetTaskHistory(actor: string) {
    return db
      .transaction(() => {
        const tasks = getTasks();
        audit(actor, 'tasks.resetHistory', 'scheduled_tasks', tasks);
        setSetting(
          'scheduled_tasks',
          tasks.map((task) => ({ ...task, enabled: false, updatedAt: new Date().toISOString() })),
        );
        db.exec(`DELETE FROM task_pending;
        DELETE FROM import_runs;
        DELETE FROM system_logs WHERE category='task';
        DELETE FROM task_executions;
        DELETE FROM review_files;
        DELETE FROM review_progress;`);
        return listTasks();
      })
      .immediate();
  }
  function deleteTask(id: string, actor: string) {
    db.transaction(() => {
      const tasks = getTasks();
      const task = tasks.find((task) => task.id === id);
      if (!task) throw new HttpError(404, 'schedule.taskNotFound');
      audit(actor, 'task.delete', id, task);
      setSetting(
        'scheduled_tasks',
        tasks.filter((task) => task.id !== id),
      );
    }).immediate();
  }
  function resolveSource(input: SourceInput, id?: string): ResolvedSource {
    if (input.authMode === 'managed_identity') {
      if (input.connectionString || input.useSavedCredential)
        throw new HttpError(400, 'common.selectOnlyOneAuthenticationMethod');
      if (
        input.managedIdentityClientId &&
        !/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(input.managedIdentityClientId)
      )
        throw new HttpError(400, 'common.invalidManagedIdentityClientIDFormat');
      return {
        authMode: input.authMode,
        endpoint: normalizeManagedIdentityEndpoint(input.endpoint ?? ''),
        managedIdentityClientId: input.managedIdentityClientId ?? '',
        connectionString: '',
      };
    }
    let connectionString = input.connectionString ?? '';
    if (!connectionString && input.useSavedCredential) {
      if (!id) throw new HttpError(400, 'sources.savedCredentialNeedsSource');
      const stored = savedSources().find((source) => source.id === id);
      if (!stored || stored.authMode !== 'connection_string' || !stored.encryptedCredential)
        throw new HttpError(400, 'sources.noSavedConnectionStringIsAvailable');
      try {
        connectionString = secrets.decrypt(stored.encryptedCredential);
      } catch {
        throw new HttpError(400, 'sources.cannotDecryptTheSavedCredentials');
      }
    }
    if (!connectionString) throw new HttpError(400, 'sources.enterAConnectionString');
    return {
      authMode: input.authMode,
      connectionString,
      endpoint: '',
      managedIdentityClientId: '',
    };
  }
  function saveSource(
    input: SourceInput,
    resolved: ResolvedSource,
    inspection: SourceInspection,
    actor: string,
    id?: string,
  ) {
    if (!input.containers.length) throw new HttpError(400, 'sources.selectAtLeastOneLogContainer');
    if (input.containers.some((name) => !inspection.containers.some((item) => item.name === name)))
      throw new HttpError(400, 'common.selectedContainerIsMissingOrUnreadable');
    return db
      .transaction(() => {
        const sources = savedSources();
        const existing = id ? sources.find((source) => source.id === id) : undefined;
        if (id && !existing) throw new HttpError(404, 'sources.sourceNotFound');
        if (sources.some((source) => source.endpoint === inspection.endpoint && source.id !== id))
          throw new HttpError(409, 'sources.alreadyExists');
        const stored: SavedSource = {
          id: id ?? randomUUID(),
          enabled: input.enabled ?? existing?.enabled ?? true,
          authMode: resolved.authMode,
          endpoint: inspection.endpoint,
          accountName: inspection.accountName,
          managedIdentityClientId: resolved.managedIdentityClientId,
          containers: input.containers,
          verifiedAt: inspection.verifiedAt,
          updatedAt: new Date().toISOString(),
          encryptedCredential:
            resolved.authMode === 'connection_string'
              ? secrets.encrypt(resolved.connectionString)
              : null,
          availableContainers: inspection.containers,
        };
        audit(
          actor,
          existing ? 'source.update' : 'source.create',
          stored.id,
          existing ? getSources().find((source) => source.id === stored.id) : null,
          stored,
          Boolean(input.connectionString),
        );
        setSetting(
          'sources',
          existing
            ? sources.map((source) => (source.id === id ? stored : source))
            : [...sources, stored],
        );
        database.markCostsDirty();
        return getSources().find((source) => source.id === stored.id)!;
      })
      .immediate();
  }
  function discoverContainer(source: SourceSettings, name: string): SourceSettings {
    const container = LOG_CONTAINERS.find((item) => item.name === name);
    if (!container) throw new Error('UnsupportedContainer');
    return db
      .transaction(() => {
        const sources = savedSources();
        const current = sources.find((item) => item.id === source.id);
        if (
          !current?.enabled ||
          current.updatedAt !== source.updatedAt ||
          JSON.stringify(current.containers) !== JSON.stringify(source.containers)
        )
          throw new Error('SourceChanged');
        if (!current.containers.includes(name)) {
          const updated = {
            ...current,
            containers: [...current.containers, name],
            availableContainers: [
              ...current.availableContainers.filter((item) => item.name !== name),
              { ...container },
            ],
          };
          // Discovery is metadata, not a user schedule/credential change.
          audit('system', 'source.update', source.id, source, {
            ...source,
            containers: updated.containers,
          });
          setSetting(
            'sources',
            sources.map((item) => (item.id === source.id ? updated : item)),
          );
        }
        return getSources().find((item) => item.id === source.id)!;
      })
      .immediate();
  }
  function deleteSource(id: string, actor: string) {
    db.transaction(() => {
      const sources = savedSources();
      const tasks = getTasks();
      if (!sources.some((source) => source.id === id))
        throw new HttpError(404, 'sources.sourceNotFound');
      audit(
        actor,
        'source.delete',
        id,
        getSources().find((source) => source.id === id),
      );
      setSetting(
        'sources',
        sources.filter((source) => source.id !== id),
      );
      db.prepare('DELETE FROM source_statistics WHERE source_id = ?').run(id);
      setSetting(
        'scheduled_tasks',
        tasks.map((task) => ({
          ...task,
          sourceIds: task.sourceIds.filter((sourceId) => sourceId !== id),
          enabled: task.enabled && task.sourceIds.some((sourceId) => sourceId !== id),
        })),
      );
    }).immediate();
  }
  function setSourceEnabled(id: string, enabled: boolean, actor: string) {
    return db
      .transaction(() => {
        const sources = savedSources();
        const previous = sources.find((source) => source.id === id);
        if (!previous) throw new HttpError(404, 'sources.sourceNotFound');
        audit(
          actor,
          enabled ? 'source.enable' : 'source.disable',
          id,
          getSources().find((source) => source.id === id),
          { ...getSources().find((source) => source.id === id), enabled },
        );
        setSetting(
          'sources',
          sources.map((source) =>
            source.id === id ? { ...source, enabled, updatedAt: new Date().toISOString() } : source,
          ),
        );
        if (enabled) database.markCostsDirty();
        return getSources().find((source) => source.id === id)!;
      })
      .immediate();
  }
  function toPrice(row: PriceRow): PriceVersion {
    return {
      id: row.id,
      model: row.model,
      modelVersion: row.model_version,
      region: row.region,
      deploymentType: row.deployment_type,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      items: JSON.parse(row.items_json) as PriceItem[],
      contextPricing: row.context_pricing_json ? JSON.parse(row.context_pricing_json) : null,
      notes: row.notes,
      source: 'manual',
      currency: 'USD',
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  function listPrices() {
    return (
      db.prepare('SELECT * FROM price_versions ORDER BY model, valid_from DESC').all() as PriceRow[]
    ).map(toPrice);
  }
  function modelProfiles() {
    return getSetting<PriceModelProfile[]>('model_profiles') ?? [];
  }
  function saveModelProfile(
    model: string,
    displayName: string,
    actor: string,
    previousModel = model,
  ) {
    const profiles = modelProfiles();
    const previous = profiles.find(
      (profile) => modelIdKey(profile.model) === modelIdKey(previousModel),
    );
    if (previous?.model === model && previous.displayName === displayName) return;
    audit(actor, 'price.model.update', model, previous ?? null, { model, displayName });
    setSetting('model_profiles', [
      ...profiles.filter((profile) => modelIdKey(profile.model) !== modelIdKey(previousModel)),
      { model, displayName },
    ]);
  }
  function renameModelPrices(previousModel: string, model: string, actor: string) {
    const rows = db
      .prepare('SELECT * FROM price_versions WHERE lower(model) = lower(?)')
      .all(previousModel) as PriceRow[];
    for (const row of rows) {
      audit(actor, 'price.model.rename', row.id, toPrice(row), { ...toPrice(row), model });
      const scope = JSON.stringify(
        [model, row.model_version, row.region, row.deployment_type].map((value) =>
          value.toLowerCase(),
        ),
      );
      db.prepare(
        'UPDATE price_versions SET model = ?, scope_key = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      ).run(model, scope, new Date().toISOString(), row.id);
    }
  }
  function deleteModelPrices(model: string, actor: string) {
    return db
      .transaction(() => {
        const prices = db
          .prepare('SELECT * FROM price_versions WHERE lower(model) = lower(?)')
          .all(model) as PriceRow[];
        for (const price of prices) audit(actor, 'price.delete', price.id, toPrice(price));
        const profiles = modelProfiles();
        const profile = profiles.find((item) => modelIdKey(item.model) === modelIdKey(model));
        if (profile) {
          audit(actor, 'price.model.delete', model, profile);
          setSetting(
            'model_profiles',
            profiles.filter((item) => modelIdKey(item.model) !== modelIdKey(model)),
          );
        }
        const excluded = excludedPriceModels();
        if (!excluded.includes(model.toLowerCase())) {
          setSetting('excluded_price_models', [...excluded, model.toLowerCase()]);
          audit(actor, 'price.model.remove', model, null);
        }
        return db.prepare('DELETE FROM price_versions WHERE lower(model) = lower(?)').run(model)
          .changes;
      })
      .immediate();
  }
  function excludedPriceModels() {
    return getSetting<string[]>('excluded_price_models') ?? [];
  }
  function rediscoverPriceModels(models: string[], actor: string) {
    db.transaction(() => {
      const discovered = new Set(models.map((model) => model.toLowerCase()));
      const previous = excludedPriceModels();
      const excluded = previous.filter((model) => !discovered.has(model));
      if (excluded.length === previous.length) return;
      audit(actor, 'price.models.refresh', 'models', previous);
      setSetting('excluded_price_models', excluded);
    }).immediate();
  }
  function addPrice(input: PriceInput, actor: string) {
    return db
      .transaction(() => {
        const scope = JSON.stringify(
          [input.model, input.modelVersion, input.region, input.deploymentType].map((value) =>
            value.toLowerCase(),
          ),
        );
        const versions = db
          .prepare('SELECT * FROM price_versions WHERE scope_key = ? ORDER BY valid_from')
          .all(scope) as PriceRow[];
        if (versions.some((row) => row.valid_from === input.validFrom))
          throw new HttpError(409, 'pricing.priceWithTheSameScopeAndEffectiveTime');
        const next = versions.find(
          (row) => comparePriceStarts(row.valid_from, input.validFrom) > 0,
        );
        const validTo = input.validTo ?? next?.valid_from ?? null;
        if (next && validTo && comparePriceStarts(validTo, next.valid_from) > 0)
          throw new HttpError(409, 'pricing.effectivePeriodOverlapsALaterPriceVersion');
        const previous = versions
          .filter((row) => comparePriceStarts(row.valid_from, input.validFrom) < 0)
          .at(-1);
        const now = new Date().toISOString();
        if (
          input.validFrom !== null &&
          previous &&
          (!previous.valid_to || previous.valid_to > input.validFrom)
        ) {
          audit(actor, 'price.close_previous', previous.id, toPrice(previous), {
            ...toPrice(previous),
            validTo: input.validFrom,
          });
          db.prepare(
            'UPDATE price_versions SET valid_to = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
          ).run(input.validFrom, now, previous.id);
        }
        const id = randomUUID();
        db.prepare(
          `INSERT INTO price_versions (id, scope_key, model, model_version, region, deployment_type, valid_from, valid_to, items_json, notes, created_at, updated_at, context_pricing_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          scope,
          input.model,
          input.modelVersion,
          input.region,
          input.deploymentType,
          input.validFrom,
          validTo,
          JSON.stringify(input.items),
          input.notes,
          now,
          now,
          input.contextPricing ? JSON.stringify(input.contextPricing) : null,
        );
        audit(actor, 'price.create', id, null, { ...input, validTo });
        const excluded = excludedPriceModels();
        if (excluded.includes(input.model.toLowerCase()))
          setSetting(
            'excluded_price_models',
            excluded.filter((model) => model !== input.model.toLowerCase()),
          );
        return toPrice(db.prepare('SELECT * FROM price_versions WHERE id = ?').get(id) as PriceRow);
      })
      .immediate();
  }
  function correctPrice(
    id: string,
    input: Pick<PriceInput, 'items' | 'notes'> &
      Partial<Pick<PriceInput, 'validFrom' | 'validTo' | 'contextPricing'>>,
    actor: string,
  ) {
    return db
      .transaction(() => {
        const row = db.prepare('SELECT * FROM price_versions WHERE id = ?').get(id) as
          PriceRow | undefined;
        if (!row) throw new HttpError(404, 'pricing.priceVersionNotFound');
        const contextPricing =
          input.contextPricing === undefined ? toPrice(row).contextPricing : input.contextPricing;
        if (
          !priceTemplateMatches(
            row.model,
            [...input.items, ...(contextPricing?.longItems ?? [])],
            Boolean(contextPricing),
          )
        )
          throw new HttpError(400, 'pricing.invalidPriceTemplate');
        const versions = db
          .prepare(
            'SELECT * FROM price_versions WHERE scope_key = ? AND id != ? ORDER BY valid_from',
          )
          .all(row.scope_key, id) as PriceRow[];
        const previous = versions
          .filter((version) => comparePriceStarts(version.valid_from, row.valid_from) < 0)
          .at(-1);
        const next = versions.find(
          (version) => comparePriceStarts(version.valid_from, row.valid_from) > 0,
        );
        const from = input.validFrom === undefined ? row.valid_from : input.validFrom;
        const to =
          input.validTo === undefined ? row.valid_to : (input.validTo ?? next?.valid_from ?? null);
        if (from !== null && to !== null && to <= from)
          throw new HttpError(400, 'pricing.endAfterStart');
        if (
          (previous && comparePriceStarts(from, previous.valid_from) <= 0) ||
          (next &&
            (comparePriceStarts(from, next.valid_from) >= 0 ||
              to === null ||
              comparePriceStarts(to, next.valid_from) > 0))
        )
          throw new HttpError(409, 'pricing.periodOverlap');
        if (
          previous &&
          from !== null &&
          previous.valid_to === row.valid_from &&
          from !== row.valid_from
        ) {
          audit(actor, 'price.adjust_boundary', previous.id, toPrice(previous), {
            ...toPrice(previous),
            validTo: from,
          });
          db.prepare(
            'UPDATE price_versions SET valid_to = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
          ).run(from, new Date().toISOString(), previous.id);
        } else if (previous && from !== null && (!previous.valid_to || previous.valid_to > from)) {
          throw new HttpError(409, 'pricing.periodOverlap');
        }
        audit(actor, 'price.correct', id, toPrice(row), {
          ...toPrice(row),
          ...input,
          validFrom: from,
          validTo: to,
        });
        db.prepare(
          'UPDATE price_versions SET items_json = ?, notes = ?, valid_from = ?, valid_to = ?, context_pricing_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        ).run(
          JSON.stringify(input.items),
          input.notes,
          from,
          to,
          input.contextPricing === undefined
            ? row.context_pricing_json
            : input.contextPricing
              ? JSON.stringify(input.contextPricing)
              : null,
          new Date().toISOString(),
          id,
        );
        return toPrice(db.prepare('SELECT * FROM price_versions WHERE id = ?').get(id) as PriceRow);
      })
      .immediate();
  }
  return {
    getTasks,
    listTasks,
    tasksForSource,
    saveTask,
    deleteTask,
    resetTaskHistory,
    clearLogData(actor: string) {
      db.transaction(() => {
        const tasks = getTasks();
        audit(actor, 'platform.clearLogData', 'diagnostic_records', null);
        db.exec('DELETE FROM task_pending');
        setSetting(
          'scheduled_tasks',
          tasks.map((task) => ({ ...task, enabled: false, updatedAt: new Date().toISOString() })),
        );
        for (const table of LOG_DATA_TABLES) db.exec(`DELETE FROM ${table}`);
      }).immediate();
    },
    getSources,
    resolveSource,
    saveSource,
    discoverContainer,
    setSourceEnabled,
    deleteSource,
    listPrices,
    modelProfiles,
    saveModelProfile,
    renameModelPrices,
    addPrice,
    correctPrice,
    deleteModelPrices,
    excludedPriceModels,
    rediscoverPriceModels,
  };
}
export type SettingsRepository = ReturnType<typeof createSettingsRepository>;

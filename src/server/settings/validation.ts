import { dailyIntervalError } from '../../shared/scheduled-tasks.js';
import { z } from 'zod';
import { LOG_CONTAINERS, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../shared/settings.js';
import { priceTemplateMatches } from '../../shared/price-form.js';

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .email('auth.enterAValidEmailAddress')
  .transform((value) => value.toLowerCase())
  .refine((value) => !value.endsWith('.invalid'), 'auth.enterAUsableEmailAddress');
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
export const changeEmailSchema = z
  .object({ newEmail: emailSchema, currentPassword: z.string().min(1).max(128) })
  .strict();
export const createUserSchema = z
  .object({
    email: emailSchema,
    name: z.string().trim().min(1).max(100),
    password: passwordSchema,
    role: z.enum(['admin', 'user']).default('user'),
    enabled: z.boolean().default(true),
  })
  .strict();
export const editUserSchema = z
  .object({ name: z.string().trim().min(1).max(100), email: emailSchema.optional() })
  .strict();
export const resetUserPasswordSchema = z.object({ newPassword: passwordSchema }).strict();
export const deleteUserSchema = z
  .object({ confirmation: z.string().trim().min(1).max(254) })
  .strict();
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'common.useHHMmFormat');
const interval = z.number().int().min(1).max(1440);
export const timeZoneSchema = z
  .string()
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'schedule.invalidTimeZone');

export const sourceSchema = z
  .object({
    authMode: z.enum(['connection_string', 'managed_identity']),
    enabled: z.boolean().optional(),
    connectionString: z.string().trim().max(16384).optional(),
    useSavedCredential: z.boolean().optional(),
    endpoint: z.string().trim().max(512).optional(),
    managedIdentityClientId: z.string().trim().max(64).optional(),
    containers: z
      .array(
        z
          .string()
          .refine(
            (name) => LOG_CONTAINERS.some((item) => item.name === name),
            'sources.unsupportedLogContainer',
          ),
      )
      .max(3),
  })
  .strict()
  .refine(
    (value) => new Set(value.containers).size === value.containers.length,
    'common.containerCannotBeSelectedMoreThanOnce',
  );

const usdAmount = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,12})?$/, 'common.enterANonNegativeUSDRateWithUp');
const priceItemSchema = z
  .object({
    key: z.enum([
      'input',
      'output',
      'cache_read',
      'cache_write',
      'input_text',
      'input_image',
      'cache_read_text',
      'cache_read_image',
      'output_image',
    ]),
    label: z.string().trim().min(1).max(80),
    unitQuantity: z.literal(1000000),
    unitPriceUsd: usdAmount,
  })
  .strict();
const priceItemsSchema = z
  .array(priceItemSchema)
  .min(1)
  .max(5)
  .refine(
    (items) => new Set(items.map((item) => item.key)).size === items.length,
    'pricing.meterKeysMustBeUnique',
  );
const contextPricingSchema = z
  .object({
    threshold: z
      .string()
      .trim()
      .regex(/^[1-9]\d{0,9}$/, 'pricing.invalidContextThreshold'),
    longItems: priceItemsSchema,
  })
  .strict()
  .nullable()
  .optional();
const instant = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
export const priceSchema = z
  .object({
    model: z.string().trim().min(1).max(160),
    modelVersion: z.string().trim().min(1).max(80),
    region: z.string().trim().min(1).max(80),
    deploymentType: z.string().trim().min(1).max(80),
    validFrom: instant.nullable(),
    validTo: instant.nullable(),
    items: priceItemsSchema,
    contextPricing: contextPricingSchema,
    notes: z.string().trim().max(2000),
  })
  .strict()
  .refine(
    (value) =>
      value.validFrom === null || value.validTo === null || value.validTo > value.validFrom,
    'analytics.endTimeMustBeLaterThanTheStart',
  )
  .refine(
    (value) =>
      priceTemplateMatches(
        value.model,
        [...value.items, ...(value.contextPricing?.longItems ?? [])],
        Boolean(value.contextPricing),
      ),
    'pricing.invalidPriceTemplate',
  );

export const priceCorrectionSchema = z
  .object({
    items: priceItemsSchema,
    contextPricing: contextPricingSchema,
    notes: z.string().trim().max(2000),
    validFrom: instant.nullable().optional(),
    validTo: instant.nullable().optional(),
  })
  .strict();

const taskBaseSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  sourceIds: z
    .array(z.string().min(1).max(128))
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'schedule.duplicateSource'),
  timezone: timeZoneSchema,
});
const intervalTaskFields = { startTime: clockTime, endTime: clockTime, intervalMinutes: interval };
export const scheduledTaskSchema = z
  .discriminatedUnion('type', [
    taskBaseSchema
      .extend({
        type: z.literal('daily'),
        daytime: z.object(intervalTaskFields).strict(),
        nighttime: z.object({ intervalMinutes: interval }).strict(),
      })
      .strict(),
    taskBaseSchema
      .extend({
        type: z.literal('review'),
        hour: z.number().int().min(0).max(23),
        frequencyDays: z.number().int().min(1).max(7),
      })
      .strict(),
  ])
  .refine((task) => !task.enabled || task.sourceIds.length > 0, 'schedule.selectSource')
  .refine(
    (task) => task.type === 'review' || task.daytime.startTime !== task.daytime.endTime,
    'schedule.timeRangeInvalid',
  )
  .refine((task) => !dailyIntervalError(task), 'schedule.intervalDoesNotFit');

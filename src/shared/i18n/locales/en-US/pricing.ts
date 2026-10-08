import type source from '../zh-CN/pricing.js';
import type { LocaleMessages } from '../../types.js';

export default {
  'pricing.pricing': 'Pricing',
  'pricing.noStartDate': 'No start date',
  'pricing.cacheRead': 'Cache read',
  'pricing.cacheWrite': 'Cache write',
  'pricing.textInput': 'Text input',
  'pricing.imageInput': 'Image input',
  'pricing.textCacheRead': 'Text cache read',
  'pricing.imageCacheRead': 'Image cache read',
  'pricing.imageOutput': 'Image output',
  'pricing.priceUnitGlobal': 'USD / 1M Tokens · Global Standard by default',
  'pricing.backToEditor': 'Back to editor',
  'pricing.invalidPriceTemplate': 'The rates do not match this model’s pricing template.',
  'pricing.usePrice': 'Fill draft',
  'pricing.endTime': 'End time',
  'pricing.modelAdded': 'Model added.',
  'pricing.displayName': 'Display name',
  'pricing.modelAlreadyExists':
    'This Model ID already exists. Edit the existing model’s prices instead.',
  'pricing.logModelIdReadOnly': 'Model IDs discovered from logs cannot be changed.',
  'pricing.prefillUnsupported':
    'This model has billing dimensions beyond the current pricing template. Automatic fill is not supported.',
  'pricing.pricesFilled': 'Prices and effective dates filled into the draft.',
  'pricing.fetchingPrices': 'Fetching…',
  'pricing.fetchPrices': 'Get prices',
  'pricing.choosePrefillPrice': 'Choose price',

  'pricing.enterPrice': 'Enter at least one rate.',
  'pricing.enterLongPrice': 'Enter at least one Long context rate.',
  'pricing.chooseStartTime': 'Select a start time.',
  'pricing.unitPrices': 'Unit prices',
  'pricing.startTime': 'Start time',
  'pricing.backToVersion': 'Back to current version',
  'pricing.contextTiers': 'Context tiers',
  'pricing.contextThreshold': 'Input token threshold',
  'pricing.inputTokens': 'Input tokens',
  'pricing.invalidContextThreshold': 'Enter a threshold from 1 to 9,999,999,999.',
  'pricing.priceFetchFailed': 'Could not get prices. Try again later.',
  'pricing.modelIdLabel': 'Model ID: {id}',
  'pricing.modelIdCopied': 'Model ID copied.',
  'pricing.copyModelId': 'Copy model ID',
  'pricing.deleteModelNotice':
    "Delete this model's price history and calculated costs, and remove it from the model list. Logs and usage are retained. Add the model again to set new prices.",
  'pricing.deleteModel': 'Delete model',
  'pricing.deleteNamedModel': 'Delete {model}',
  'pricing.modelDeleted': 'Model deleted.',
  'pricing.confirmModelId': 'Confirm model ID',
  'pricing.confirmModelDeletion': 'Confirm deletion',
  'pricing.modelNotFound': 'Model not found.',
  'pricing.modelConfirmationMismatch': 'The model ID does not match.',
  'pricing.endAfterStart': 'The end time must be later than the effective time.',
  'pricing.periodOverlap': 'This period overlaps an adjacent price version. Adjust the dates.',
  'pricing.modelList': 'Models',
  'pricing.refreshModels': 'Refresh models',
  'pricing.modelsRefreshed': 'Models refreshed.',
  'pricing.addModel': 'Add model',

  'pricing.noModels': 'No models yet',
  'pricing.noModelsHint': 'Refresh after importing logs, or add a model.',

  'pricing.editPrice': 'Edit price',
  'pricing.editModelPrice': 'Edit prices for {model}',

  'pricing.priceHistory': 'Price history',
  'pricing.modelHistory': 'Price history for {model}',

  'pricing.noRetailMatch': 'No matching Retail prices',

  'pricing.effectivePeriod': 'Effective period',
  'pricing.multiplePeriods': 'Multiple periods',
  'pricing.alwaysValid': 'Always valid',
  'pricing.startsOnDate': 'From {date}',
  'pricing.endsOnDate': 'Until {date}',

  'pricing.newVersion': 'New version',

  'pricing.currentVersion': 'Active',
  'pricing.futureVersion': 'Scheduled',
  'pricing.pastVersion': 'Ended',
  'pricing.noHistory': 'No price history yet',
  'pricing.shortContext': 'Short context',
  'pricing.longContext': 'Long context',

  'pricing.addPriceVersion': 'Add price version',

  'pricing.cacheReads': 'Cache reads',

  'pricing.cacheWrites': 'Cache writes',
  'pricing.effectivePeriodOverlapsALaterPriceVersion':
    'The effective period overlaps a later price version.',
  'pricing.endTimeOptional': 'End time (optional)',

  'pricing.invalidRegionFormatOrTooManyRegionsSelected':
    'Invalid region format or too many regions selected for one sync.',

  'pricing.meterKeysMustBeUnique': 'Meter keys must be unique.',

  'pricing.noResourceRegionHasBeenDiscovered':
    'No resource region has been discovered. Specify an Azure region to sync.',

  'pricing.priceSaved': 'Price saved.',

  'pricing.priceVersionNotFound': 'Price version not found.',

  'pricing.priceWithTheSameScopeAndEffectiveTime':
    'A price with the same scope and effective time already exists. Use Correct rates.',
  'pricing.retailReturnedMultipleRatesForTheSameMeter':
    'Retail returned multiple rates for the same meter. Manual confirmation is required.',
  'pricing.savePrice': 'Save price',
} satisfies LocaleMessages<typeof source>;

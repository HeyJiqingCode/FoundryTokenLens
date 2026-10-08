import type { PriceItem } from './settings.js';
export interface RetailRate {
  id: string;
  meterId: string;
  groupKey: string;
  family: string;
  region: string;
  deploymentType: string;
  serviceTier: string;
  band: 'all' | 'short' | 'long';
  component: string;
  unitQuantity: number;
  unitPriceUsd: string;
  validFrom: string;
  validTo?: string | null;
  meterName: string;
  productName: string;
  skuName: string;
  revision: number;
}
export interface RetailGroup {
  key: string;
  family: string;
  region: string;
  deploymentType: string;
  serviceTier: string;
  hasContextBands: boolean;
  components: string[];
  rates: RetailRate[];
}
export interface DetectedModel {
  sourceKey?: string;
  scopeKey: string;
  resourceId: string;
  deployment: string;
  model: string;
  modelVersion: string;
  region: string;
  requests: number;
  firstSeen?: string;
}
export interface PriceModelProfile {
  model: string;
  displayName: string;
}
export interface PriceModelIdentity {
  model: string;
  displayName: string | null;
  fromLogs: boolean;
}
export interface CostItem extends PriceItem {
  quantity: string | null;
  costUsd: string | null;
  reason: string | null;
  reference: string;
}
export const COST_CONTEXTS = ['short', 'long', 'other'] as const;
export type CostContext = (typeof COST_CONTEXTS)[number];
export interface RequestCost {
  status:
    'complete' | 'partial' | 'missing_price' | 'pending_mapping' | 'missing_usage' | 'missing_time';
  complete: boolean;
  totalUsd: string | null;
  knownUsd: string | null;
  reason: string | null;
  source: 'manual' | null;
  /** The context row the price used: short or long for tiered prices, 'other' for single-row prices. */
  context: CostContext | null;
  items: CostItem[];
  calculatedAt: string;
}
export interface PricingState {
  models?: PriceModelIdentity[];
  excludedModels?: string[];
  detected: DetectedModel[];
}

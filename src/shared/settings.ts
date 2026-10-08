export type SourceAuthMode = 'connection_string' | 'managed_identity';
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const LOG_CONTAINERS = [
  {
    name: 'insights-logs-azureopenairequestusage',
    label: 'Azure OpenAI Request Usage',
    category: 'usage',
  },
  {
    name: 'insights-logs-requestresponse',
    label: 'Request and Response Logs',
    category: 'requests',
  },
] as const;

export interface SourceInput {
  authMode: SourceAuthMode;
  enabled?: boolean;
  connectionString?: string;
  useSavedCredential?: boolean;
  endpoint?: string;
  managedIdentityClientId?: string;
  containers: string[];
}

export interface SourceSettings {
  id: string;
  enabled: boolean;
  authMode: SourceAuthMode;
  endpoint: string;
  accountName: string;
  managedIdentityClientId: string;
  containers: string[];
  hasConnectionString: boolean;
  verifiedAt: string;
  updatedAt: string;
  availableContainers: SourceInspection['containers'];
}

export interface SourceInspection {
  endpoint: string;
  accountName: string;
  containers: { name: string; label: string; category: string }[];
  verifiedAt: string;
}

export interface PriceItem {
  key: string;
  label: string;
  unitQuantity: number;
  unitPriceUsd: string;
}

export interface PriceInput {
  model: string;
  modelVersion: string;
  region: string;
  deploymentType: string;
  validFrom: string | null;
  validTo: string | null;
  items: PriceItem[];
  contextPricing?: { threshold: string; longItems: PriceItem[] } | null;
  notes: string;
}

export interface PriceVersion extends PriceInput {
  id: string;
  source: 'manual';
  currency: 'USD';
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionUser {
  id: string;
  email: string | null;
  name: string;
  role: 'admin' | 'user';
  enabled: boolean;
  hasLocalPassword?: boolean;
  isInitialAdmin?: boolean;
}

export interface AuthState {
  setupRequired: boolean;
  user: SessionUser | null;
  entraEnabled?: boolean;
  publicUrl?: string;
}

export interface EntraSettings {
  enabled: boolean;
  defaultAdmin: boolean;
  allowedTenantIds: string[];
  clientId: string;
  hasSecret: boolean;
  updatedAt: string | null;
  callbackUrl: string;
  publicUrl: string;
  publicUrlSource: 'environment' | 'settings' | 'default';
}

import type { BootstrapResponse } from '../shared/navigation';

export type Connection =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: BootstrapResponse };

import { useEffect } from 'react';
import { SERVICE_UNAVAILABLE } from '../api';
import { useServiceOnline } from '../connection';
import { useToast } from './toast-context';

const ID = 'service-unavailable';

/** One notice for as long as the service cannot be reached; it closes once the service answers. */
export function ConnectionNotice() {
  const online = useServiceOnline();
  const { notify, dismiss } = useToast();
  useEffect(() => {
    if (online) dismiss(ID);
    else notify({ id: ID, kind: 'error', text: SERVICE_UNAVAILABLE, persistent: true });
  }, [online, notify, dismiss]);
  return null;
}

import { t, useLocale } from '../../i18n';
import { useState } from 'react';
import { UserRoundPen } from 'lucide-react';
import type { SessionUser } from '../../../shared/settings';
import { AccountPage } from '../account/AccountPage';
import { EnabledToggle } from '../../components/EnabledToggle';
import { FormNotice } from '../../components/Form';
import { useAction } from '../../components/useAction';
import { api } from '../../api';
import { Dialog } from '../../components/Dialog';

export function UserEditorDialog({
  user,
  onClose,
  onUserChanged,
  statusLock,
}: {
  user: SessionUser;
  onClose: () => void;
  onUserChanged: () => void;
  statusLock?: Parameters<typeof t>[0];
}) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const { busy: updating, notice, run } = useAction();
  const [enabled, setEnabled] = useState(user.enabled);
  return (
    <Dialog
      title={t('auth.editUser')}
      subtitle={user.name}
      icon={UserRoundPen}
      busy={busy || updating}
      headerAction={
        <EnabledToggle
          value={enabled}
          disabled={busy || updating || Boolean(statusLock)}
          title={statusLock ? t(statusLock) : undefined}
          onChange={(next) =>
            void run(async () => {
              const result = await api<{ user: SessionUser }>(`/api/users/${user.id}/access`, {
                method: 'PATCH',
                body: { enabled: next },
              });
              setEnabled(result.user.enabled);
              onUserChanged();
              return { kind: 'success', text: next ? 'auth.userEnabled' : 'auth.userDisabled' };
            })
          }
        />
      }
      onClose={onClose}
    >
      <fieldset disabled={updating}>
        <AccountPage user={user} adminEdit onUserChanged={onUserChanged} onBusyChange={setBusy} />
      </fieldset>
      <FormNotice notice={notice} />
    </Dialog>
  );
}

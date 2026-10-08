import { LocalizedLabel } from '../../components/LocalizedLabel';
import type { SessionUser } from '../../../shared/settings';
import { api } from '../../api';
import { TypedDeleteDialog } from '../../components/ConfirmDialog';
import { message, t, useLocale } from '../../i18n';

export function UserDeleteDialog({
  user,
  onClose,
  onDeleted,
}: {
  user: SessionUser;
  onClose: () => void;
  onDeleted: () => void;
}) {
  useLocale();
  const expected = (user.email ?? user.name).trim();
  return (
    <TypedDeleteDialog
      title={t('auth.deleteUser')}
      subtitle={user.email ? `${user.name} · ${user.email}` : user.name}
      copy={
        user.email
          ? { label: t('auth.copyEmail'), copied: 'auth.emailCopied' }
          : { label: t('auth.copyDisplayName'), copied: 'auth.displayNameCopied' }
      }
      message={
        <LocalizedLabel
          message="auth.deletionNotice"
          params={{
            account: message('auth.platformAccountAndItsSignInCredentialsWill'),
            organization:
              user.hasLocalPassword === false
                ? message('auth.entraOrganizationAccountIsUnaffected')
                : '',
          }}
        />
      }
      confirmation={{
        label: (
          <LocalizedLabel message={user.email ? 'auth.confirmEmail' : 'auth.confirmDisplayName'} />
        ),
        expected,
        // Display names are matched exactly; email addresses ignore case.
        caseSensitive: !user.email,
        name: 'deleteConfirmation',
        maxLength: 254,
        placeholder: expected,
      }}
      confirmLabel={<LocalizedLabel message="auth.confirmDeletion" />}
      onConfirm={async (confirmation) => {
        await api(`/api/users/${user.id}`, { method: 'DELETE', body: { confirmation } });
        onDeleted();
      }}
      onClose={onClose}
    />
  );
}

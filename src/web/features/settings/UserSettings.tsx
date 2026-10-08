import { LocalizedLabel } from '../../components/LocalizedLabel';
import { t, useLocale } from '../../i18n';
import { ChevronDown, UsersRound, Plus } from 'lucide-react';
import { Card } from '../../components/Card';
import { useRef, useState } from 'react';

import type { SessionUser } from '../../../shared/settings';
import { api } from '../../api';
import { FormNotice } from '../../components/Form';
import { useAction } from '../../components/useAction';
import { useApiResource } from '../../components/useApiResource';
import { EntraSettings } from './EntraSettings';
import { UserEditorDialog } from './UserEditorDialog';
import { UserCreateDialog } from './UserCreateDialog';
import { UserDeleteDialog } from './UserDeleteDialog';
import { CardLoading, EnabledPill, RowActions } from './settings-table';

export function UserSettings({
  user,
  onUserChanged,
}: {
  user: SessionUser;
  onUserChanged: () => void;
}) {
  useLocale();
  const [revision, setRevision] = useState(0);
  const { data, error, loading } = useApiResource<{ users: SessionUser[] }>('/api/users', revision);
  const users = data?.users ?? [];
  const [adding, setAdding] = useState(false);
  // The editor follows the reloaded list, so it shows the user's saved state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = users.find((item) => item.id === editingId);
  const [deleting, setDeleting] = useState<SessionUser | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const { busy, notice, setNotice, run } = useAction();
  const changeRole = (target: SessionUser, role: SessionUser['role']) =>
    run(async () => {
      await api(`/api/users/${target.id}/access`, { method: 'PATCH', body: { role } });
      onUserChanged();
      setRevision((value) => value + 1);
      return { kind: 'success', text: 'auth.roleUpdated' };
    });
  const activeAdmins = users.filter((item) => item.role === 'admin' && item.enabled);
  const activeLocalAdmins = activeAdmins.filter((item) => item.hasLocalPassword !== false);
  function accessLock(target: SessionUser) {
    if (!target.enabled || target.role !== 'admin') return undefined;
    if (activeAdmins.length <= 1) return 'auth.lastAdminRequired';
    if (target.hasLocalPassword !== false && activeLocalAdmins.length <= 1)
      return 'auth.lastLocalAdminRequired';
    return undefined;
  }
  function deleteLock(target: SessionUser) {
    if (target.isInitialAdmin) return 'auth.initialLocalAdministratorCannotBeDeleted';
    if (target.id === user.id) return 'auth.youCannotDeleteYourOwnAccount';
    return accessLock(target);
  }
  function roleLock(target: SessionUser) {
    if (target.isInitialAdmin) return 'auth.initialLocalAdministratorSRoleCannotBeChanged';
    if (target.id === user.id) return 'auth.youCannotChangeYourOwnRole';
    return accessLock(target);
  }
  function statusLock(target: SessionUser) {
    if (target.id === user.id) return 'auth.youCannotDisableYourOwnAccount';
    return accessLock(target);
  }
  return (
    <>
      <Card
        title={<LocalizedLabel message="auth.users" />}
        icon={UsersRound}
        tone="blue"
        actions={
          <button
            ref={addButton}
            className="button secondary toolbar-button"
            type="button"
            disabled={busy}
            aria-haspopup="dialog"
            onClick={() => setAdding(true)}
          >
            <Plus size={14} aria-hidden="true" />
            <LocalizedLabel message="auth.addUser" />
          </button>
        }
      >
        <FormNotice error={error} />
        <FormNotice notice={notice} />
        <fieldset disabled={busy}>
          <table className="data-table list" aria-label={t('auth.userList')} aria-busy={loading}>
            <thead>
              <tr>
                <th>
                  <LocalizedLabel message="auth.user" />
                </th>
                <th>
                  <LocalizedLabel message="auth.role" />
                </th>
                <th>
                  <LocalizedLabel message="common.status" />
                </th>
                <th>
                  <LocalizedLabel message="common.actions" />
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="member-identity">
                      <span
                        className={`member-avatar ${item.role === 'admin' ? 'tone-blue' : 'tone-slate'}`}
                        aria-hidden="true"
                      >
                        {Array.from(item.name || item.email || 'U')[0].toLocaleUpperCase()}
                      </span>
                      <div>
                        <strong>{item.name}</strong>
                        <small>
                          {item.email || t('auth.noEmail')}
                          {item.hasLocalPassword === false ? ' · Microsoft Entra ID' : ''}
                          {item.isInitialAdmin ? t('auth.localAdminBadge') : ''}
                          {item.id === user.id ? t('auth.currentUserBadge') : ''}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="member-role">
                      <select
                        aria-label={t('auth.namedUserRole', { name: item.email || item.name })}
                        value={item.role}
                        disabled={Boolean(roleLock(item))}
                        title={t(roleLock(item) ?? 'common.empty')}
                        onChange={(event) =>
                          void changeRole(item, event.target.value as SessionUser['role'])
                        }
                      >
                        <option value="admin">{t('auth.admin')}</option>
                        <option value="user">{t('auth.readOnly')}</option>
                      </select>
                      <ChevronDown className="field-select-icon" size={15} aria-hidden="true" />
                    </div>
                  </td>
                  <td>
                    <EnabledPill enabled={item.enabled} />
                  </td>
                  <td>
                    <RowActions
                      edit={{
                        label: t('auth.editNamedUser', { name: item.name }),
                        title: t('auth.editUser'),
                        onClick: () => setEditingId(item.id),
                      }}
                      remove={{
                        label: t('auth.deleteNamedUser', { name: item.name }),
                        title: t(deleteLock(item) ?? 'auth.deleteUser'),
                        disabled: Boolean(deleteLock(item)),
                        onClick: () => setDeleting(item),
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <CardLoading message="auth.loadingUsers" />}
        </fieldset>
      </Card>
      <EntraSettings />
      {deleting && (
        <UserDeleteDialog
          user={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setNotice({ kind: 'success', text: 'auth.userDeleted' });
            setRevision((value) => value + 1);
            window.requestAnimationFrame(() => addButton.current?.focus());
          }}
        />
      )}
      {adding && (
        <UserCreateDialog
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            setNotice({ kind: 'success', text: 'auth.userCreated' });
            setRevision((value) => value + 1);
          }}
        />
      )}
      {editing && (
        <UserEditorDialog
          key={editing.id}
          user={editing}
          statusLock={statusLock(editing)}
          onClose={() => setEditingId(null)}
          onUserChanged={() => {
            setRevision((value) => value + 1);
            onUserChanged();
          }}
        />
      )}
    </>
  );
}

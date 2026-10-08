import { LocalizedLabel } from '../../components/LocalizedLabel';
import { t, useLocale } from '../../i18n';
import { useState, type FormEvent } from 'react';
import { Plus, ShieldCheck, UserRound, UserRoundPlus } from 'lucide-react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../../shared/settings';
import { api, errorMessage } from '../../api';
import { Field, FormNotice, type Notice } from '../../components/Form';
import { SectionTitle } from '../../components/SectionTitle';
import { EnabledToggle } from '../../components/EnabledToggle';
import { Dialog } from '../../components/Dialog';

export function UserCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  useLocale();
  const [draft, setDraft] = useState({
    enabled: true,
    email: '',
    name: '',
    password: '',
    role: 'user' as 'admin' | 'user',
  });
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  async function createUser(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (draft.password !== confirmation) {
      setNotice({ kind: 'error', text: 'auth.passwordsDoNotMatch' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api('/api/users', { method: 'POST', body: draft });
      onCreated();
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t('auth.addUser')}
      icon={UserRoundPlus}
      busy={busy}
      onClose={onClose}
      headerAction={
        <EnabledToggle
          value={draft.enabled}
          disabled={busy}
          onChange={(enabled) => setDraft({ ...draft, enabled })}
        />
      }
    >
      <form onSubmit={createUser}>
        <fieldset disabled={busy}>
          <div className="dialog-sections">
            <section className="dialog-section" aria-labelledby="new-user-profile-heading">
              <SectionTitle id="new-user-profile-heading" icon={UserRound}>
                <LocalizedLabel message="auth.userDetails" />
              </SectionTitle>
              <Field label={<LocalizedLabel message="auth.email" />}>
                <input
                  type="email"
                  name="newUserEmail"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={254}
                  value={draft.email}
                  onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                />
              </Field>
              <Field label={<LocalizedLabel message="auth.displayName" />}>
                <input
                  name="newDisplayName"
                  required
                  maxLength={100}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
            </section>
            <section className="dialog-section" aria-labelledby="new-user-security-heading">
              <SectionTitle
                id="new-user-security-heading"

                icon={ShieldCheck}
                tone="violet"
              >
                <LocalizedLabel message="auth.signInAndAccess" />
              </SectionTitle>
              <Field label={<LocalizedLabel message="auth.initialPassword" />}>
                <input
                  type="password"
                  name="newUserPassword"
                  required
                  minLength={PASSWORD_MIN_LENGTH}
                  maxLength={PASSWORD_MAX_LENGTH}
                  placeholder={t('auth.passwordLengthHint', {
                    min: PASSWORD_MIN_LENGTH,
                    max: PASSWORD_MAX_LENGTH,
                  })}
                  autoComplete="new-password"
                  value={draft.password}
                  onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                />
              </Field>
              <Field label={<LocalizedLabel message="auth.confirmPassword" />}>
                <input
                  type="password"
                  name="newUserPasswordConfirmation"
                  required
                  minLength={PASSWORD_MIN_LENGTH}
                  maxLength={PASSWORD_MAX_LENGTH}
                  placeholder={t('auth.enterThePasswordAgain')}
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </Field>
              <Field label={<LocalizedLabel message="auth.role" />}>
                <select
                  name="newUserRole"
                  value={draft.role}
                  onChange={(event) =>
                    setDraft({ ...draft, role: event.target.value as 'admin' | 'user' })
                  }
                >
                  <option value="user">{t('auth.readOnly')}</option>
                  <option value="admin">{t('auth.admin')}</option>
                </select>
              </Field>
            </section>
          </div>
          <footer className="dialog-actions">
            <button className="button secondary" type="button" onClick={onClose}>
              <LocalizedLabel message="common.cancel" />
            </button>
            <button className="button primary" type="submit">
              <Plus size={16} aria-hidden="true" />
              {busy ? (
                <LocalizedLabel message="common.creating" />
              ) : (
                <LocalizedLabel message="auth.createUser" />
              )}
            </button>
          </footer>
        </fieldset>
        <FormNotice notice={notice} />
      </form>
    </Dialog>
  );
}

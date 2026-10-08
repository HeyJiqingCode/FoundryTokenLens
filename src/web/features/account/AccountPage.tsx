import { LocalizedLabel } from '../../components/LocalizedLabel';
import { t, useLocale, message } from '../../i18n';
import { ShieldCheck, UserRound } from 'lucide-react';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { SectionTitle } from '../../components/SectionTitle';
import { useEffect, useState, type FormEvent } from 'react';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type SessionUser,
} from '../../../shared/settings';
import { api, errorMessage } from '../../api';
import { Field, FormNotice, type Notice } from '../../components/Form';

export function AccountPage({
  user,
  onUserChanged,
  adminEdit = false,
  onBusyChange,
}: {
  user: SessionUser;
  onUserChanged: () => void;
  adminEdit?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  useLocale();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email ?? '');
  const [emailPassword, setEmailPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState<'profile' | 'password' | null>(null);
  const [profileNotice, setProfileNotice] = useState<Notice>(null);
  const [passwordNotice, setPasswordNotice] = useState<Notice>(null);

  useEffect(() => {
    onBusyChange?.(busy !== null);
  }, [busy, onBusyChange]);

  useEffect(() => {
    setName(user.name);
    setEmail(user.email ?? '');
  }, [user.name, user.email]);
  const emailChanged = user.hasLocalPassword !== false && email.trim().toLowerCase() !== user.email;

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setBusy('profile');
    setProfileNotice(null);
    let emailSaved = false;
    try {
      if (adminEdit) {
        await api(`/api/users/${user.id}`, {
          method: 'PATCH',
          body: { name, ...(user.hasLocalPassword !== false ? { email } : {}) },
        });
        setProfileNotice({ kind: 'success', text: 'auth.profileSaved' });
        return;
      }
      if (emailChanged) {
        await api('/api/auth/change-email', {
          method: 'POST',
          body: { newEmail: email, currentPassword: emailPassword },
        });
        emailSaved = true;
        setEmailPassword('');
      }
      await api('/api/auth/update-user', {
        method: 'POST',
        body: { name },
      });
      setProfileNotice({ kind: 'success', text: 'auth.profileSaved' });
      setEmail(email.trim().toLowerCase());
    } catch (error) {
      setProfileNotice({
        kind: 'error',
        text: emailSaved
          ? message('auth.profilePartiallySaved', { error: errorMessage(error) })
          : errorMessage(error),
      });
    } finally {
      onUserChanged();
      setBusy(null);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmation) {
      setPasswordNotice({ kind: 'error', text: 'auth.newPasswordsDoNotMatch' });
      return;
    }
    setBusy('password');
    setPasswordNotice(null);
    try {
      await api(adminEdit ? `/api/users/${user.id}/password` : '/api/auth/change-password', {
        method: 'POST',
        body: adminEdit
          ? { newPassword }
          : { currentPassword, newPassword, revokeOtherSessions: true },
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setPasswordNotice({
        kind: 'success',
        text: adminEdit ? 'auth.passwordReset' : 'auth.passwordChanged',
      });
      onUserChanged();
    } catch (error) {
      setPasswordNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  const profileTitle = <LocalizedLabel message="auth.profile" />;
  const securityTitle = <LocalizedLabel message="auth.passwordSecurity" />;
  const profile = (
    <form className="settings-form account-form" onSubmit={saveProfile}>
      <fieldset disabled={busy !== null}>
        <div className="field">
          <span className="field-label">
            <LocalizedLabel message="auth.role" />
          </span>
          <div className="field-value">
            <Pill capsule>
              <LocalizedLabel message={user.role === 'admin' ? 'auth.admin' : 'auth.readOnly'} />
            </Pill>
          </div>
        </div>
        <Field label={<LocalizedLabel message="auth.displayName" />}>
          <input
            name="displayName"
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label={<LocalizedLabel message="auth.email" />}
          hint={
            user.hasLocalPassword === false ? (
              <LocalizedLabel message="auth.managedByMicrosoftEntraID" />
            ) : undefined
          }
        >
          <input
            type="email"
            name="profileEmail"
            required={user.hasLocalPassword !== false}
            readOnly={user.hasLocalPassword === false}
            maxLength={254}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={user.hasLocalPassword === false ? t('auth.noEmail') : undefined}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        {emailChanged && !adminEdit && (
          <Field
            label={<LocalizedLabel message="auth.currentPassword" />}
            hint={<LocalizedLabel message="auth.enterYourCurrentPasswordToChangeYourEmail" />}
          >
            <input
              type="password"
              name="emailCurrentPassword"
              autoComplete="current-password"
              required
              maxLength={128}
              value={emailPassword}
              onChange={(event) => setEmailPassword(event.target.value)}
            />
          </Field>
        )}
        <div className="form-actions">
          <button className="button primary toolbar-button" type="submit">
            {busy === 'profile' ? (
              <LocalizedLabel message="common.saving" />
            ) : (
              <LocalizedLabel message="auth.saveProfile" />
            )}
          </button>
        </div>
      </fieldset>
      <FormNotice notice={profileNotice} />
    </form>
  );
  const security = (
    <>
      {user.hasLocalPassword !== false ? (
        <form className="settings-form account-form" onSubmit={changePassword}>
          <fieldset disabled={busy !== null}>
            {!adminEdit && (
              <Field label={<LocalizedLabel message="auth.currentPassword" />}>
                <input
                  type="password"
                  name="currentPassword"
                  required
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </Field>
            )}
            <Field label={<LocalizedLabel message="auth.newPassword" />}>
              <input
                type="password"
                name="newPassword"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                placeholder={t('auth.passwordLengthHint', {
                  min: PASSWORD_MIN_LENGTH,
                  max: PASSWORD_MAX_LENGTH,
                })}
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>
            <Field label={<LocalizedLabel message="auth.confirmNewPassword" />}>
              <input
                type="password"
                name="confirmPassword"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </Field>
            <div className="form-actions">
              <button
                className={`button toolbar-button ${adminEdit ? 'danger' : 'primary'}`}
                type="submit"
              >
                {busy === 'password' ? (
                  <LocalizedLabel message="common.updating" />
                ) : adminEdit ? (
                  <LocalizedLabel message="auth.resetPassword" />
                ) : (
                  <LocalizedLabel message="auth.updatePassword" />
                )}
              </button>
            </div>
          </fieldset>
          <FormNotice notice={passwordNotice} />
        </form>
      ) : (
        <div className="info-note">{t('auth.passwordsAndMFAAreManagedByMicrosoftEntra')}</div>
      )}
    </>
  );
  // Editing another user happens in a dialog, whose two sections sit side by side like other
  // editors; the own account page shows the same forms as two cards.
  if (adminEdit)
    return (
      <div className="dialog-sections">
        <section className="dialog-section" aria-labelledby="profile-heading">
          <SectionTitle id="profile-heading" icon={UserRound}>
            {profileTitle}
          </SectionTitle>
          {profile}
        </section>
        <section className="dialog-section" aria-labelledby="password-heading">
          <SectionTitle id="password-heading" icon={ShieldCheck} tone="violet">
            {securityTitle}
          </SectionTitle>
          {security}
        </section>
      </div>
    );
  return (
    <div className="card-row halves" aria-label={t('auth.accountSettings')}>
      <Card title={profileTitle} icon={UserRound} tone="blue" className="account-card">
        {profile}
      </Card>
      <Card title={securityTitle} icon={ShieldCheck} tone="violet" className="account-card">
        {security}
      </Card>
    </div>
  );
}

import { LocalizedLabel } from '../../components/LocalizedLabel';
import { getLocale, systemMessage, t, useLocale, type DisplayMessage } from '../../i18n';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BrandMark } from '../../components/BrandMark';
import { Navigate, useLocation } from 'react-router';
import { loginPath, safeReturnPath } from '../../../shared/navigation';
import { entraLoginError } from '../../../shared/entra-errors';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type AuthState,
  type SessionUser,
} from '../../../shared/settings';
import { SERVICE_UNAVAILABLE, api, errorMessage } from '../../api';
import { onReconnect } from '../../connection';
import { StatusScreen } from '../../components/StatusScreen';
import { Field, FormNotice, type Notice } from '../../components/Form';
import microsoftSymbol from '../../assets/microsoft.svg';
import { LanguageSwitch } from '../../components/LanguageSwitch';
import { ScrollViewport } from '../../components/ScrollViewport';

export function AuthGate({
  children,
}: {
  children: (user: SessionUser, refresh: () => void) => ReactNode;
}) {
  const locale = useLocale();
  const location = useLocation();
  const onLoginPage = location.pathname.replace(/\/+$/, '') === '/login';
  const returnTo = safeReturnPath(new URLSearchParams(location.search).get('returnTo'));
  const [session, setSession] = useState<AuthState | null>(null);
  // Why the session could not be checked; the form notices below are for signing in.
  const [sessionError, setSessionError] = useState<DisplayMessage | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const sessionRevision = useRef(0);
  const refresh = useCallback(() => {
    const revision = ++sessionRevision.current;
    void api<AuthState>('/api/session')
      .then((value) => {
        if (revision !== sessionRevision.current) return;
        setSession(value);
        setSessionError(null);
      })
      .catch((error) => {
        if (revision === sessionRevision.current) setSessionError(errorMessage(error));
      });
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener('ftl:unauthorized', refresh);
    // A service that was unreachable (e.g. restarting) resumes here once it answers again.
    const stop = onReconnect(refresh);
    return () => {
      window.removeEventListener('ftl:unauthorized', refresh);
      stop();
    };
  }, [refresh]);
  useEffect(() => {
    const text = entraLoginError(new URLSearchParams(location.search));
    if (text) setNotice({ kind: 'error', text });
  }, [location.search]);
  useEffect(() => {
    if (onLoginPage) document.title = t('auth.signInTitle');
  }, [onLoginPage, locale]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    if (session?.setupRequired && password !== confirmation) {
      setNotice({ kind: 'error', text: 'auth.passwordsDoNotMatch' });
      return;
    }
    setBusy(true);
    try {
      if (session?.setupRequired)
        await api('/api/setup', {
          method: 'POST',
          body: { email, name, password, role: 'admin' },
        });
      await api('/api/auth/sign-in/email', { method: 'POST', body: { email, password } });
      setPassword('');
      setConfirmation('');
      refresh();
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function signInWithMicrosoft() {
    setBusy(true);
    setNotice(null);
    if (session?.publicUrl && session.publicUrl !== window.location.origin) {
      window.location.assign(`${session.publicUrl}${loginPath(returnTo)}&language=${getLocale()}`);
      return;
    }
    try {
      const result = await api<{ url: string }>('/api/auth/sign-in/social', {
        method: 'POST',
        body: { provider: 'microsoft', returnTo },
      });
      window.location.assign(result.url);
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
      setBusy(false);
      refresh();
    }
  }

  if (session?.user)
    return onLoginPage ? <Navigate to={returnTo} replace /> : children(session.user, refresh);
  if (session && !onLoginPage)
    return (
      <Navigate
        to={loginPath(
          `${location.pathname}${location.search}${location.hash}`,
          new URLSearchParams(location.search).has('auth_error'),
        )}
        replace
      />
    );
  if (!session && sessionError)
    return (
      <StatusScreen
        title={t('errors.serviceUnavailableTitle')}
        text={
          sessionError === SERVICE_UNAVAILABLE
            ? t('errors.serviceUnavailableHint')
            : systemMessage(sessionError)
        }
        action={{ label: t('auth.reconnect'), onClick: refresh }}
      />
    );
  if (!session)
    return (
      <main className="auth-page" aria-busy="true">
        <div className="auth-loading" role="status">
          <BrandMark />
          <span>{t('auth.loadingSession')}</span>
        </div>
      </main>
    );
  return (
    <main className="auth-page">
      <div className="auth-language">
        <LanguageSwitch />
      </div>
      <section className="auth-card" aria-labelledby="auth-heading">
        <ScrollViewport
          className="auth-viewport"
          contentClassName="auth-content"
          label={t('auth.signIn')}
        >
          <header className="auth-brand">
            <BrandMark />
            <h1 id="auth-heading">Foundry Token Lens</h1>
          </header>
          <FormNotice notice={notice} />
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              {session.setupRequired && (
                <Field label={t('auth.displayName')}>
                  <input
                    name="name"
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={100}
                  />
                </Field>
              )}
              <Field label={<LocalizedLabel message="auth.email" />}>
                <input
                  type="email"
                  name="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  maxLength={254}
                />
              </Field>
              <Field label={<LocalizedLabel message="auth.password" />}>
                <input
                  name="password"
                  type="password"
                  autoComplete={session.setupRequired ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={session.setupRequired ? PASSWORD_MIN_LENGTH : 1}
                  maxLength={PASSWORD_MAX_LENGTH}
                  placeholder={
                    session.setupRequired
                      ? t('auth.passwordLengthHint', {
                          min: PASSWORD_MIN_LENGTH,
                          max: PASSWORD_MAX_LENGTH,
                        })
                      : undefined
                  }
                />
              </Field>
              {session.setupRequired && (
                <Field label={<LocalizedLabel message="auth.confirmPassword" />}>
                  <input
                    name="confirmation"
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_LENGTH}
                  />
                </Field>
              )}
              <button className="button primary auth-submit" type="submit">
                {busy ? (
                  <LocalizedLabel message="common.processing" />
                ) : session.setupRequired ? (
                  <LocalizedLabel message="auth.createAndSignIn" />
                ) : (
                  <LocalizedLabel message="auth.signIn" />
                )}
              </button>
            </fieldset>
          </form>
          {session?.entraEnabled && !session.setupRequired && (
            <div className="auth-sso">
              <hr className="auth-divider" />
              <button
                className="button auth-provider"
                type="button"
                disabled={busy}
                onClick={() => void signInWithMicrosoft()}
              >
                <img src={microsoftSymbol} width={19} height={19} alt="" aria-hidden="true" />
                <LocalizedLabel message="auth.signInWithMicrosoft" />
              </button>
            </div>
          )}
        </ScrollViewport>
      </section>
    </main>
  );
}

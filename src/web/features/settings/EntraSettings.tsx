import { EnabledToggle } from '../../components/EnabledToggle';
import { LocalizedLabel } from '../../components/LocalizedLabel';
import { t, useLocale, message } from '../../i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import type { EntraSettings as EntraValue } from '../../../shared/settings';
import { api, errorMessage } from '../../api';
import { Field, FormNotice } from '../../components/Form';
import { Card } from '../../components/Card';
import { SecretInput } from '../../components/SecretInput';
import { copyText } from '../../components/copy-text';
import { useAction } from '../../components/useAction';
import { microsoftCallbackUrl, normalizePublicUrl } from '../../../shared/public-url';

export function EntraSettings() {
  useLocale();
  const [value, setValue] = useState<EntraValue | null>(null);
  const [saved, setSaved] = useState<EntraValue | null>(null);
  const [secret, setSecret] = useState('');
  const [allowedTenants, setAllowedTenants] = useState('');
  const { busy, notice, setNotice, run } = useAction();
  const hasSavedSecret = Boolean(
    saved?.hasSecret && value?.clientId.toLowerCase() === saved.clientId.toLowerCase(),
  );
  let callbackPreview = '';
  if (value) {
    try {
      callbackPreview = microsoftCallbackUrl(value.publicUrl);
    } catch {
      /* Invalid drafts stay editable. */
    }
  }
  useEffect(() => {
    void api<{ entra: EntraValue }>('/api/settings/entra')
      .then((r) => {
        setValue(r.entra);
        setSaved(r.entra);
        setAllowedTenants((r.entra.allowedTenantIds ?? []).join('; '));
      })
      .catch((e) => setNotice({ kind: 'error', text: errorMessage(e) }));
  }, [setNotice]);
  function save(event: FormEvent) {
    event.preventDefault();
    if (!value) return;
    void run(async () => {
      const result = await api<{ entra: EntraValue }>('/api/settings/entra', {
        method: 'PUT',
        body: {
          enabled: value.enabled,
          defaultAdmin: value.defaultAdmin,
          allowedTenantIds: allowedTenants.split(/[\s,;，；]+/).filter(Boolean),
          clientId: value.clientId,
          clientSecret: secret,
          useSavedSecret: !secret && hasSavedSecret,
          publicUrl: normalizePublicUrl(value.publicUrl),
        },
      });
      setValue(result.entra);
      setSaved(result.entra);
      setAllowedTenants(result.entra.allowedTenantIds.join('; '));
      setSecret('');
      return {
        kind: 'success',
        text: !result.entra.enabled
          ? 'auth.entraDisabled'
          : result.entra.publicUrl === window.location.origin
            ? 'auth.entraSaved'
            : message('auth.entraSavedDifferentOrigin', { url: result.entra.publicUrl }),
      };
    });
  }
  return (
    <Card
      title={<LocalizedLabel message="auth.singleSignOn" />}
      icon={ShieldCheck}
      tone="blue"
      className="entra-card"
      actions={
        value && (
          <EnabledToggle
            value={value.enabled}
            disabled={busy}
            onChange={(enabled) => {
              if (!saved?.updatedAt) {
                setValue({ ...value, enabled });
                return;
              }
              void run(async () => {
                const result = await api<{ entra: EntraValue }>('/api/settings/entra', {
                  method: 'PATCH',
                  body: { enabled },
                });
                setSaved(result.entra);
                setValue((current) =>
                  current ? { ...current, enabled: result.entra.enabled } : current,
                );
                return {
                  kind: 'success',
                  text: enabled ? 'auth.entraEnabled' : 'auth.entraDisabled',
                };
              });
            }}
          />
        )
      }
    >
      <div className="entra-content">
        <FormNotice notice={notice} />
        {value && (
          <form className="settings-form" onSubmit={save}>
            <fieldset disabled={busy}>
              <div className="form-grid entra-sign-in-grid">
                <div>
                  <div className="checkbox-label entra-enabled-control">
                    <span>
                      <LocalizedLabel message="auth.enableEntra" />
                    </span>
                  </div>
                  <Field
                    label={<LocalizedLabel message="auth.publicUrl" />}
                    hint={
                      value.publicUrlSource === 'environment' ? (
                        <LocalizedLabel message="auth.managedByTheFTLPUBLICURLDeploymentSetting" />
                      ) : undefined
                    }
                    action={
                      value.publicUrlSource !== 'environment' ? (
                        <button
                          className="field-action-button"
                          type="button"
                          aria-label={t('auth.useCurrentUrl')}
                          title={t('auth.useCurrentUrl')}
                          onClick={() => setValue({ ...value, publicUrl: window.location.origin })}
                        >
                          <RefreshCw size={16} aria-hidden="true" />
                        </button>
                      ) : undefined
                    }
                  >
                    <input
                      type="url"
                      required
                      readOnly={value.publicUrlSource === 'environment'}
                      name="publicUrl"
                      value={value.publicUrl}
                      placeholder="https://your-app.example.com"
                      onChange={(event) => setValue({ ...value, publicUrl: event.target.value })}
                    />
                  </Field>
                </div>
                <div>
                  <label className="checkbox-label" title={t('auth.defaultAdminHint')}>
                    <input
                      name="entraDefaultAdmin"
                      type="checkbox"
                      checked={value.defaultAdmin ?? false}
                      onChange={(event) =>
                        setValue({ ...value, defaultAdmin: event.target.checked })
                      }
                    />
                    <span>
                      <LocalizedLabel message="auth.defaultAdmin" />
                    </span>
                  </label>
                  <Field
                    label={<LocalizedLabel message="auth.redirectUri" />}
                    action={
                      <button
                        className="field-action-button"
                        type="button"
                        aria-label={t('auth.copyRedirectUri')}
                        title={t('auth.copyRedirectUri')}
                        disabled={!callbackPreview}
                        onClick={async () =>
                          setNotice(
                            await copyText(
                              callbackPreview,
                              'auth.redirectUriCopied',
                              'auth.couldNotCopyAutomatically',
                            ),
                          )
                        }
                      >
                        <Copy size={16} aria-hidden="true" />
                      </button>
                    }
                  >
                    <input
                      readOnly
                      value={callbackPreview}
                      placeholder={t('auth.enterAValidPlatformURLFirst')}
                    />
                  </Field>
                </div>
              </div>
              <div className="form-grid three">
                <Field label={<LocalizedLabel message="auth.tenantIds" />}>
                  <input
                    name="allowedTenantIds"
                    required={value.enabled}
                    value={allowedTenants}
                    onChange={(event) => setAllowedTenants(event.target.value)}
                    placeholder={t('auth.tenantIdsHint')}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
                <Field label={<LocalizedLabel message="auth.clientId" />}>
                  <input
                    required
                    value={value.clientId}
                    onChange={(e) => setValue({ ...value, clientId: e.target.value })}
                  />
                </Field>
                <Field label={<LocalizedLabel message="auth.clientSecret" />}>
                  <SecretInput
                    name="clientSecret"
                    hasSavedValue={hasSavedSecret}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </Field>
              </div>
              <button className="button primary toolbar-button" type="submit">
                {busy ? (
                  <LocalizedLabel message="common.verifyingAndSaving" />
                ) : (
                  <LocalizedLabel message="auth.saveEntra" />
                )}
              </button>
            </fieldset>
          </form>
        )}
      </div>
    </Card>
  );
}

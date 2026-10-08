import { LocalizedLabel } from '../../components/LocalizedLabel';
import { t, useLocale, message } from '../../i18n';
import { useState } from 'react';
import { Database, FolderOpen, PlugZap, Save, ShieldCheck } from 'lucide-react';
import { LOG_CONTAINERS } from '../../../shared/settings';
import { Pill } from '../../components/Pill';
import type {
  SourceAuthMode,
  SourceInput,
  SourceInspection,
  SourceSettings as SourceValue,
} from '../../../shared/settings';
import { api, errorMessage } from '../../api';
import { Field, FormNotice, type Notice } from '../../components/Form';
import { SecretInput } from '../../components/SecretInput';
import { EnabledToggle } from '../../components/EnabledToggle';
import { Dialog } from '../../components/Dialog';
import { SectionTitle } from '../../components/SectionTitle';

export function SourceEditorDialog({
  source,
  onClose,
  onSaved,
  onStateChanged,
}: {
  source?: SourceValue;
  onClose: () => void;
  onSaved: (source: SourceValue) => void;
  onStateChanged: (source: SourceValue) => void;
}) {
  useLocale();
  const [mode, setMode] = useState<SourceAuthMode>(source?.authMode ?? 'connection_string');
  const [credential, setCredential] = useState('');
  const [endpoint, setEndpoint] = useState(source?.endpoint ?? '');
  const [clientId, setClientId] = useState(source?.managedIdentityClientId ?? '');
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [connections, setConnections] = useState<
    Partial<
      Record<
        SourceAuthMode,
        {
          key: string;
          inspection: SourceInspection;
        }
      >
    >
  >(() =>
    source
      ? {
          [source.authMode]: {
            key:
              source.authMode === 'connection_string'
                ? ''
                : JSON.stringify([source.endpoint, source.managedIdentityClientId]),
            inspection: {
              endpoint: source.endpoint,
              accountName: source.accountName,
              containers: source.availableContainers,
              verifiedAt: source.verifiedAt,
            },
          },
        }
      : {},
  );
  const connectionKey =
    mode === 'connection_string' ? credential : JSON.stringify([endpoint, clientId]);
  const connection = connections[mode]?.key === connectionKey ? connections[mode] : undefined;
  const inspection = connection?.inspection;
  const containers = inspection?.containers.map((item) => item.name) ?? [];
  const [busy, setBusy] = useState<'testing' | 'saving' | 'status' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  function payload(): SourceInput {
    return mode === 'connection_string'
      ? {
          authMode: mode,
          enabled,
          connectionString: credential,
          useSavedCredential:
            !credential && Boolean(source?.authMode === mode && source.hasConnectionString),
          containers: [],
        }
      : {
          authMode: mode,
          enabled,
          endpoint,
          managedIdentityClientId: clientId,
          containers: [],
        };
  }
  async function testConnection() {
    setBusy('testing');
    setNotice(null);
    try {
      const result = await api<SourceInspection>(
        `/api/settings/source/test${source ? `?sourceId=${encodeURIComponent(source.id)}` : ''}`,
        {
          method: 'POST',
          body: payload(),
        },
      );
      setConnections((current) => ({
        ...current,
        [mode]: {
          key: connectionKey,
          inspection: result,
        },
      }));
      setNotice({
        kind: result.containers.length ? 'success' : 'error',
        text: result.containers.length
          ? message('sources.connectionAvailable', { count: result.containers.length })
          : 'sources.connectedButNoSupportedDiagnosticLogContainersWere',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    setBusy('saving');
    setNotice(null);
    try {
      const unchanged =
        source &&
        mode === source.authMode &&
        (mode === 'connection_string'
          ? !credential
          : endpoint === source.endpoint && clientId === source.managedIdentityClientId) &&
        containers.length === source.containers.length &&
        containers.every((name) => source.containers.includes(name)) &&
        inspection?.verifiedAt === source.verifiedAt;
      const { source: saved } = unchanged
        ? enabled === source.enabled
          ? { source }
          : await api<{ source: SourceValue }>(
              `/api/settings/sources/${encodeURIComponent(source.id)}`,
              {
                method: 'PATCH',
                body: { enabled },
              },
            )
        : await api<{ source: SourceValue }>(
            source
              ? `/api/settings/sources/${encodeURIComponent(source.id)}`
              : '/api/settings/sources',
            { method: source ? 'PUT' : 'POST', body: payload() },
          );
      onSaved(saved);
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Dialog
      title={t(source ? 'sources.editSource' : 'sources.addSource')}
      subtitle={source?.accountName}
      icon={Database}
      busy={busy !== null}
      onClose={onClose}
      headerAction={
        <EnabledToggle
          value={enabled}
          disabled={busy !== null}
          onChange={async (next) => {
            if (!source) {
              setEnabled(next);
              return;
            }
            setBusy('status');
            setNotice(null);
            try {
              const result = await api<{ source: SourceValue }>(
                `/api/settings/sources/${encodeURIComponent(source.id)}`,
                { method: 'PATCH', body: { enabled: next } },
              );
              setEnabled(result.source.enabled);
              onStateChanged(result.source);
              setNotice({
                kind: 'success',
                text: next ? 'sources.sourceEnabled' : 'sources.sourceDisabled',
              });
            } catch (error) {
              setNotice({ kind: 'error', text: errorMessage(error) });
            } finally {
              setBusy(null);
            }
          }}
        />
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && containers.length) void save();
        }}
      >
        <fieldset disabled={busy !== null}>
          <div className="dialog-sections">
            <section
              className="dialog-section source-connection"
              aria-labelledby="source-connection-title"
            >
              <div className="source-section-heading">
                <SectionTitle id="source-connection-title" icon={ShieldCheck} tone="violet">
                  <LocalizedLabel message="sources.connectionSettings" />
                </SectionTitle>
              </div>
              <Field label={<LocalizedLabel message="sources.authMethod" />}>
                <select
                  value={mode}
                  onChange={(event) => {
                    setMode(event.target.value as SourceAuthMode);
                    setNotice(null);
                  }}
                >
                  <option value="connection_string">Connection String</option>
                  <option value="managed_identity">Managed Identity</option>
                </select>
              </Field>
              {mode === 'connection_string' ? (
                <Field label="Connection String">
                  <SecretInput
                    name="connectionString"
                    value={credential}
                    hasSavedValue={Boolean(source?.authMode === mode && source.hasConnectionString)}
                    placeholder="DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…"
                    onChange={(event) => {
                      setCredential(event.target.value);
                      setNotice(null);
                    }}
                  />
                </Field>
              ) : (
                <>
                  <Field label="Blob Endpoint">
                    <input
                      type="url"
                      name="endpoint"
                      placeholder="https://account.blob.core.windows.net"
                      value={endpoint}
                      onChange={(event) => {
                        setEndpoint(event.target.value);
                        setNotice(null);
                      }}
                    />
                  </Field>
                  <Field label="Client ID">
                    <input
                      name="clientId"
                      value={clientId}
                      onChange={(event) => {
                        setClientId(event.target.value);
                        setNotice(null);
                      }}
                      placeholder={t('sources.leaveBlankForTheSystemAssignedIdentity')}
                    />
                  </Field>
                </>
              )}
              <button
                type="button"
                className="button secondary toolbar-button source-test-button"
                onClick={testConnection}
              >
                <PlugZap size={14} aria-hidden="true" />
                {busy === 'testing' ? (
                  <LocalizedLabel message="sources.connecting" />
                ) : (
                  <LocalizedLabel message="sources.testConnection" />
                )}
              </button>
            </section>
            <section className="dialog-section" aria-labelledby="source-containers-title">
              <SectionTitle id="source-containers-title" icon={FolderOpen} tone="blue">
                <LocalizedLabel message="sources.logContainers" />
              </SectionTitle>
              <div className="source-containers" aria-live="polite">
                {LOG_CONTAINERS.map((item) => {
                  const detected = containers.includes(item.name);
                  return (
                    <div className="source-container-row" key={item.name} title={item.name}>
                      <div className="source-container-name">
                        <strong>{item.label}</strong>
                        {detected && (
                          <small>{t('sources.containerName', { name: item.name })}</small>
                        )}
                      </div>
                      <Pill
                        tone={
                          busy === 'testing' || !inspection
                            ? 'neutral'
                            : detected
                              ? 'success'
                              : 'warning'
                        }
                      >
                        <LocalizedLabel
                          message={
                            busy === 'testing'
                              ? 'sources.detecting'
                              : !inspection
                                ? 'sources.pendingDetection'
                                : detected
                                  ? 'sources.detected'
                                  : 'sources.notDetected'
                          }
                        />
                      </Pill>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={onClose}>
              <LocalizedLabel message="common.cancel" />
            </button>
            <button type="submit" className="button primary" disabled={containers.length === 0}>
              <Save size={16} aria-hidden="true" />
              {busy === 'saving' ? (
                <LocalizedLabel message="common.verifyingAndSaving" />
              ) : (
                <LocalizedLabel message="sources.save" />
              )}
            </button>
          </div>
        </fieldset>
      </form>
      <FormNotice notice={notice} />
    </Dialog>
  );
}

import { LocalizedLabel } from './LocalizedLabel';
import { t, useLocale, type DisplayMessage } from '../i18n';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { LogOut, UserRound } from 'lucide-react';
import { Link } from 'react-router';
import type { SessionUser } from '../../shared/settings';
import { api, errorMessage } from '../api';
import { FormNotice } from './Form';
import { LanguageSwitch } from './LanguageSwitch';
import { ScrollViewport } from './ScrollViewport';

export function UserMenu({
  user,
  version,
  active,
  onSignedOut,
}: {
  user: SessionUser;
  version?: string;
  active: 'account' | null;
  onSignedOut: () => void;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayMessage | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusLast = useRef(false);
  const menuId = useId();
  const displayName = user.name || user.email || t('auth.user');
  const initial = Array.from(displayName)[0]?.toLocaleUpperCase() ?? 'U';

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!busy && items?.length) items[focusLast.current ? items.length - 1 : 0].focus();
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, busy]);

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === ' ' && document.activeElement instanceof HTMLAnchorElement) {
      event.preventDefault();
      document.activeElement.click();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const versionLink = menuRef.current?.querySelector<HTMLAnchorElement>('.user-menu-version');
      const menuItems = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
      if (!event.shiftKey && document.activeElement !== versionLink && versionLink) {
        event.preventDefault();
        versionLink.focus();
      } else if (event.shiftKey && document.activeElement === versionLink && menuItems?.length) {
        event.preventDefault();
        menuItems[menuItems.length - 1].focus();
      } else close();
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
        ) ?? [],
      );
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
  }
  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/sign-out', { method: 'POST', body: {} });
      setOpen(false);
      onSignedOut();
    } catch (reason) {
      setError(errorMessage(reason));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="user-menu"
      ref={rootRef}
      onBlur={(event) => {
        if (!busy && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <FormNotice error={error} />
      {open && (
        <div className="user-menu-popover" ref={menuRef} onKeyDown={keyboard}>
          <ScrollViewport className="user-menu-viewport" contentClassName="user-menu-content">
            <div className="user-menu-identity">
              <div>
                <strong title={displayName}>{displayName}</strong>
                <small title={user.email || 'Microsoft Entra ID'}>
                  {user.email || 'Microsoft Entra ID'}
                </small>
              </div>
              <span className="user-avatar" aria-hidden="true">
                {initial}
              </span>
            </div>
            <div id={menuId} role="menu" aria-label={t('auth.userActions')}>
              <Link
                to="/account"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={busy || undefined}
                aria-current={active === 'account' ? 'page' : undefined}
                onClick={(event) => {
                  if (busy) {
                    event.preventDefault();
                    return;
                  }
                  close(event.detail === 0);
                }}
              >
                <UserRound size={17} strokeWidth={1.7} />
                <span>
                  <LocalizedLabel message="navigation.account" />
                </span>
              </Link>
              <LanguageSwitch menu />
              <button
                type="button"
                className="destructive"
                role="menuitem"
                tabIndex={-1}
                disabled={busy}
                onClick={() => void signOut()}
              >
                <LogOut size={17} strokeWidth={1.7} />
                <span>
                  {busy ? (
                    <LocalizedLabel message="auth.signingOut" />
                  ) : (
                    <LocalizedLabel message="auth.signOut" />
                  )}
                </span>
              </button>
            </div>
            <div className="user-menu-divider" role="separator" />
            {version && (
              <a
                className="user-menu-version"
                href="https://github.com/HeyJiqingCode/FoundryTokenLens"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('navigation.version', { version })}
              </a>
            )}
          </ScrollViewport>
        </div>
      )}
      <div className="user-menu-footer">
        <button
          type="button"
          ref={triggerRef}
          className="user-menu-trigger"
          title={t('auth.userMenu')}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={busy}
          onClick={() => {
            focusLast.current = false;
            setError(null);
            setOpen(!open);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              focusLast.current = event.key === 'ArrowUp';
              setError(null);
              setOpen(true);
            }
          }}
        >
          <span className="user-avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="user-menu-label">
            <strong title={displayName}>{displayName}</strong>
            <small title={user.email || 'Microsoft Entra ID'}>
              {user.email || 'Microsoft Entra ID'}
            </small>
          </span>
        </button>
      </div>
    </div>
  );
}

import { Component, type ReactNode } from 'react';
import { t, useLocale } from '../i18n';
import { StatusMessage, StatusScreen } from './StatusScreen';

function Recovery({ screen }: { screen: boolean }) {
  useLocale();
  const props = {
    title: t('errors.pageFailed'),
    text: t('errors.pageFailedHint'),
    action: { label: t('errors.retryPage'), onClick: () => window.location.reload() },
  };
  return screen ? <StatusScreen {...props} /> : <StatusMessage {...props} />;
}
/** `screen` fills the window when the whole application fails; otherwise the page area recovers alone. */
export class ErrorBoundary extends Component<
  { children: ReactNode; screen?: boolean },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <Recovery screen={Boolean(this.props.screen)} />
    ) : (
      this.props.children
    );
  }
}

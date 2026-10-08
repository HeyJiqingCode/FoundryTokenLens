import { useLocale } from '../../i18n';
import type { SettingsSection } from '../../../shared/navigation';
import type { SessionUser } from '../../../shared/settings';
import { DataManagement } from './DataManagement';
import { PriceSettings } from './prices/PriceSettings';
import { UserSettings } from './UserSettings';
import type { IngestionStatus } from '../../../shared/ingestion';
import { PlatformSettings } from './PlatformSettings';

export function SettingsPanel({
  section,
  user,
  onUserChanged,
  ingestion,
  onImportChanged,
}: {
  section: SettingsSection;
  user: SessionUser;
  onUserChanged: () => void;
  ingestion: IngestionStatus | null;
  onImportChanged: () => void;
}) {
  useLocale();
  // The route renders only the sections this user may open: everything for administrators,
  // the platform section (read-only) for other users.
  switch (section) {
    case 'data':
      return <DataManagement ingestion={ingestion} onImportChanged={onImportChanged} />;
    case 'prices':
      return <PriceSettings />;
    case 'users':
      return <UserSettings user={user} onUserChanged={onUserChanged} />;
    case 'platform':
      return (
        <PlatformSettings
          ingestion={ingestion}
          canEdit={user.role === 'admin'}
          onImportChanged={onImportChanged}
        />
      );
  }
}

import type { IngestionStatus } from '../../../shared/ingestion';
import type { SourceSettings as SourceValue } from '../../../shared/settings';
import { useState } from 'react';
import { useApiResource } from '../../components/useApiResource';
import { SourceSettings } from './SourceSettings';
import { TaskSettings } from './TaskSettings';

export function DataManagement({
  ingestion,
  onImportChanged,
}: {
  ingestion: IngestionStatus | null;
  onImportChanged: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const { data, error, loading } = useApiResource<{ sources: SourceValue[] }>(
    '/api/settings/sources',
    revision,
  );
  const sources = data?.sources ?? [];
  return (
    <>
      <SourceSettings
        sources={sources}
        loading={loading}
        error={error}
        onChanged={() => setRevision((value) => value + 1)}
      />
      {/* Deleting a source also unlinks it from tasks, so tasks reload with the sources. */}
      <TaskSettings
        sources={sources}
        revision={revision}
        ingestion={ingestion}
        onImportChanged={onImportChanged}
      />
    </>
  );
}

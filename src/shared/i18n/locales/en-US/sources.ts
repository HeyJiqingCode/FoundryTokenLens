import type source from '../zh-CN/sources.js';
import type { LocaleMessages } from '../../types.js';

export default {
  'sources.sourceEnabled': 'Data source enabled.',
  'sources.sourceDisabled': 'Data source disabled.',
  'sources.containerName': 'Container name: {name}',
  'sources.pendingDetection': 'Pending',
  'sources.detecting': 'Identifying',
  'sources.detected': 'Identified',
  'sources.notDetected': 'Not identified',
  'sources.refreshStatistics': 'Refresh file statistics',
  'sources.statisticsUpdatedAt': 'Last updated: {time}; click to refresh',
  'sources.volumeSummary': 'File count: {count}, Storage used: {size}',
  'sources.loadingStatistics': 'Loading…',
  'sources.statisticsFailed': 'File statistics unavailable',
  'sources.addSource': 'Add data source',
  'sources.editSource': 'Edit data source',
  'sources.deleteSource': 'Delete data source',
  'sources.sourceDeleted': 'Data source deleted.',
  'sources.sourceNotFound': 'Data source not found or already deleted.',
  'sources.alreadyExists': 'This Blob storage is already connected. Edit the existing source.',
  'sources.connectionSettings': 'Connection settings',
  'sources.blobStorage': 'Data sources',
  'sources.authMethod': 'Authentication',
  'sources.confirmName': 'Confirm Blob name',
  'sources.accountNameCopied': 'Blob name copied.',
  'sources.confirmationMismatch': 'The Blob name does not match.',
  'sources.deleteNotice':
    'Deleting stops imports and removes this source from reports. Imported logs remain available if you reconnect the same Blob storage.',
  'sources.noSources': 'No data sources yet',
  'sources.noSourcesHint': 'Add Blob storage containing Foundry diagnostic logs.',
  'sources.cannotDecryptTheSavedCredentials':
    'Cannot decrypt the saved credentials. Restore the original key or enter the connection string again.',
  'sources.cloudBlobConnectionsMustUseHTTPS': 'Cloud Blob connections must use HTTPS.',
  'sources.connectedButNoSupportedDiagnosticLogContainersWere':
    'Connected, but no supported diagnostic log containers were found. Check your Foundry diagnostic settings.',
  'sources.connecting': 'Connecting…',
  'sources.connectionAvailable': {
    one: 'Connected. {count} log container is available.',
    other: 'Connected. {count} log containers are available.',
  },
  'sources.connectionFailed':
    'Connection failed. Check the connection string, network and Storage access settings.',
  'sources.connectionTimedOut': 'Connection timed out. Check the Blob endpoint and network rules.',
  'sources.blobDataPermissionMissing':
    "Signed in, but without permission to read blob data. Assign the Storage Blob Data Reader role on the storage account to the managed identity (Reader and Contributor don't include data access); it can take a few minutes to apply. A SAS must include read and list permissions.",
  'sources.containerAccessFailed':
    'Cannot read log containers. Check Blob read/list permissions and Storage network rules.',
  'sources.containerCredentialsFailed':
    'Cannot read log containers. Check credentials, Blob read/list permissions and Storage network rules.',
  'sources.enterAConnectionString': 'Enter a connection string.',
  'sources.enterTheFullBlobEndpoint': 'Enter the full Blob endpoint.',
  'sources.invalidConnectionStringFormat': 'Invalid connection string format.',
  'sources.leaveBlankForTheSystemAssignedIdentity': 'Leave blank for the system-assigned identity.',
  'sources.logContainers': 'Diagnostic logs',
  'sources.managedIdentityAuthenticationFailed':
    'Managed Identity authentication failed. Ensure the identity is enabled and has Blob read access.',
  'sources.managedIdentityRequiresAValidAzureStorageHTTPS':
    'Managed Identity requires a valid Azure Storage HTTPS Blob endpoint.',
  'sources.noSavedConnectionStringIsAvailable':
    'No saved connection string is available. Enter it again.',
  'sources.savedCredentialNeedsSource': 'Choose a data source to reuse its saved credential.',
  'sources.save': 'Save data source',
  'sources.saved': 'Data source saved.',
  'sources.selectAtLeastOneLogContainer': 'Select at least one log container.',
  'sources.testConnection': 'Test connection',
  'sources.unsupportedLogContainer': 'Unsupported log container.',
} satisfies LocaleMessages<typeof source>;

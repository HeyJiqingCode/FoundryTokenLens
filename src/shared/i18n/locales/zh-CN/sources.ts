import type { MessageValue } from '../../types.js';

export default {
  'sources.sourceEnabled': '数据源已启用。',
  'sources.sourceDisabled': '数据源已禁用。',
  'sources.containerName': '容器名称：{name}',
  'sources.pendingDetection': '待识别',
  'sources.detecting': '识别中',
  'sources.detected': '已识别',
  'sources.notDetected': '未识别到',
  'sources.refreshStatistics': '刷新文件统计',
  'sources.statisticsUpdatedAt': '上次更新：{time}；点击刷新',
  'sources.volumeSummary': '文件数量：{count}，存储量：{size}',
  'sources.loadingStatistics': '正在读取…',
  'sources.statisticsFailed': '文件统计暂不可用',
  'sources.addSource': '添加数据源',
  'sources.editSource': '编辑数据源',
  'sources.deleteSource': '删除数据源',
  'sources.sourceDeleted': '数据源已删除。',
  'sources.sourceNotFound': '数据源不存在或已被删除。',
  'sources.alreadyExists': '这个 Blob 存储已经添加，请编辑现有数据源。',
  'sources.connectionSettings': '连接设置',
  'sources.blobStorage': '数据源',
  'sources.authMethod': '认证方式',
  'sources.confirmName': '确认 Blob 名称',
  'sources.accountNameCopied': 'Blob 名称已复制。',
  'sources.confirmationMismatch': '确认的 Blob 名称不一致。',
  'sources.deleteNotice':
    '删除后不再导入或展示该数据源的数据。已处理的日志数据会保留，重新关联同一 Blob 存储后可继续使用。',
  'sources.noSources': '尚未添加数据源',
  'sources.noSourcesHint': '添加保存 Foundry 诊断日志的 Blob 存储。',
  'sources.cannotDecryptTheSavedCredentials':
    '无法解密已保存的凭据，请恢复原密钥或重新输入连接字符串。',
  'sources.cloudBlobConnectionsMustUseHTTPS': '云端 Blob 连接必须使用 HTTPS。',
  'sources.connectedButNoSupportedDiagnosticLogContainersWere':
    '连接成功，但未检测到支持的诊断日志容器。请检查 Foundry 诊断设置。',
  'sources.connecting': '正在连接…',
  'sources.connectionAvailable': '连接成功，可读取 {count} 个日志容器。',
  'sources.connectionFailed': '连接失败，请检查连接字符串、网络和 Storage 访问设置。',
  'sources.connectionTimedOut': '连接超时，请检查 Blob Endpoint 和网络访问规则。',
  'sources.blobDataPermissionMissing':
    '身份验证已通过，但没有读取 Blob 数据的权限。请在存储账户上为托管身份分配 Storage Blob Data Reader 角色（Reader、Contributor 不含数据权限），分配后可能需要几分钟生效；使用 SAS 时需包含读取和列举权限。',
  'sources.containerAccessFailed':
    '无法读取日志容器，请检查 Blob 读取/列举权限及 Storage 网络访问规则。',
  'sources.containerCredentialsFailed':
    '无法读取日志容器：请检查凭据、Blob 读取/列举权限及 Storage 网络访问规则。',
  'sources.enterAConnectionString': '请输入连接字符串。',
  'sources.enterTheFullBlobEndpoint': '填写完整的 Blob Endpoint。',
  'sources.invalidConnectionStringFormat': '连接字符串格式不正确。',
  'sources.leaveBlankForTheSystemAssignedIdentity': '留空使用系统分配身份。',
  'sources.logContainers': '诊断日志',
  'sources.managedIdentityAuthenticationFailed':
    'Managed Identity 验证失败。请确认部署环境已启用该身份，并已授予 Blob 读取权限。',
  'sources.managedIdentityRequiresAValidAzureStorageHTTPS':
    'Managed Identity 需要有效的 Azure Storage HTTPS Blob Endpoint。',
  'sources.noSavedConnectionStringIsAvailable': '没有可复用的连接字符串，请重新填写。',
  'sources.savedCredentialNeedsSource': '复用已保存的凭据时必须指定数据源。',
  'sources.save': '保存数据源',
  'sources.saved': '数据源已保存。',
  'sources.selectAtLeastOneLogContainer': '至少选择一个日志容器。',
  'sources.testConnection': '测试连接',
  'sources.unsupportedLogContainer': '不支持的日志容器',
} as const satisfies Record<string, MessageValue>;

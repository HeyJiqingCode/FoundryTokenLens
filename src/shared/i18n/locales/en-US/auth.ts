import type source from '../zh-CN/auth.js';
import type { LocaleMessages } from '../../types.js';

export default {
  'auth.loadingSession': 'Loading…',

  'auth.saveEntraFirst': 'Save the complete Microsoft Entra ID configuration first.',
  'auth.entraEnabled': 'Microsoft Entra ID sign-in enabled.',
  'auth.deletionNotice': '{account} {organization}',
  'auth.clientId': 'Client ID',
  'auth.clientSecret': 'Client secret',
  'auth.tenantIds': 'Tenant ID',
  'auth.accessDenied': 'Access denied',
  'auth.accountSettings': 'Account settings',
  'auth.activeAdminRequired': 'At least one administrator must remain enabled.',
  'auth.addUser': 'Add user',
  'auth.admin': 'Admin',
  'auth.administratorIsAlreadyInitialized': 'The administrator is already initialized.',
  'auth.administratorPermissionsHaveChanged':
    'Your administrator permissions have changed. Sign in again.',
  'auth.cannotVerifyTheEntraTenant':
    'Cannot verify the Entra tenant. Check the tenant ID and server network.',
  'auth.confirmDeletion': 'Confirm deletion',
  'auth.confirmDisplayName': 'Confirm display name',
  'auth.confirmEmail': 'Confirm email',
  'auth.confirmNewPassword': 'Confirm password',
  'auth.confirmPassword': 'Confirm password',
  'auth.confirmationDoesNotMatchTheUserBeingDeleted':
    'The confirmation does not match the user being deleted. Check and try again.',
  'auth.copyDisplayName': 'Copy display name',
  'auth.copyEmail': 'Copy email',
  'auth.copyRedirectUri': 'Copy redirect URI',
  'auth.couldNotCopy': 'Could not copy. Select and copy the text manually.',
  'auth.couldNotCopyAutomatically':
    'Could not copy automatically. Select and copy the redirect URI manually.',
  'auth.couldNotRetrieveOrValidateTheMicrosoftUser':
    'Could not retrieve or validate the Microsoft user identity. Sign in again; if it still fails, contact an administrator.',
  'auth.createAndSignIn': 'Create and sign in',
  'auth.createUser': 'Create user',
  'auth.currentPassword': 'Current password',
  'auth.currentUserBadge': ' · Current user',
  'auth.defaultAdmin': 'Make new users admins',
  'auth.defaultAdminHint': 'Applies only to Entra users signing in for the first time',
  'auth.deleteNamedUser': 'Delete {name}',
  'auth.deleteUser': 'Delete user',
  'auth.displayName': 'Display name',
  'auth.displayNameCopied': 'Display name copied.',
  'auth.editNamedUser': 'Edit {name}',
  'auth.editUser': 'Edit user',
  'auth.email': 'Email',
  'auth.emailCopied': 'Email copied.',
  'auth.emailIsAlreadyInUse': 'This email is already in use.',
  'auth.enableEntra': 'Enable Microsoft Entra ID sign-in (multitenant support)',
  'auth.enterAClientSecret':
    'Enter a client secret. A new secret is required when changing the app.',
  'auth.enterAUsableEmailAddress': 'Enter a usable email address.',
  'auth.enterAValidEmailAddress': 'Enter a valid email address.',
  'auth.enterAValidEmailAndYourCurrentPassword': 'Enter a valid email and your current password.',
  'auth.enterAValidPlatformURL': 'Enter a valid platform URL.',
  'auth.enterAValidPlatformURLFirst': 'Enter a valid platform URL first',
  'auth.enterAValidTenantID': 'Enter a valid tenant ID.',
  'auth.enterAtLeastOneAllowedTenantID': 'Enter at least one allowed tenant ID.',
  'auth.enterOnlyTheProtocolHostAndOptionalPort':
    'Enter only the protocol, host and optional port. Do not include a path, query or fragment.',
  'auth.enterThePasswordAgain': 'Enter the password again',
  'auth.enterYourCurrentPasswordToChangeYourEmail':
    'Enter your current password to change your email.',
  'auth.entraDisabled': 'Entra settings saved. Entra sign-in is disabled.',
  'auth.entraOrganizationAccountIsUnaffected':
    'The Entra organization account is unaffected. Signing in again creates a new platform account. Use Disable to block sign-in.',
  'auth.entraSaved': 'Settings saved. Entra users need to sign in again.',
  'auth.entraSavedDifferentOrigin': 'Settings saved. Open {url} to sign in with Microsoft.',
  'auth.entraSignInIsNotEnabled': 'Entra sign-in is not enabled.',
  'auth.entraSignInSettingsHaveChanged':
    'Entra sign-in settings have changed. Sign in with Microsoft again.',
  'auth.entraSignInWasNotCompleted':
    'Entra sign-in was not completed. Check your organization account, tenant settings and app consent, or sign in with a local account.',
  'auth.initialLocalAdministratorCannotBeDeleted':
    'The initial local administrator cannot be deleted.',
  'auth.initialLocalAdministratorSRoleCannotBeChanged':
    "The initial local administrator's role cannot be changed.",
  'auth.initialPassword': 'Initial password',
  'auth.invalidCredentials': 'Incorrect email or password.',
  'auth.invalidCurrentPassword': 'Incorrect current password.',
  'auth.invalidPlatformURL': 'Invalid platform URL.',
  'auth.lastAdminRequired': 'At least one administrator must remain enabled.',
  'auth.lastLocalAdminRequired': 'At least one local administrator must remain enabled.',
  'auth.loadingUsers': 'Loading users…',
  'auth.localAdminBadge': ' · Local admin',
  'auth.managedByMicrosoftEntraID': 'Managed by Microsoft Entra ID.',
  'auth.managedByTheFTLPUBLICURLDeploymentSetting':
    'Managed by the FTL_PUBLIC_URL deployment setting.',
  'auth.microsoftAuthorizationCodeExchangeFailed':
    'Microsoft authorization code exchange failed. Check the app configuration, client secret and server network.',
  'auth.microsoftDidNotReturnAnIDToken':
    'Microsoft did not return an ID token. Check the app’s OpenID Connect configuration.',
  'auth.microsoftIDTokenValidationFailed':
    'Microsoft ID token validation failed. Sign in again; if it still fails, contact an administrator.',
  'auth.microsoftReturnedIncompleteUserIdentityInformation':
    'Microsoft returned incomplete user identity information. Contact an administrator.',
  'auth.microsoftSignInSessionExpired':
    'The Microsoft sign-in session expired. Start Microsoft sign-in again.',
  'auth.namedUserRole': 'Role for {name}',
  'auth.newPassword': 'Password',
  'auth.newPasswordsDoNotMatch': 'The new passwords do not match.',
  'auth.noEmail': 'No email provided',
  'auth.onlyAdministratorsCanChangePlatformSettings':
    'Only administrators can change platform settings.',
  'auth.onlyEntraOrganizationTenantsAreSupported': 'Only Entra organization tenants are supported.',
  'auth.organizationEmailIsManagedByMicrosoftEntraID':
    'Organization email is managed by Microsoft Entra ID.',
  'auth.organizationIsNotAllowedToSignInTo':
    'Your organization is not allowed to sign in to this platform. Contact an administrator.',
  'auth.organizationPasswordsAreManagedByMicrosoftEntraID':
    'Organization passwords are managed by Microsoft Entra ID.',
  'auth.pageIsAvailableToAdministratorsOnly': 'This page is available to administrators only.',
  'auth.password': 'Password',
  'auth.passwordChanged': 'Password updated. Other sessions have been revoked.',
  'auth.passwordLengthHint': '{min}–{max} characters',
  'auth.passwordReset': 'Password reset.',
  'auth.passwordSecurity': 'Password and security',
  'auth.passwordsAndMFAAreManagedByMicrosoftEntra':
    'Passwords and MFA are managed by Microsoft Entra ID.',
  'auth.passwordsDoNotMatch': 'The passwords do not match.',
  'auth.platformAccountAndItsSignInCredentialsWill':
    'The platform account and its sign-in credentials will be removed, and existing sessions will be revoked. Historical logs, usage and cost data are retained.',
  'auth.platformURLCannotContainAUsernameOrPassword':
    'The platform URL cannot contain a username or password.',
  'auth.platformURLIsManagedByFTLPUBLICURL':
    'The platform URL is managed by FTL_PUBLIC_URL. Update the deployment settings.',
  'auth.profile': 'Profile',
  'auth.profilePartiallySaved': 'Email updated, but the display name could not be saved: {error}',
  'auth.profileSaved': 'Profile updated.',
  'auth.publicUrl': 'Platform URL',
  'auth.readOnly': 'Read-only',
  'auth.reconnect': 'Reconnect',
  'auth.recoveryAdminRequired':
    'At least one local administrator must remain enabled for recovery.',
  'auth.redirectUri': 'Redirect URI',
  'auth.redirectUriCopied': 'Redirect URI copied.',
  'auth.requestOriginIsNotAllowed': 'Request origin is not allowed. Use the platform interface.',
  'auth.resetPassword': 'Reset password',
  'auth.role': 'Role',
  'auth.roleUpdated': 'User role updated.',
  'auth.saveEntra': 'Save Entra settings',
  'auth.saveProfile': 'Save profile',
  'auth.signIn': 'Sign in',
  'auth.signInAndAccess': 'Sign-in and access',
  'auth.signInFirst': 'Sign in first.',
  'auth.signInTitle': 'Sign in · Foundry Token Lens',
  'auth.signInWithMicrosoft': 'Sign in with Microsoft',
  'auth.signOut': 'Sign out',
  'auth.signingOut': 'Signing out…',
  'auth.singleSignOn': 'Single sign-on',
  'auth.tenantIdsHint': 'Separate tenant IDs with ;',
  'auth.updatePassword': 'Update password',
  'auth.useCanonicalOrigin':
    'Open {url} before signing in with Microsoft so the session and callback use the same address.',
  'auth.useCurrentUrl': 'Use current address',
  'auth.useHTTPSForHostedDeployments':
    'Use HTTPS for hosted deployments. HTTP is allowed only for localhost or 127.0.0.1.',
  'auth.useLocalhostOr127001For':
    'Use localhost or 127.0.0.1 for the Entra callback, rather than an IPv6 loopback address.',
  'auth.user': 'User',
  'auth.userActions': 'User actions',
  'auth.userBanned': 'This account is disabled. Contact an administrator.',
  'auth.userCreated': 'User created.',
  'auth.userDeleted': 'User deleted.',
  'auth.userDetails': 'User details',
  'auth.userDisabled': 'User disabled.',
  'auth.userEnabled': 'User enabled.',
  'auth.userList': 'User list',
  'auth.userMenu': 'User menu',
  'auth.userNotFound': 'User not found.',
  'auth.users': 'Users',
  'auth.youCanEnterUpTo20Tenants': 'You can enter up to 20 tenants.',
  'auth.youCannotChangeYourOwnRole': 'You cannot change your own role. Ask another administrator.',
  'auth.youCannotDeleteYourOwnAccount': 'You cannot delete your own account.',
  'auth.youCannotDisableYourOwnAccount':
    'You cannot disable your own account. Ask another administrator.',
} satisfies LocaleMessages<typeof source>;

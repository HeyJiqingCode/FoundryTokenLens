const MICROSOFT_CALLBACK_PATH = '/api/auth/callback/microsoft';

export function normalizePublicUrl(value: string): string {
  const input = value.trim();
  if (input.length > 2048 || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(input)) {
    throw new Error('auth.enterOnlyTheProtocolHostAndOptionalPort');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('auth.enterAValidPlatformURL');
  }
  if (url.username || url.password)
    throw new Error('auth.platformURLCannotContainAUsernameOrPassword');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('auth.useHTTPSForHostedDeployments');
  }
  if (url.hostname === '[::1]') throw new Error('auth.useLocalhostOr127001For');
  return url.origin;
}

export function microsoftCallbackUrl(publicUrl: string): string {
  return `${normalizePublicUrl(publicUrl)}${MICROSOFT_CALLBACK_PATH}`;
}

type OriginPolicyInput = {
  origin: string | null;
  requestUrl: string;
  host?: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  allowedOrigins?: string[];
  allowedExtensionIds?: string[];
};

type ContentSecurityPolicyOptions = {
  nonce: string;
  development?: boolean;
  upgradeInsecureRequests?: boolean;
};

type RequestTransportInput = {
  requestUrl: string;
  forwardedProto?: string | null;
  trustProxy?: boolean;
};

const PUBLIC_APP_PATHS = new Set([
  '/login',
  '/api/health',
  '/api/health/live',
  '/api/health/ready',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icons/bonds-192.png',
  '/icons/bonds-512.png',
  '/sw.js',
  '/offline.html',
  '/offline.css',
  '/robots.txt',
]);

export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  if (!/^[A-Za-z0-9+/_=-]{16,256}$/.test(options.nonce)) {
    throw new TypeError('Content Security Policy nonce is invalid.');
  }

  const scriptSources = [
    "'self'",
    `'nonce-${options.nonce}'`,
    "'strict-dynamic'",
    ...(options.development ? ["'unsafe-eval'"] : []),
  ];
  const styleSources = options.development
    ? ["'self'", "'unsafe-inline'"]
    : ["'self'", `'nonce-${options.nonce}'`];
  const connectSources = ["'self'", ...(options.development ? ['ws:', 'wss:'] : [])];
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    "script-src-attr 'none'",
    `style-src ${styleSources.join(' ')}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (options.upgradeInsecureRequests) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export function trustsProxyHeaders(
  environment: Record<string, string | undefined> = process.env
): boolean {
  const value = environment.CRM_TRUST_PROXY_HEADERS;
  return value === '1' || value?.toLowerCase() === 'true';
}

export function isPublicAppPath(pathname: string): boolean {
  return PUBLIC_APP_PATHS.has(pathname) || pathname.startsWith('/api/auth/');
}

function firstForwardedValue(value: string | null | undefined): string | null {
  return value?.split(',')[0]?.trim() || null;
}

export function isRequestSecure(input: RequestTransportInput): boolean {
  const directSecure = new URL(input.requestUrl).protocol === 'https:';
  if (!input.trustProxy) return directSecure;

  const forwardedProtocol = firstForwardedValue(input.forwardedProto)?.toLowerCase().replace(/:$/, '');
  if (forwardedProtocol === 'https') return true;
  if (forwardedProtocol === 'http') return false;
  return directSecure;
}

function normalizeWebOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function getRequestOrigins(input: OriginPolicyInput): Set<string> {
  const origins = new Set<string>();
  const requestUrl = new URL(input.requestUrl);
  origins.add(requestUrl.origin);

  const publicHost = firstForwardedValue(input.forwardedHost) || input.host;
  const publicProtocol = firstForwardedValue(input.forwardedProto) || requestUrl.protocol;
  if (publicHost && (publicProtocol === 'http' || publicProtocol === 'https' || publicProtocol === 'http:' || publicProtocol === 'https:')) {
    const protocol = publicProtocol.endsWith(':') ? publicProtocol : `${publicProtocol}:`;
    const publicOrigin = normalizeWebOrigin(`${protocol}//${publicHost}`);
    if (publicOrigin) origins.add(publicOrigin);
  }

  return origins;
}

export function isRequestOriginAllowed(input: OriginPolicyInput): boolean {
  if (!input.origin) return true;

  if (input.origin.startsWith('chrome-extension://')) {
    const extensionId = input.origin.slice('chrome-extension://'.length).replace(/\/$/, '');
    return Boolean(extensionId) && (input.allowedExtensionIds || []).includes(extensionId);
  }

  const origin = normalizeWebOrigin(input.origin);
  if (!origin) return false;
  if (getRequestOrigins(input).has(origin)) return true;

  return (input.allowedOrigins || []).some((allowedOrigin) => (
    normalizeWebOrigin(allowedOrigin) === origin
  ));
}

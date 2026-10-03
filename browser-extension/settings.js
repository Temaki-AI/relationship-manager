export const DEFAULT_API_BASE_URL = 'http://localhost:3100';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeApiBaseUrl(value) {
  const candidate = typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_API_BASE_URL;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Enter a complete CRM URL, including https://.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The CRM URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('The CRM URL cannot contain a username or password.');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Enter only the CRM origin, without a path, query, or fragment.');
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())) {
    throw new Error('Remote CRM URLs must use HTTPS.');
  }

  return url.origin;
}

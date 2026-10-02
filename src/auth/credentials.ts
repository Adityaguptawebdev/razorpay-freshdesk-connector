import { inspect } from 'node:util';
import { REDACTED } from '../utils/redact.js';

const FRESHDESK_HOST_SUFFIX = '.freshdesk.com';
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PLACEHOLDER_KEYS = new Set(['your_api_key_here', 'changeme', 'xxx']);

/** Validation failure. Messages never include the API key value. */
export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

/**
 * Freshdesk API-key credentials bound to a single, validated Freshdesk host.
 *
 * - The key is held in a private field and is never serialised: JSON.stringify,
 *   console.log and util.inspect all print a redacted form.
 * - The host is restricted to `<subdomain>.freshdesk.com` over HTTPS, so a
 *   misconfiguration cannot send the key to an arbitrary server.
 */
export class FreshdeskCredentials {
  /** Fully qualified host, e.g. "acme.freshdesk.com". */
  readonly host: string;
  /** Origin every request must go to, e.g. "https://acme.freshdesk.com". */
  readonly origin: string;
  readonly #apiKey: string;

  constructor(domain: string, apiKey: string) {
    this.host = normalizeFreshdeskHost(domain);
    this.origin = `https://${this.host}`;
    this.#apiKey = validateApiKey(apiKey);
  }

  /**
   * Freshdesk uses HTTP Basic auth with the API key as the username and any
   * placeholder ("X") as the password.
   */
  authorizationHeader(): string {
    return `Basic ${this.#encodedPair()}`;
  }

  /** Values a logger or error formatter must scrub. */
  secrets(): string[] {
    return [this.#apiKey, this.#encodedPair()];
  }

  toJSON(): Record<string, string> {
    return { host: this.host, apiKey: REDACTED };
  }

  toString(): string {
    return `FreshdeskCredentials(${this.host}, apiKey=${REDACTED})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }

  #encodedPair(): string {
    return Buffer.from(`${this.#apiKey}:X`, 'utf8').toString('base64');
  }
}

/**
 * Accepts "acme", "acme.freshdesk.com" or "https://acme.freshdesk.com" and
 * returns "acme.freshdesk.com". Anything else is rejected.
 */
export function normalizeFreshdeskHost(domain: string): string {
  const raw = domain.trim().toLowerCase();
  if (raw === '') {
    throw new CredentialsError('FRESHDESK_DOMAIN is empty.');
  }

  let host = raw;
  if (raw.includes('://')) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new CredentialsError('FRESHDESK_DOMAIN is not a valid URL or subdomain.');
    }
    if (url.protocol !== 'https:') {
      throw new CredentialsError('FRESHDESK_DOMAIN must use https://.');
    }
    if (url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
      throw new CredentialsError(
        'FRESHDESK_DOMAIN must be a bare Freshdesk host without credentials, port, path or query.',
      );
    }
    host = url.hostname;
  } else {
    host = raw.replace(/\/+$/, '');
  }

  if (!host.includes('.')) {
    host = `${host}${FRESHDESK_HOST_SUFFIX}`;
  }

  const subdomain = host.endsWith(FRESHDESK_HOST_SUFFIX)
    ? host.slice(0, -FRESHDESK_HOST_SUFFIX.length)
    : undefined;

  if (subdomain === undefined || !SUBDOMAIN_PATTERN.test(subdomain)) {
    throw new CredentialsError(
      'FRESHDESK_DOMAIN must be your Freshdesk subdomain, e.g. "acme" or "acme.freshdesk.com". ' +
        'Only *.freshdesk.com hosts are allowed.',
    );
  }

  return host;
}

function validateApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key === '') {
    throw new CredentialsError('FRESHDESK_API_KEY is empty.');
  }
  if (PLACEHOLDER_KEYS.has(key.toLowerCase())) {
    throw new CredentialsError(
      'FRESHDESK_API_KEY still contains the placeholder value from .env.example.',
    );
  }
  // Printable ASCII only, and no characters that would break Basic auth (":")
  // or be escaped in JSON logs (quotes, backslashes) and so slip past redaction.
  if (key.length < 8 || key.length > 256 || !/^[\x21-\x7E]+$/.test(key) || /[:"\\]/.test(key)) {
    throw new CredentialsError(
      'FRESHDESK_API_KEY has an unexpected format (expected 8-256 printable characters ' +
        'with no spaces, colons, quotes or backslashes).',
    );
  }
  return key;
}

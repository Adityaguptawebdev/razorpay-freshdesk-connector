export const REDACTED = '[REDACTED]';

/** Secrets shorter than this are not redacted to avoid mangling ordinary text. */
const MIN_SECRET_LENGTH = 6;

/**
 * Builds a function that replaces every occurrence of the given secrets.
 * Used on log lines and on every error message that leaves the process.
 */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const active = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  if (active.length === 0) return (text) => text;

  return (text) => active.reduce((result, secret) => result.split(secret).join(REDACTED), text);
}

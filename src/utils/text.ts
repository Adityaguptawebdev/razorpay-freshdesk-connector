/**
 * Caps long free-text fields so a single ticket cannot flood the agent's context window.
 * The marker tells the agent (and a human reading the transcript) that text was cut.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const omitted = text.length - maxLength;
  return `${text.slice(0, maxLength)}… [truncated ${omitted} characters]`;
}

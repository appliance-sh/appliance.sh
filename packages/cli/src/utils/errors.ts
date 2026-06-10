import chalk from 'chalk';

/** True when the error is @inquirer/prompts' Ctrl-C cancellation —
 *  cosmetically an abort, not a failure worth a red stack trace. */
export function isPromptCancel(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError';
}

/** One-line remediation hint for the most common API/network failure
 *  shapes, or null when the raw message has to speak for itself. */
export function remediationHint(message: string, apiUrl?: string): string | null {
  if (/\b401\b|unauthoriz|signature|invalid key/i.test(message)) {
    return 'Authentication failed — run `appliance login` to refresh credentials, or check the active profile with `appliance whoami`.';
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return 'This API key is not allowed to do that — check which profile is active with `appliance whoami`.';
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up|abort/i.test(message)) {
    return `Could not reach the api-server${apiUrl ? ` at ${apiUrl}` : ''} — is it running? \`appliance test\` runs connection diagnostics.`;
  }
  return null;
}

/** Print an error in the CLI's standard shape (red message + dim
 *  remediation hint) and set a non-zero exit code. Prompt
 *  cancellations get a quiet "Cancelled." and the conventional 130. */
export function printCliError(error: unknown, opts?: { apiUrl?: string }): void {
  if (isPromptCancel(error)) {
    console.error(chalk.dim('Cancelled.'));
    process.exitCode = 130;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(message));
  const hint = remediationHint(message, opts?.apiUrl);
  if (hint) console.error(chalk.dim(hint));
  process.exitCode = 1;
}

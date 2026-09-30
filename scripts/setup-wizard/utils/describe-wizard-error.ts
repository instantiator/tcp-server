/** What the wizard tells the user when it stops early, and its exit code. */
export interface WizardErrorReport {
  message: string;
  exitCode: number;
}

/**
 * Turns whatever stopped the wizard into a message that says what happened
 * and what to do, instead of a stack trace. `writtenTo` is the env file, once
 * it has been written, so a cancelled run can say the answers were kept.
 */
export function describeWizardError(
  err: unknown,
  writtenTo?: string,
): WizardErrorReport {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    return {
      message: writtenTo
        ? `Setup cancelled. Your answers were written to ${writtenTo}.`
        : 'Setup cancelled. Nothing was written.',
      exitCode: 130,
    };
  }

  const code = errorCode(err);
  const path = errorPath(err);
  if ((code === 'EACCES' || code === 'EPERM' || code === 'EROFS') && path) {
    return {
      message: `Couldn't write ${path}: permission denied. Check you own the repo directory (ls -l ${path}), then re-run the wizard.`,
      exitCode: 1,
    };
  }

  const detail = err instanceof Error ? err.message : String(err);
  return {
    message: `Setup failed: ${detail}\nRe-run with DEBUG=1 to see the full stack trace.`,
    exitCode: 1,
  };
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

function errorPath(err: unknown): string | undefined {
  return err instanceof Error && 'path' in err && typeof err.path === 'string'
    ? err.path
    : undefined;
}

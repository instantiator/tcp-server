/**
 * Whether the full-screen TUI should replace the linear stdout/stderr
 * renderer: only when stdout is a real TTY (there's a screen to draw
 * full-screen to) and the user hasn't passed `--no-tui`. This holds for
 * `--query` too — only a genuinely piped/redirected stdout falls back to the
 * plain renderer.
 */
export function shouldUseTui(
  cmdOpts: { tui?: boolean },
  isTty: boolean,
): boolean {
  return isTty && cmdOpts.tui !== false;
}

/**
 * Validates the `--role-id`/`--company-id`/`--query` combination, returning
 * an error message (or `null` if valid). Exactly one of `--role-id`/
 * `--company-id` is required; `--query` needs a specific role up front (a
 * one-shot can't wait for an interactive roster pick); browsing a company
 * with no role needs the TUI's roster pane, so it requires a TTY.
 */
export function validateChatFlags(
  cmdOpts: { roleId?: string; companyId?: string; query?: string },
  useTui: boolean,
): string | null {
  if (!cmdOpts.roleId && !cmdOpts.companyId) {
    return 'either --role-id or --company-id is required';
  }
  if (cmdOpts.roleId && cmdOpts.companyId) {
    return 'pass either --role-id or --company-id, not both (role-id already implies its company)';
  }
  if (cmdOpts.query && !cmdOpts.roleId) {
    return '--query requires --role-id (a one-shot needs a target role)';
  }
  if (cmdOpts.companyId && !useTui) {
    return '--company-id without --role-id needs the full-screen TUI to browse roles (requires a TTY) — pass --role-id directly for non-interactive use, or drop --no-tui';
  }
  return null;
}

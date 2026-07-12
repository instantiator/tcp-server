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
 * Validates the role/company/query flag combination, returning an error
 * message (or `null` if valid). A role is identified either by `--role-id`
 * alone, or by `--role-slug` plus a company (`--company-id`/`--company-slug`)
 * to scope it — role slugs are only unique within a company. Exactly one of
 * a role or a bare company is required; `--query` needs a specific role up
 * front (a one-shot can't wait for an interactive roster pick); browsing a
 * company with no role needs the TUI's roster pane, so it requires a TTY.
 */
export function validateChatFlags(
  cmdOpts: {
    roleId?: string;
    roleSlug?: string;
    companyId?: string;
    companySlug?: string;
    query?: string;
  },
  useTui: boolean,
): string | null {
  const companyGiven = Boolean(cmdOpts.companyId || cmdOpts.companySlug);
  const roleGiven = Boolean(cmdOpts.roleId || cmdOpts.roleSlug);

  if (!roleGiven && !companyGiven) {
    return 'pass a role (--role-id or --role-slug) or a company (--company-id or --company-slug)';
  }
  if (cmdOpts.roleId && cmdOpts.roleSlug) {
    return 'pass either --role-id or --role-slug, not both';
  }
  if (cmdOpts.companyId && cmdOpts.companySlug) {
    return 'pass either --company-id or --company-slug, not both';
  }
  if (cmdOpts.roleId && companyGiven) {
    return 'pass either a role or a company, not both (--role-id already implies its company)';
  }
  if (cmdOpts.roleSlug && !companyGiven) {
    return '--role-slug requires --company-id or --company-slug (role slugs are only unique within a company)';
  }
  if (cmdOpts.query && !roleGiven) {
    return '--query requires a role (--role-id, or --role-slug with a company)';
  }
  if (companyGiven && !roleGiven && !useTui) {
    return 'browsing a company without a role needs the full-screen TUI (requires a TTY) — pass a role directly for non-interactive use, or drop --no-tui';
  }
  return null;
}

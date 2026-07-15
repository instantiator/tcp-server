import { EntityRefOpts, UUID_RE } from '../core/entity-ref';

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
 * message (or `null` if valid). A role is identified by exactly one of
 * `--role`, `--role-id`, `--role-slug` — a UUID form (`--role-id`, or
 * `--role` matching a UUID) already implies its company, while a slug form
 * (`--role-slug`, or a non-UUID `--role`) requires a company
 * (`--company`/`--company-id`/`--company-slug`) to scope it — role slugs are
 * only unique within a company. Exactly one of a role or a bare company is
 * required; `--query` needs a specific role up front (a one-shot can't wait
 * for an interactive roster pick); browsing a company with no role needs the
 * TUI's roster pane, so it requires a TTY.
 */
export function validateChatFlags(
  cmdOpts: EntityRefOpts & { query?: string },
  useTui: boolean,
): string | null {
  const companyGiven = Boolean(
    cmdOpts.company || cmdOpts.companyId || cmdOpts.companySlug,
  );
  const roleGiven = Boolean(cmdOpts.role || cmdOpts.roleId || cmdOpts.roleSlug);

  if (!roleGiven && !companyGiven) {
    return 'pass a role (--role, --role-id, or --role-slug) or a company (--company, --company-id, or --company-slug)';
  }
  const roleVariants = [cmdOpts.role, cmdOpts.roleId, cmdOpts.roleSlug].filter(
    Boolean,
  ).length;
  if (roleVariants > 1) {
    return 'pass only one of --role, --role-id, --role-slug';
  }
  const companyVariants = [
    cmdOpts.company,
    cmdOpts.companyId,
    cmdOpts.companySlug,
  ].filter(Boolean).length;
  if (companyVariants > 1) {
    return 'pass only one of --company, --company-id, --company-slug';
  }

  const roleIsUuidForm = Boolean(
    cmdOpts.roleId || (cmdOpts.role && UUID_RE.test(cmdOpts.role)),
  );
  if (roleIsUuidForm && companyGiven) {
    return 'pass either a role or a company, not both (a role UUID already implies its company)';
  }
  const roleIsSlugForm = Boolean(
    cmdOpts.roleSlug || (cmdOpts.role && !UUID_RE.test(cmdOpts.role)),
  );
  if (roleIsSlugForm && !companyGiven) {
    return '--role <slug> requires --company, --company-id, or --company-slug (role slugs are only unique within a company)';
  }
  if (cmdOpts.query && !roleGiven) {
    return '--query requires a role (--role, --role-id, or --role-slug)';
  }
  if (companyGiven && !roleGiven && !useTui) {
    return 'browsing a company without a role needs the full-screen TUI (requires a TTY) — pass a role directly for non-interactive use, or drop --no-tui';
  }
  return null;
}

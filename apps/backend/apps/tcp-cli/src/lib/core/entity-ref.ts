import { Command } from 'commander';
import { ApiOptions, apiRequest } from './api';

/** Matches a canonical UUID (case-insensitive) — the single copy used to sniff id vs slug. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The three raw flag values a single entity reference resolves from. */
interface RawEntityRef {
  id?: string;
  slug?: string;
  /** The combined `--company`/`--role`-style value — sniffed against {@link UUID_RE}. */
  value?: string;
}

/** Shared shape for commands that accept `--company`/`--company-id`/`--company-slug` and/or `--role`/`--role-id`/`--role-slug`. */
export interface EntityRefOpts {
  company?: string;
  companyId?: string;
  companySlug?: string;
  role?: string;
  roleId?: string;
  roleSlug?: string;
}

/**
 * Adds the combined `--<flag> <slug-or-id>` option plus its `--<flag>-id`/
 * `--<flag>-slug` suffix variants to a command, so a verb declares the full
 * set in one call. `short`, when given, is only attached to the combined
 * form (avoid it where the letter is already used by another option).
 */
export function addEntityIdOptions(
  cmd: Command,
  {
    flag,
    short,
    label,
    required,
  }: { flag: string; short?: string; label: string; required?: boolean },
): Command {
  const combinedFlag = short
    ? `-${short}, --${flag} <slug-or-id>`
    : `--${flag} <slug-or-id>`;
  const withCombined = required
    ? cmd.requiredOption(combinedFlag, `${label} slug or UUID`)
    : cmd.option(combinedFlag, `${label} slug or UUID`);
  return withCombined
    .option(`--${flag}-id <uuid>`, `${label} UUID, instead of --${flag}`)
    .option(`--${flag}-slug <slug>`, `${label} slug, instead of --${flag}`);
}

/** Adds `--company`/`-c`, `--company-id`, `--company-slug`. */
export function addCompanyOptions(
  cmd: Command,
  opts: { required?: boolean } = {},
): Command {
  return addEntityIdOptions(cmd, {
    flag: 'company',
    short: 'c',
    label: 'Company',
    ...opts,
  });
}

/** Adds `--role`/`-r`, `--role-id`, `--role-slug`. */
export function addRoleOptions(
  cmd: Command,
  opts: { required?: boolean } = {},
): Command {
  return addEntityIdOptions(cmd, {
    flag: 'role',
    short: 'r',
    label: 'Role',
    ...opts,
  });
}

/**
 * Resolves a company UUID from its three raw flag values. Precedence:
 * `id` (used as-is) → `slug` (resolved via `GET /api/company/:slug`) →
 * `value` (the combined `--company` form: used as-is when it looks like a
 * UUID, otherwise resolved the same way as `slug`).
 *
 * @throws if none of the three values is given, or a slug doesn't resolve.
 */
async function lookupCompanyId(
  api: ApiOptions,
  slugOrId: string,
): Promise<string> {
  const company = await apiRequest<{ id: string }>(
    api,
    'GET',
    `/api/company/${slugOrId}`,
  );
  return company.id;
}

/**
 * The precedence every entity reference follows: an explicit `id` wins, then
 * an explicit `slug`, then the combined `value` form — used as-is when it
 * looks like a UUID, otherwise resolved as a slug.
 *
 * @param lookup - Resolves a slug to its entity UUID.
 * @throws when none of the three values is given.
 */
async function resolveRef(
  { id, slug, value }: RawEntityRef,
  label: string,
  lookup: (slug: string) => Promise<string>,
): Promise<string> {
  if (id) return id;
  if (slug) return lookup(slug);
  if (value) return UUID_RE.test(value) ? value : lookup(value);
  throw new Error(
    `Provide a ${label}: --${label}, --${label}-id, or --${label}-slug`,
  );
}

export async function resolveCompanyIdFrom(
  api: ApiOptions,
  ref: RawEntityRef,
  label = 'company',
): Promise<string> {
  return resolveRef(ref, label, (slug) => lookupCompanyId(api, slug));
}

/** {@link resolveCompanyIdFrom} for the standard `--company`/`--company-id`/`--company-slug` options. */
export async function resolveCompanyId(
  api: ApiOptions,
  opts: EntityRefOpts,
): Promise<string> {
  return resolveCompanyIdFrom(api, {
    id: opts.companyId,
    slug: opts.companySlug,
    value: opts.company,
  });
}

/**
 * Resolves a role UUID from its three raw flag values, scoped by a
 * (separately-named) company reference — role slugs are unique only within
 * a company. Precedence mirrors {@link resolveCompanyIdFrom}: `id` → `slug`
 * → `value` (UUID-sniffed).
 *
 * @throws if none of the three role values is given, if a role slug is
 *   given but the company doesn't resolve, or if either lookup fails.
 */
export async function resolveRoleIdFrom(
  api: ApiOptions,
  ref: RawEntityRef,
  company: RawEntityRef,
  label = 'role',
): Promise<string> {
  const bySlug = async (roleSlug: string): Promise<string> => {
    const companyId = await resolveCompanyIdFrom(api, company).catch(() => {
      throw new Error(
        `--${label}-slug requires a company (--company, --company-id, or --company-slug) — ${label} slugs are only unique within a company`,
      );
    });
    const role = await apiRequest<{ id: string }>(
      api,
      'GET',
      `/api/company/${companyId}/roles/by-slug/${roleSlug}`,
    );
    return role.id;
  };

  return resolveRef(ref, label, bySlug);
}

/** {@link resolveRoleIdFrom} for the standard `--role`/`--role-id`/`--role-slug` options, scoped by `--company`/`--company-id`/`--company-slug`. */
export async function resolveRoleId(
  api: ApiOptions,
  opts: EntityRefOpts,
): Promise<string> {
  return resolveRoleIdFrom(
    api,
    { id: opts.roleId, slug: opts.roleSlug, value: opts.role },
    { id: opts.companyId, slug: opts.companySlug, value: opts.company },
  );
}

/**
 * Resolves `--role`/`--company` (any variant) into the API path segment
 * identifying a knowledge scope: `role/<uuid>` or `company/<slug-or-id>`.
 *
 * The company knowledge routes accept a slug or a UUID directly, so unlike
 * {@link resolveCompanyId} (which must return a real UUID for callers that
 * need one, e.g. task creation) a company value is used here as-is, with no
 * network call.
 *
 * @throws if neither a role nor a company is given, or if a role doesn't resolve.
 */
export async function resolveKnowledgeScopePath(
  api: ApiOptions,
  opts: EntityRefOpts,
): Promise<string> {
  if (opts.role || opts.roleId || opts.roleSlug) {
    return `role/${await resolveRoleId(api, opts)}`;
  }
  const company = opts.companyId ?? opts.companySlug ?? opts.company;
  if (company) return `company/${company}`;
  throw new Error(
    'Provide either a role (--role, --role-id, --role-slug) or a company (--company, --company-id, --company-slug)',
  );
}

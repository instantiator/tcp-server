import { SetMetadata } from '@nestjs/common';

/** Where a request carries the handle a company is resolved from. */
export type ScopeSource = 'param' | 'query' | 'body';

/** What that handle names — the entity whose `companyId` answers the question. */
export type ScopeVia =
  | 'company' // UUID or slug, resolved via DbService.getCompany
  | 'task'
  | 'agent'
  | 'assignment'
  | 'role'
  | 'conversation' // by slug
  | 'storagePath'; // first path segment is the company slug

/** One way a route may name the company it targets. */
export interface CompanyScopeSpec {
  from: ScopeSource;
  key: string;
  via: ScopeVia;
  /**
   * Values of this key that name no entity and must be skipped, so a later
   * spec gets its turn. Exists for `GET /api/assignment?taskId=null`, where
   * the literal string is the orphan-assignment sentinel rather than an id.
   */
  ignore?: readonly string[];
}

export const COMPANY_SCOPE = 'tcp:company-scope';
export const COMPANY_SCOPE_MISSING_MESSAGE = 'tcp:company-scope-missing';
export const NO_COMPANY_SCOPE = 'tcp:no-company-scope';
export const ADMIN_ONLY = 'tcp:admin-only';

/**
 * Declares how {@link CompanyMembershipGuard} finds the company a route
 * targets. Several specs mean "the first one present on the request wins" —
 * `GET /api/agent` accepts a company, a role or an assignment.
 *
 * A route on a guarded controller must carry this, {@link NoCompanyScope} or
 * {@link AdminOnly}: the guard refuses anything that declares none, so a new
 * route cannot open by omission.
 */
export const CompanyScope = (...specs: CompanyScopeSpec[]) =>
  SetMetadata(COMPANY_SCOPE, specs);

/**
 * The 400 to raise when a {@link CompanyScope} route carries none of its
 * handles. Present only on routes that already rejected that case with their
 * own message, so the wording survives enforcement; without it, an
 * unidentifiable company is a 403.
 */
export const CompanyScopeRequired = (message: string) =>
  SetMetadata(COMPANY_SCOPE_MISSING_MESSAGE, message);

/**
 * Marks a route as reachable by any authenticated caller because it names no
 * company. The reason is mandatory and is printed by the route audit, so an
 * exemption has to be argued where it is granted.
 */
export const NoCompanyScope = (reason: string) =>
  SetMetadata(NO_COMPANY_SCOPE, reason);

/**
 * Restricts a route to the identifiers in `TCP_ADMIN_IDENTIFIERS` — the
 * interim answer to "system administrator" until permission groups exist
 * (ADR-011, phase-02 amendment).
 */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);

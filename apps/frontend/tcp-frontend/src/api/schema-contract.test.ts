import type { AssignmentChangeSummary } from '@tcp/shared/client';
import { describe, expect, it } from 'vitest';

import type { paths } from './schema';

/**
 * Proves the committed `schema.d.ts` is not a regeneration that predates
 * 002.04 — the company stats block, and the assignment `?mode` filter this
 * application's read surface (`queries.ts`, `query-keys.ts`) depends on.
 *
 * Each test constructs a *typed* value against the generated shape: it fails
 * at `tsc` if a field has gone missing, and at runtime if it's shaped
 * differently than expected. A stale `schema.d.ts` would otherwise only be
 * caught the first time some component tried to read one of these fields —
 * in the browser, not in CI.
 */

type CompanyRow =
  paths['/api/company']['get']['responses'][200]['content']['application/json'][number];

it('the company row carries 002.04 stats', () => {
  const stats: CompanyRow['stats'] = {
    activeAgents: 0,
    tasksByStatus: {},
    openEnquiries: 0,
  };

  expect(stats.activeAgents).toBe(0);
});

it('?all is an optional boolean query parameter on GET /api/company', () => {
  type CompanyQuery = NonNullable<
    paths['/api/company']['get']['parameters']['query']
  >;

  const noFilter: CompanyQuery = {};
  const administratorsOnly: CompanyQuery = { all: true };

  expect(noFilter).toEqual({});
  expect(administratorsOnly.all).toBe(true);
});

it('GET /api/assignment accepts companyId, roleId, status and a literal ?mode', () => {
  type AssignmentQuery = NonNullable<
    paths['/api/assignment']['get']['parameters']['query']
  >;

  const query: AssignmentQuery = {
    companyId: 'company-1',
    roleId: 'role-1',
    status: 'ready',
    // A real member of the literal union, not a widened `string` — this is
    // what would fail to compile first if the server renamed or dropped a
    // mode.
    mode: 'consultee',
  };

  expect(query).toEqual({
    companyId: 'company-1',
    roleId: 'role-1',
    status: 'ready',
    mode: 'consultee',
  });
});

describe('AssignmentChangeSummary', () => {
  it('is asserted against @tcp/shared/client, not the generated schema', () => {
    // Verified finding: AssignmentChangeSummary is the payload of an
    // assignment `state_change` SSE event, and `@Sse` routes carry no
    // response schema at all — it does not appear anywhere in the OpenAPI
    // description this file is generated from, so there is no `paths` entry
    // to assert it against. It exists instead as a plain TypeScript interface
    // in `@tcp/shared/client`, which the frontend is allowed to import
    // (`@tcp/shared/client` only — never bare `@tcp/shared`, per ADR-022).
    // 005.02 is where this type is actually consumed, reading the event
    // stream.
    const roleId = '11111111-1111-1111-1111-111111111111';
    const summary: AssignmentChangeSummary = {
      id: '22222222-2222-2222-2222-222222222222',
      status: 'ready',
      mode: 'plan',
      orderIndex: 0,
      roleId,
    };

    expect(summary.roleId).toBe(roleId);
  });
});

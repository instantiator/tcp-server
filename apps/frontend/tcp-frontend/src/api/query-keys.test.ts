import { hashKey, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  EVENT_ENTITIES,
  queryKeys,
  STATIC_ENTITIES,
  type QueryScope,
} from './query-keys';

// This file tests the convention the doc comment at the top of query-keys.ts
// describes, not each individual key — a key's own shape belongs to whichever
// hook uses it. What's protected here is the thing every key has to agree on:
// a valid [entity, scope, ...] prefix, an entity name that matches
// tcp-server's events rather than its routes, and a first element that a list
// and its detail share.

it('EVENT_ENTITIES lists exactly the payload.entity values tcp-server publishes', () => {
  // These are hand-copied from the server, on purpose (see the doc comment on
  // EVENT_ENTITIES) — a sixth entity there has to fail this assertion by
  // name, rather than leave some view silently stale because nothing here
  // noticed the mismatch.
  expect(EVENT_ENTITIES).toEqual([
    'company',
    'agent',
    'task',
    'assignment',
    'enquiry',
    'notification',
    'spend',
  ]);
});

const VALID_ENTITIES: readonly string[] = [
  ...EVENT_ENTITIES,
  ...STATIC_ENTITIES,
];
const VALID_SCOPES = [
  'list',
  'detail',
  'history',
  'status',
  'search',
] as const satisfies readonly QueryScope[];

/**
 * Every builder, called once, so the assertion below can be made against all
 * of them at once.
 *
 * Written out rather than derived from `Object.entries(queryKeys)`: the
 * builders have genuinely different signatures, so iterating them needs a cast
 * to call them generically. Typing this as `Record<keyof typeof queryKeys, …>`
 * buys back more than the cast cost — a builder added to `queryKeys` without a
 * line here is a **compile** error naming the missing one, where the iterated
 * version would only ever have checked whatever it happened to find.
 */
const everyKey: Record<keyof typeof queryKeys, readonly unknown[]> = {
  companies: queryKeys.companies(),
  company: queryKeys.company('company-1'),
  agents: queryKeys.agents(),
  agent: queryKeys.agent('agent-1'),
  agentByAssignment: queryKeys.agentByAssignment('assignment-1'),
  agentHistory: queryKeys.agentHistory('agent-1'),
  tasks: queryKeys.tasks({ companyId: 'company-1' }),
  task: queryKeys.task('task-1'),
  taskHistory: queryKeys.taskHistory('task-1'),
  assignments: queryKeys.assignments(),
  assignment: queryKeys.assignment('assignment-1'),
  conversations: queryKeys.conversations({ companyId: 'company-1' }),
  conversation: queryKeys.conversation('some-slug'),
  companyRoles: queryKeys.companyRoles('company-1'),
  roleBySlug: queryKeys.roleBySlug('company-1', 'some-slug'),
  role: queryKeys.role('role-1'),
  companyUsers: queryKeys.companyUsers('company-1'),
  roleKnowledge: queryKeys.roleKnowledge('role-1'),
  roleKnowledgeStatus: queryKeys.roleKnowledgeStatus('role-1'),
  roleKnowledgeSearch: queryKeys.roleKnowledgeSearch('role-1', 'a question'),
  companyKnowledge: queryKeys.companyKnowledge('company-1'),
  companyKnowledgeStatus: queryKeys.companyKnowledgeStatus('company-1'),
  notifications: queryKeys.notifications(),
  spendOverview: queryKeys.spendOverview(),
  companySpend: queryKeys.companySpend('company-1'),
};

describe('every builder in queryKeys', () => {
  it.each(Object.entries(everyKey))(
    '%s returns a key whose [entity, scope] prefix is valid',
    (_name, key) => {
      expect(VALID_ENTITIES).toContain(key[0]);
      expect(VALID_SCOPES).toContain(key[1]);
    },
  );
});

it('keys conversations under the entity "enquiry", not "conversation"', () => {
  // The route is /api/conversation; the event that invalidates these queries
  // says `entity: 'enquiry'`. The event wins, because the event is the side
  // doing the invalidating — getting this backwards produces a view that
  // never updates while every other view does, which reads as a fault in the
  // event stream and is not one.
  expect(queryKeys.conversations({ companyId: 'company-1' })[0]).toBe(
    'enquiry',
  );
  expect(queryKeys.conversation('some-slug')[0]).toBe('enquiry');
});

it('shares its first element between a list key and a detail key of the same entity', () => {
  // Asserted with TanStack's real matching rather than by eyeballing the
  // arrays: what matters is that `invalidateQueries({ queryKey: ['company'] })`
  // actually reaches both a company list and a company detail in the cache.
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.companies(), []);
  queryClient.setQueryData(queryKeys.company('company-1'), {});

  const companyQueries = queryClient
    .getQueryCache()
    .findAll({ queryKey: ['company'] });
  const agentQueries = queryClient
    .getQueryCache()
    .findAll({ queryKey: ['agent'] });

  expect(companyQueries).toHaveLength(2);
  expect(agentQueries).toHaveLength(0);
});

it('hashes {all: undefined} the same as {} — TanStack drops undefined before hashing', () => {
  // This is what the doc comment on `queryKeys` claims about `undefined`
  // needing no normalising. If it's wrong, the claim gets fixed, not this
  // assertion.
  expect(hashKey(queryKeys.companies({ all: undefined }))).toBe(
    hashKey(queryKeys.companies({})),
  );
});

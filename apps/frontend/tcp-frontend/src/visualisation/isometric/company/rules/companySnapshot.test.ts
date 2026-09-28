import { describe, expect, it } from 'vitest';

import type {
  AgentDTO,
  AssignmentDTO,
  ConversationDTO,
  RoleDTO,
  TaskDTO,
} from '../../../../api/dtos';
import { buildCompanySnapshot, type CompanyData } from './companySnapshot';

const NOW = '2026-01-01T00:00:00.000Z';

function role(overrides: Partial<RoleDTO> = {}): RoleDTO {
  return {
    id: 'role-1',
    companyId: 'company-1',
    slug: 'role-1',
    name: 'Role One',
    description: 'A role',
    knowledgeDomains: [],
    mcpServerList: [],
    queryIndex: 0,
    ...overrides,
  };
}

function task(overrides: Partial<TaskDTO> = {}): TaskDTO {
  return {
    id: 'task-1',
    companyId: 'company-1',
    request: 'Do the thing',
    shortcode: 'T1',
    status: 'in-progress',
    materials: [],
    expected: [],
    completed: null,
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function assignment(overrides: Partial<AssignmentDTO> = {}): AssignmentDTO {
  return {
    id: 'assignment-1',
    taskId: 'task-1',
    companyId: 'company-1',
    mode: 'implement',
    prompt: 'Implement it',
    roleId: 'role-1',
    status: 'in-progress',
    failureReason: null,
    materials: [],
    expected: [],
    prepared: [],
    approved: [],
    summary: null,
    qaStatus: null,
    qaFeedback: null,
    qaAttempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentDTO> = {}): AgentDTO {
  return {
    id: 'agent-1',
    companyId: 'company-1',
    roleId: 'role-1',
    assignmentId: 'assignment-1',
    status: 'running',
    threadId: 'thread-1',
    initialPrompt: 'Go',
    createdAt: NOW,
    output: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function enquiry(overrides: Partial<ConversationDTO> = {}): ConversationDTO {
  return {
    id: 'enquiry-1',
    slug: 'enquiry-1',
    companyId: 'company-1',
    roleName: 'Role One',
    roleId: 'role-1',
    agentId: 'agent-1',
    question: 'What do you mean?',
    context: null,
    status: 'awaiting_user',
    routedToIdentifiers: [],
    createdAt: NOW,
    ...overrides,
  };
}

function data(overrides: Partial<CompanyData> = {}): CompanyData {
  return {
    roles: [role()],
    agents: [agent()],
    tasks: [task()],
    assignments: [assignment()],
    enquiries: [],
    ...overrides,
  };
}

describe('buildCompanySnapshot', () => {
  it('maps roles straight through', () => {
    const snapshot = buildCompanySnapshot(
      data({ roles: [role({ id: 'r1', name: 'Builder' })] }),
    );
    expect(snapshot.roles).toEqual([{ id: 'r1', name: 'Builder' }]);
  });

  it('counts step and steps from implement-mode assignments only, step from the succeeded ones', () => {
    const snapshot = buildCompanySnapshot(
      data({
        tasks: [task({ id: 'task-1' })],
        assignments: [
          assignment({ id: 'a1', mode: 'implement', status: 'succeeded' }),
          assignment({ id: 'a2', mode: 'implement', status: 'in-progress' }),
          assignment({ id: 'a3', mode: 'plan', status: 'succeeded' }),
        ],
      }),
    );
    expect(snapshot.tasks).toEqual([
      expect.objectContaining({ id: 'task-1', step: 1, steps: 2 }),
    ]);
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'marks a %s task finished',
    (status) => {
      const snapshot = buildCompanySnapshot(
        data({ tasks: [task({ status })], assignments: [] }),
      );
      expect(snapshot.tasks[0]?.finished).toBe(true);
    },
  );

  it.each(['ready', 'planning', 'in-progress', 'finalising'] as const)(
    'does not mark a %s task finished',
    (status) => {
      const snapshot = buildCompanySnapshot(
        data({ tasks: [task({ status })], assignments: [] }),
      );
      expect(snapshot.tasks[0]?.finished).toBe(false);
    },
  );

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'row 1: marks a %s agent finished',
    (status) => {
      const snapshot = buildCompanySnapshot(
        data({ agents: [agent({ status })] }),
      );
      expect(snapshot.agents[0]?.activity).toEqual({ kind: 'finished' });
    },
  );

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'row 1: marks finished when the assignment status is %s',
    (status) => {
      const snapshot = buildCompanySnapshot(
        data({ assignments: [assignment({ status })] }),
      );
      expect(snapshot.agents[0]?.activity).toEqual({ kind: 'finished' });
    },
  );

  it('row 2: is messagingUser when an open enquiry names the agent', () => {
    const snapshot = buildCompanySnapshot(
      data({
        enquiries: [enquiry({ agentId: 'agent-1', status: 'awaiting_user' })],
      }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({ kind: 'messagingUser' });
  });

  it('row 2: a closed enquiry does not count', () => {
    const snapshot = buildCompanySnapshot(
      data({ enquiries: [enquiry({ agentId: 'agent-1', status: 'closed' })] }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({ kind: 'working' });
  });

  it('precedence: running and awaiting_user is messagingUser, not working', () => {
    const snapshot = buildCompanySnapshot(
      data({
        agents: [agent({ status: 'running' })],
        enquiries: [enquiry({ agentId: 'agent-1', status: 'awaiting_user' })],
      }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({ kind: 'messagingUser' });
  });

  it('row 3: is messagingUser for a chat assignment', () => {
    const snapshot = buildCompanySnapshot(
      data({ assignments: [assignment({ mode: 'chat', taskId: null })] }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({ kind: 'messagingUser' });
    expect(snapshot.agents[0]?.taskId).toBeNull();
  });

  it('row 4: is consulting, keyed by its own assignment, when the mode is consultee', () => {
    const snapshot = buildCompanySnapshot(
      data({
        assignments: [assignment({ id: 'assignment-1', mode: 'consultee' })],
      }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({
      kind: 'consulting',
      oneToOneId: 'assignment-1',
    });
  });

  it('row 5: is consulting, keyed by the consultee assignment, when an active one targets this agent', () => {
    const snapshot = buildCompanySnapshot(
      data({
        assignments: [
          assignment({ id: 'assignment-1', mode: 'implement' }),
          assignment({
            id: 'assignment-2',
            mode: 'consultee',
            status: 'in-progress',
            parentAssignmentId: 'assignment-1',
          }),
        ],
      }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({
      kind: 'consulting',
      oneToOneId: 'assignment-2',
    });
  });

  it('row 5: an inactive consultee assignment does not make its parent consulting', () => {
    const snapshot = buildCompanySnapshot(
      data({
        assignments: [
          assignment({ id: 'assignment-1', mode: 'implement' }),
          assignment({
            id: 'assignment-2',
            mode: 'consultee',
            status: 'succeeded',
            parentAssignmentId: 'assignment-1',
          }),
        ],
      }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({ kind: 'working' });
  });

  it('row 6: is reviewing when the mode is qa and the agent is running', () => {
    const snapshot = buildCompanySnapshot(
      data({
        assignments: [
          assignment({ mode: 'qa', targetAssignmentId: 'target-1' }),
        ],
      }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({
      kind: 'reviewing',
      reviewedAssignmentId: 'target-1',
    });
  });

  it('row 6: a running qa agent with no targetAssignmentId is working', () => {
    const snapshot = buildCompanySnapshot(
      data({
        assignments: [assignment({ mode: 'qa', targetAssignmentId: null })],
      }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({ kind: 'working' });
  });

  it('row 8: is working when the agent is running and nothing else applies', () => {
    const snapshot = buildCompanySnapshot(data());
    expect(snapshot.agents[0]?.activity).toEqual({ kind: 'working' });
  });

  // 002.02 stage 4: row 9 used to cover `idle` too, but that read as a bug
  // (the avatar sat at its desk with an empty listen-in while its task was
  // already `planning`). It now narrows to `paused` — row 7 catches `idle`
  // on an in-progress, non-chat assignment first.
  it.each(['paused'] as const)(
    'row 9: is atDesk when the agent is %s',
    (status) => {
      const snapshot = buildCompanySnapshot(
        data({ agents: [agent({ status })] }),
      );
      expect(snapshot.agents[0]?.activity).toEqual({ kind: 'atDesk' });
    },
  );

  // 002.02 stage 1 (cause Q): a task agent queued behind the one worker slot
  // stayed `idle` for 52 s while its task read `planning`, and sat at its desk.
  // For a task agent, `idle` means only "created, not started" (decision 4),
  // so stage 4 shows it waiting. Row 9's `idle` case above changes with it.
  it('is waiting when a task agent is idle on an in-progress assignment', () => {
    const snapshot = buildCompanySnapshot(
      data({
        agents: [agent({ status: 'idle', threadId: null })],
        assignments: [assignment({ mode: 'plan' })],
        tasks: [task({ status: 'planning' })],
      }),
    );
    expect(snapshot.agents[0]?.activity.kind).toBe('waiting');
  });

  it('row 7: a chat agent that is idle is messagingUser, not waiting', () => {
    const snapshot = buildCompanySnapshot(
      data({
        agents: [agent({ status: 'idle', threadId: null })],
        assignments: [assignment({ mode: 'chat', taskId: null })],
      }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({ kind: 'messagingUser' });
  });

  it('row 9: a paused agent on an in-progress assignment is atDesk, not waiting', () => {
    const snapshot = buildCompanySnapshot(
      data({
        agents: [agent({ status: 'paused' })],
        assignments: [assignment({ mode: 'plan', status: 'in-progress' })],
      }),
    );
    expect(snapshot.agents[0]?.activity).toEqual({ kind: 'atDesk' });
  });

  it('drops an agent whose assignment is not loaded', () => {
    const snapshot = buildCompanySnapshot(
      data({
        agents: [agent({ assignmentId: 'missing-assignment' })],
        assignments: [],
      }),
    );
    expect(snapshot.agents).toEqual([]);
  });
});

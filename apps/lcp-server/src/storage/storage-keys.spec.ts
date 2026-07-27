import type { TcpArtifact, TcpAssignment } from '@lcp/shared';
import {
  assignmentCompletedKey,
  assignmentCompletedPrefix,
  assignmentWorkingKey,
  assignmentWorkingPrefix,
  knowledgeKey,
  knowledgePrefix,
  knowledgeScopeKey,
  knowledgeScopePrefix,
  orphanWorkingKey,
  orphanWorkingPrefix,
  parseKnowledgePath,
  resolveArtifactKey,
  sharedKnowledgeKey,
  sharedKnowledgePrefix,
  taskCompletedKey,
  taskCompletedPrefix,
  taskMaterialsKey,
  taskMaterialsPrefix,
} from './storage-keys';

describe('knowledgeKey', () => {
  it('builds the slug-based knowledge-file key layout', () => {
    expect(knowledgeKey('acme', 'analyst', 'report.md')).toBe(
      'acme/knowledge/analyst/report.md',
    );
  });
});

describe('sharedKnowledgeKey', () => {
  it('builds the company-shared knowledge-file key layout', () => {
    expect(sharedKnowledgeKey('acme', 'report.md')).toBe(
      'acme/knowledge/shared/report.md',
    );
  });
});

describe('knowledgePrefix', () => {
  it('builds the role knowledge-listing prefix', () => {
    expect(knowledgePrefix('acme', 'analyst')).toBe('acme/knowledge/analyst/');
  });
});

describe('sharedKnowledgePrefix', () => {
  it('builds the company-shared knowledge-listing prefix', () => {
    expect(sharedKnowledgePrefix('acme')).toBe('acme/knowledge/shared/');
  });
});

describe('knowledgeScopeKey', () => {
  it('builds a role-scoped key when roleSlug is set', () => {
    expect(
      knowledgeScopeKey({ companySlug: 'acme', roleSlug: 'analyst' }, 'a.md'),
    ).toBe('acme/knowledge/analyst/a.md');
  });

  it('builds a shared-scoped key when roleSlug is null', () => {
    expect(
      knowledgeScopeKey({ companySlug: 'acme', roleSlug: null }, 'a.md'),
    ).toBe('acme/knowledge/shared/a.md');
  });
});

describe('knowledgeScopePrefix', () => {
  it('builds a role-scoped prefix when roleSlug is set', () => {
    expect(
      knowledgeScopePrefix({ companySlug: 'acme', roleSlug: 'analyst' }),
    ).toBe('acme/knowledge/analyst/');
  });

  it('builds a shared-scoped prefix when roleSlug is null', () => {
    expect(knowledgeScopePrefix({ companySlug: 'acme', roleSlug: null })).toBe(
      'acme/knowledge/shared/',
    );
  });
});

describe('parseKnowledgePath', () => {
  it('parses a role knowledge key', () => {
    expect(parseKnowledgePath('acme/knowledge/analyst/report.md')).toEqual({
      companySlug: 'acme',
      roleSlug: 'analyst',
    });
  });

  it('maps the shared/ segment to a null role', () => {
    expect(parseKnowledgePath('acme/knowledge/shared/policy.md')).toEqual({
      companySlug: 'acme',
      roleSlug: null,
    });
  });

  it('returns null for non-knowledge keys', () => {
    expect(parseKnowledgePath('acme/tasks/123/output.md')).toBeNull();
    expect(parseKnowledgePath('acme/knowledge/analyst')).toBeNull();
    expect(parseKnowledgePath('report.md')).toBeNull();
  });
});

describe('task/assignment storage keys', () => {
  it('builds the task materials key and prefix', () => {
    expect(taskMaterialsKey('acme', 'task-1', 'brief.md')).toBe(
      'acme/tasks/task-1/materials/brief.md',
    );
    expect(taskMaterialsPrefix('acme', 'task-1')).toBe(
      'acme/tasks/task-1/materials/',
    );
  });

  it('builds the task completed key and prefix', () => {
    expect(taskCompletedKey('acme', 'task-1', 'report.md')).toBe(
      'acme/tasks/task-1/completed/report.md',
    );
    expect(taskCompletedPrefix('acme', 'task-1')).toBe(
      'acme/tasks/task-1/completed/',
    );
  });

  it('builds the assignment working key and prefix', () => {
    expect(assignmentWorkingKey('acme', 'task-1', 2, 'draft.md')).toBe(
      'acme/tasks/task-1/assignments/2/working/draft.md',
    );
    expect(assignmentWorkingPrefix('acme', 'task-1', 2)).toBe(
      'acme/tasks/task-1/assignments/2/working/',
    );
  });

  it('builds the assignment completed key and prefix', () => {
    expect(assignmentCompletedKey('acme', 'task-1', 2, 'report.md')).toBe(
      'acme/tasks/task-1/assignments/2/completed/report.md',
    );
    expect(assignmentCompletedPrefix('acme', 'task-1', 2)).toBe(
      'acme/tasks/task-1/assignments/2/completed/',
    );
  });

  it('builds the orphan assignment working key and prefix', () => {
    expect(orphanWorkingKey('acme', 'assignment-1', 'notes.md')).toBe(
      'acme/assignments/assignment-1/working/notes.md',
    );
    expect(orphanWorkingPrefix('acme', 'assignment-1')).toBe(
      'acme/assignments/assignment-1/working/',
    );
  });
});

describe('resolveArtifactKey', () => {
  const companySlug = 'acme';
  const task = { id: 'task-1' };

  it('returns null for inline-text', () => {
    const artifact: TcpArtifact = { type: 'inline-text', value: 'any text' };
    expect(resolveArtifactKey(artifact, { companySlug })).toBeNull();
  });

  it('resolves task-materials-path against the task', () => {
    const artifact: TcpArtifact = {
      type: 'task-materials-path',
      value: 'brief.md',
    };
    expect(resolveArtifactKey(artifact, { companySlug, task })).toBe(
      'acme/tasks/task-1/materials/brief.md',
    );
  });

  it('resolves task-completed-path against the task', () => {
    const artifact: TcpArtifact = {
      type: 'task-completed-path',
      value: 'report.md',
    };
    expect(resolveArtifactKey(artifact, { companySlug, task })).toBe(
      'acme/tasks/task-1/completed/report.md',
    );
  });

  it('throws when task-materials-path is resolved without a task', () => {
    const artifact: TcpArtifact = {
      type: 'task-materials-path',
      value: 'brief.md',
    };
    expect(() => resolveArtifactKey(artifact, { companySlug })).toThrow();
  });

  it('resolves assignment-working-path against a task assignment', () => {
    const artifact: TcpArtifact = {
      type: 'assignment-working-path',
      value: 'draft.md',
    };
    const assignment = { id: 'a-3', taskId: 'task-1', orderIndex: 3 };
    expect(resolveArtifactKey(artifact, { companySlug, assignment })).toBe(
      'acme/tasks/task-1/assignments/3/working/draft.md',
    );
  });

  it('resolves assignment-working-path against an orphan assignment', () => {
    const artifact: TcpArtifact = {
      type: 'assignment-working-path',
      value: 'notes.md',
    };
    const assignment = { id: 'orphan-1', taskId: null, orderIndex: null };
    expect(resolveArtifactKey(artifact, { companySlug, assignment })).toBe(
      'acme/assignments/orphan-1/working/notes.md',
    );
  });

  it('resolves assignment-completed-path to the most recent prior assignment that approved the value', () => {
    // report.md is approved by assignments 0 and 2; a material on assignment 3
    // must resolve to assignment 2's completed directory, not assignment 0's.
    const planAssignments: Pick<TcpAssignment, 'orderIndex' | 'approved'>[] = [
      {
        orderIndex: 0,
        approved: [{ type: 'assignment-completed-path', value: 'report.md' }],
      },
      { orderIndex: 1, approved: [] },
      {
        orderIndex: 2,
        approved: [{ type: 'assignment-completed-path', value: 'report.md' }],
      },
    ];
    const artifact: TcpArtifact = {
      type: 'assignment-completed-path',
      value: 'report.md',
    };
    const assignment = { id: 'a-3', taskId: 'task-1', orderIndex: 3 };
    expect(
      resolveArtifactKey(artifact, {
        companySlug,
        task,
        planAssignments,
        assignment,
      }),
    ).toBe('acme/tasks/task-1/assignments/2/completed/report.md');
  });

  it('searches the whole plan when no current assignment is given (task-level material)', () => {
    const planAssignments: Pick<TcpAssignment, 'orderIndex' | 'approved'>[] = [
      {
        orderIndex: 0,
        approved: [{ type: 'assignment-completed-path', value: 'report.md' }],
      },
      {
        orderIndex: 2,
        approved: [{ type: 'assignment-completed-path', value: 'report.md' }],
      },
    ];
    const artifact: TcpArtifact = {
      type: 'assignment-completed-path',
      value: 'report.md',
    };
    expect(
      resolveArtifactKey(artifact, { companySlug, task, planAssignments }),
    ).toBe('acme/tasks/task-1/assignments/2/completed/report.md');
  });

  it('throws when assignment-completed-path has no matching prior assignment', () => {
    const artifact: TcpArtifact = {
      type: 'assignment-completed-path',
      value: 'missing.md',
    };
    expect(() =>
      resolveArtifactKey(artifact, {
        companySlug,
        task,
        planAssignments: [],
        assignment: { id: 'a-3', taskId: 'task-1', orderIndex: 3 },
      }),
    ).toThrow();
  });
});

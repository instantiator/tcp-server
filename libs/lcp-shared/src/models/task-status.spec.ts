import type { TcpAssignment } from './TcpAssignment.model';
import { deriveTaskStatus, selectNextAssignments } from './task-status';

function assignment(
  status: TcpAssignment['status'],
): Pick<TcpAssignment, 'status'> {
  return { status };
}

/** A plan step with just the fields `selectNextAssignments` inspects. */
function step(
  status: TcpAssignment['status'],
  orderIndex: number,
): Pick<TcpAssignment, 'status' | 'orderIndex'> {
  return { status, orderIndex };
}

describe('deriveTaskStatus', () => {
  it('keeps a terminal current status regardless of assignments', () => {
    expect(deriveTaskStatus('succeeded', [assignment('failed')])).toBe(
      'succeeded',
    );
    expect(deriveTaskStatus('failed', [assignment('succeeded')])).toBe(
      'failed',
    );
    expect(deriveTaskStatus('cancelled', [])).toBe('cancelled');
  });

  it('keeps finalising sticky even when the plan is all succeeded', () => {
    expect(
      deriveTaskStatus('finalising', [
        assignment('succeeded'),
        assignment('succeeded'),
      ]),
    ).toBe('finalising');
  });

  it('returns failed when any assignment failed', () => {
    expect(
      deriveTaskStatus('in-progress', [
        assignment('succeeded'),
        assignment('failed'),
      ]),
    ).toBe('failed');
  });

  it('returns cancelled when any assignment is cancelled and none failed', () => {
    expect(
      deriveTaskStatus('in-progress', [
        assignment('succeeded'),
        assignment('cancelled'),
      ]),
    ).toBe('cancelled');
  });

  it('prefers failed over cancelled when both are present', () => {
    expect(
      deriveTaskStatus('in-progress', [
        assignment('failed'),
        assignment('cancelled'),
      ]),
    ).toBe('failed');
  });

  it('returns in-progress when any assignment is in-progress', () => {
    expect(
      deriveTaskStatus('ready', [
        assignment('ready'),
        assignment('in-progress'),
      ]),
    ).toBe('in-progress');
  });

  it('returns in-progress when any assignment is in-qa', () => {
    expect(
      deriveTaskStatus('ready', [assignment('succeeded'), assignment('in-qa')]),
    ).toBe('in-progress');
  });

  it('returns succeeded when there is at least one assignment and all succeeded', () => {
    expect(
      deriveTaskStatus('in-progress', [
        assignment('succeeded'),
        assignment('succeeded'),
      ]),
    ).toBe('succeeded');
  });

  it('does not return succeeded when there are no assignments', () => {
    expect(deriveTaskStatus('in-progress', [])).toBe('ready');
  });

  it('preserves planning while the planner has not produced a plan yet', () => {
    expect(deriveTaskStatus('planning', [])).toBe('planning');
  });

  it('leaves planning once plan assignments exist', () => {
    expect(deriveTaskStatus('planning', [assignment('ready')])).toBe('ready');
  });

  it('defaults to ready otherwise', () => {
    expect(deriveTaskStatus('ready', [assignment('ready')])).toBe('ready');
  });
});

describe('selectNextAssignments', () => {
  it('returns nothing while an assignment is in-progress', () => {
    expect(
      selectNextAssignments([step('in-progress', 0), step('ready', 1)]),
    ).toEqual([]);
  });

  it('returns nothing while an assignment is in-qa', () => {
    expect(selectNextAssignments([step('in-qa', 0), step('ready', 1)])).toEqual(
      [],
    );
  });

  it('returns the lowest-orderIndex ready assignment when nothing runs', () => {
    const two = step('ready', 2);
    const one = step('ready', 1);
    expect(selectNextAssignments([two, one])).toEqual([one]);
  });

  it('skips a completed lower step and picks the next ready one', () => {
    const next = step('ready', 1);
    expect(selectNextAssignments([step('succeeded', 0), next])).toEqual([next]);
  });

  it('returns nothing when the plan is empty', () => {
    expect(selectNextAssignments([])).toEqual([]);
  });

  it('returns nothing when all assignments have succeeded', () => {
    expect(
      selectNextAssignments([step('succeeded', 0), step('succeeded', 1)]),
    ).toEqual([]);
  });

  it('returns nothing when a step has failed (no ready steps remain)', () => {
    expect(
      selectNextAssignments([step('succeeded', 0), step('failed', 1)]),
    ).toEqual([]);
  });
});

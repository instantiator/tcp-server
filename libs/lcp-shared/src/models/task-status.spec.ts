import type { LcpAssignment } from './LcpAssignment.model';
import { deriveTaskStatus } from './task-status';

function assignment(
  status: LcpAssignment['status'],
): Pick<LcpAssignment, 'status'> {
  return { status };
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

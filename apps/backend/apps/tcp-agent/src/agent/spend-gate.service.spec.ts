import {
  AgentStatus,
  AuditClientService,
  SpendCapState,
  TcpAgent,
  TcpTask,
  type CapAction,
  type CapDismissal,
} from '@tcp/shared';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Repository } from 'typeorm';
import { SpendGateService } from './spend-gate.service';

const HOUR = 60 * 60 * 1000;

/** A cap state row for `lm-studio`, reached for another hour unless overridden. */
function capState(
  overrides: {
    action?: CapAction;
    dismissal?: CapDismissal;
    reachedUntil?: Date;
  } = {},
): SpendCapState {
  return {
    provider: 'lm-studio',
    windowStarts: {},
    reachedUntil: new Date(Date.now() + HOUR),
    action: 'pause',
    dismissal: 'none',
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('SpendGateService', () => {
  const taskId = randomUUID();
  let state: SpendCapState | null;
  let task: Partial<TcpTask> | null;
  let agentUpdate: jest.Mock;
  let auditRecord: jest.Mock;
  let gate: SpendGateService;

  /** An agent working on `taskId` (or on no task). */
  const agent = (onTask = true): TcpAgent =>
    ({
      id: randomUUID(),
      companyId: randomUUID(),
      role: { name: 'analyst' },
      assignment: { taskId: onTask ? taskId : null },
    }) as TcpAgent;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    state = capState();
    task = { id: taskId, spendCapExempt: false };
    agentUpdate = jest.fn().mockResolvedValue(undefined);
    auditRecord = jest.fn();
    gate = new SpendGateService(
      {
        findOneBy: () => Promise.resolve(state),
      } as unknown as Repository<SpendCapState>,
      {
        findOneBy: () => Promise.resolve(task),
      } as unknown as Repository<TcpTask>,
      { update: agentUpdate } as unknown as Repository<TcpAgent>,
      { record: auditRecord } as unknown as AuditClientService,
    );
  });

  it('holds a run back and pauses the agent for the cap when a pause cap is reached', async () => {
    const a = agent();
    await expect(gate.forRun(a, 'lm-studio', false)()).resolves.toBe(true);

    expect(agentUpdate).toHaveBeenCalledWith(
      a.id,
      expect.objectContaining({
        status: AgentStatus.Paused,
        pauseReason: 'spend_cap',
      }),
    );
    expect(auditRecord).toHaveBeenCalledTimes(1);
  });

  it('holds back an agent with no task (e.g. a consultation)', async () => {
    await expect(gate.forRun(agent(false), 'lm-studio', false)()).resolves.toBe(
      true,
    );
  });

  it.each([
    ['no cap state yet', () => (state = null)],
    [
      'the cap is not reached',
      () => (state = capState({ reachedUntil: undefined })),
    ],
    [
      'the reached window has already ended',
      () => (state = capState({ reachedUntil: new Date(Date.now() - 1) })),
    ],
    [
      'the cap is dismissed until reset',
      () => (state = capState({ dismissal: 'until-reset' })),
    ],
    [
      'the cap is dismissed indefinitely',
      () => (state = capState({ dismissal: 'indefinite' })),
    ],
    ['the task is exempt', () => (task = { id: taskId, spendCapExempt: true })],
    [
      'the action only finishes tasks',
      () => (state = capState({ action: 'finish-tasks' })),
    ],
  ])('lets the run spend when %s', async (_case, arrange) => {
    arrange();
    await expect(gate.forRun(agent(), 'lm-studio', true)()).resolves.toBe(
      false,
    );
    expect(agentUpdate).not.toHaveBeenCalled();
  });

  describe('with a finish-agents cap', () => {
    beforeEach(() => {
      state = capState({ action: 'finish-agents' });
    });

    it('holds back a fresh start before its first LLM call', async () => {
      await expect(gate.forRun(agent(), 'lm-studio', true)()).resolves.toBe(
        true,
      );
    });

    it('lets a resumed agent finish', async () => {
      await expect(gate.forRun(agent(), 'lm-studio', false)()).resolves.toBe(
        false,
      );
    });

    it('lets a started agent finish when the cap is reached mid-run', async () => {
      state = null;
      const hold = gate.forRun(agent(), 'lm-studio', true);
      await expect(hold()).resolves.toBe(false);

      state = capState({ action: 'finish-agents' });
      await expect(hold()).resolves.toBe(false);
    });
  });
});

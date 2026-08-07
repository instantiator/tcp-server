import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AssignmentService } from './assignment.service';
import { InternalTaskController } from './internal-task.controller';

describe('InternalTaskController', () => {
  let assignments: {
    getAgentAssignment: jest.Mock;
    planTask: jest.Mock;
    completeAssignment: jest.Mock;
    assureAssignment: jest.Mock;
  };
  let controller: InternalTaskController;

  const agentId = randomUUID();
  const id = randomUUID();

  beforeEach(() => {
    assignments = {
      getAgentAssignment: jest
        .fn()
        .mockResolvedValue({ assignment: {}, task: null }),
      planTask: jest.fn().mockResolvedValue({ created: 1 }),
      completeAssignment: jest.fn().mockResolvedValue(undefined),
      assureAssignment: jest.fn().mockResolvedValue(undefined),
    };
    controller = new InternalTaskController(
      assignments as unknown as AssignmentService,
    );
  });

  it('delegates getAssignment', async () => {
    await controller.getAssignment(agentId);
    expect(assignments.getAgentAssignment).toHaveBeenCalledWith(agentId);
  });

  it('delegates planTask', async () => {
    await controller.planTask(id, { agentId, assignments: [] });
    expect(assignments.planTask).toHaveBeenCalledWith(id, agentId, []);
  });

  it('delegates complete', async () => {
    await controller.complete(id, {
      agentId,
      summary: 'done',
      prepared: [],
    });
    expect(assignments.completeAssignment).toHaveBeenCalledWith(
      id,
      agentId,
      'done',
      [],
    );
  });

  it('accepts a reject with feedback', async () => {
    await controller.assure(id, { agentId, qa: 'reject', feedback: 'fix it' });
    expect(assignments.assureAssignment).toHaveBeenCalledWith(
      id,
      agentId,
      'reject',
      'fix it',
    );
  });

  it('400s a reject without feedback before touching the service', async () => {
    await expect(
      controller.assure(id, { agentId, qa: 'reject' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(assignments.assureAssignment).not.toHaveBeenCalled();
  });
});

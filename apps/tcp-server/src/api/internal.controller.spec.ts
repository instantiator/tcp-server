import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { CompanyUser, TcpAgent, TcpRole } from '@tcp/shared';
import { DbService } from '../db/db.service';
import { InternalController } from './internal.controller';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskFailureService } from './task-failure.service';

describe('InternalController', () => {
  let pauseResume: {
    pauseForUserInput: jest.Mock;
    pauseForConsultation: jest.Mock;
    completeAgent: jest.Mock;
    failAgent: jest.Mock;
    updateStorageChanges: jest.Mock;
  };
  let taskFailures: {
    handleAgentFailed: jest.Mock;
    handleAgentCompleted: jest.Mock;
  };
  let db: {
    getCompany: jest.Mock;
    findRoleByIdOrSlug: jest.Mock;
    listRoles: jest.Mock;
  };
  let agentRepo: { findOneBy: jest.Mock };
  let roleRepo: { findBy: jest.Mock };
  let userRepo: { findBy: jest.Mock };
  let controller: InternalController;

  beforeEach(() => {
    pauseResume = {
      pauseForUserInput: jest.fn(),
      pauseForConsultation: jest.fn(),
      completeAgent: jest.fn().mockResolvedValue(undefined),
      failAgent: jest.fn().mockResolvedValue(undefined),
      updateStorageChanges: jest.fn().mockResolvedValue(undefined),
    };
    taskFailures = {
      handleAgentFailed: jest.fn().mockResolvedValue(undefined),
      handleAgentCompleted: jest.fn().mockResolvedValue(undefined),
    };
    db = {
      getCompany: jest.fn(),
      findRoleByIdOrSlug: jest.fn(),
      listRoles: jest.fn().mockResolvedValue([]),
    };
    agentRepo = { findOneBy: jest.fn() };
    roleRepo = { findBy: jest.fn() };
    userRepo = { findBy: jest.fn() };
    controller = new InternalController(
      pauseResume as unknown as PauseAndResumeService,
      taskFailures as unknown as TaskFailureService,
      db as unknown as DbService,
      agentRepo as unknown as Repository<TcpAgent>,
      roleRepo as unknown as Repository<TcpRole>,
      userRepo as unknown as Repository<CompanyUser>,
    );
  });

  describe('pause — user_input', () => {
    it('delegates to pauseForUserInput and returns slug', async () => {
      const agentId = randomUUID();
      pauseResume.pauseForUserInput.mockResolvedValue({ slug: 'analyst-3' });

      const result = await controller.pause({
        type: 'user_input',
        agentId,
        question: 'What should we do?',
        context: 'Background info.',
      });

      expect(pauseResume.pauseForUserInput).toHaveBeenCalledWith(
        agentId,
        'What should we do?',
        'Background info.',
        undefined,
      );
      expect(result).toEqual({ slug: 'analyst-3' });
    });

    it('forwards userIds when targeting specific users', async () => {
      const agentId = randomUUID();
      const userIds = [randomUUID(), randomUUID()];
      pauseResume.pauseForUserInput.mockResolvedValue({ slug: 'analyst-4' });

      await controller.pause({
        type: 'user_input',
        agentId,
        question: 'What should we do?',
        userIds,
      });

      expect(pauseResume.pauseForUserInput).toHaveBeenCalledWith(
        agentId,
        'What should we do?',
        undefined,
        userIds,
      );
    });
  });

  describe('pause — agent_consultation', () => {
    it('delegates to pauseForConsultation and returns consultationId + roleName', async () => {
      const agentId = randomUUID();
      const companyId = randomUUID();
      const roleId = randomUUID();
      const consultationId = randomUUID();
      db.getCompany.mockResolvedValue({ id: companyId });
      db.findRoleByIdOrSlug.mockResolvedValue({ id: roleId });
      pauseResume.pauseForConsultation.mockResolvedValue({
        consultationId,
        roleName: 'Legal Advisor',
      });

      const result = await controller.pause({
        type: 'agent_consultation',
        agentId,
        companyId,
        roleId,
        roleName: 'legal-advisor',
        question: 'Is this compliant?',
      });

      expect(db.getCompany).toHaveBeenCalledWith(companyId);
      expect(db.findRoleByIdOrSlug).toHaveBeenCalledWith(companyId, roleId);
      expect(pauseResume.pauseForConsultation).toHaveBeenCalledWith(
        agentId,
        companyId,
        roleId,
        'Is this compliant?',
        undefined,
        'legal-advisor',
      );
      expect(result).toEqual({
        consultationId,
        roleName: 'Legal Advisor',
      });
    });

    it('resolves companySlug and roleSlug to real UUIDs before delegating', async () => {
      const agentId = randomUUID();
      const companyId = randomUUID();
      const roleId = randomUUID();
      db.getCompany.mockResolvedValue({ id: companyId });
      db.findRoleByIdOrSlug.mockResolvedValue({ id: roleId });
      pauseResume.pauseForConsultation.mockResolvedValue({
        consultationId: randomUUID(),
        roleName: 'Legal Advisor',
      });

      await controller.pause({
        type: 'agent_consultation',
        agentId,
        companySlug: 'acme',
        roleSlug: 'legal-advisor',
        question: 'Is this compliant?',
      });

      expect(db.getCompany).toHaveBeenCalledWith('acme');
      expect(db.findRoleByIdOrSlug).toHaveBeenCalledWith(
        companyId,
        'legal-advisor',
      );
      expect(pauseResume.pauseForConsultation).toHaveBeenCalledWith(
        agentId,
        companyId,
        roleId,
        'Is this compliant?',
        undefined,
        undefined,
      );
    });

    it('throws NotFoundException when the company does not resolve', async () => {
      db.getCompany.mockResolvedValue(null);
      await expect(
        controller.pause({
          type: 'agent_consultation',
          agentId: randomUUID(),
          companySlug: 'no-such-co',
          roleSlug: 'analyst',
          question: 'Q',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the role does not resolve', async () => {
      db.getCompany.mockResolvedValue({ id: randomUUID() });
      db.findRoleByIdOrSlug.mockResolvedValue(null);
      await expect(
        controller.pause({
          type: 'agent_consultation',
          agentId: randomUUID(),
          companyId: randomUUID(),
          roleSlug: 'no-such-role',
          question: 'Q',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when neither companyId nor companySlug is given', async () => {
      await expect(
        controller.pause({
          type: 'agent_consultation',
          agentId: randomUUID(),
          roleId: randomUUID(),
          question: 'Q',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when neither roleId nor roleSlug is given', async () => {
      db.getCompany.mockResolvedValue({ id: randomUUID() });
      await expect(
        controller.pause({
          type: 'agent_consultation',
          agentId: randomUUID(),
          companyId: randomUUID(),
          question: 'Q',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('complete', () => {
    it('delegates to completeAgent and returns void', async () => {
      const agentId = randomUUID();

      await controller.complete(agentId, { output: 'My final answer.' });

      expect(pauseResume.completeAgent).toHaveBeenCalledWith(
        agentId,
        'My final answer.',
      );
      expect(taskFailures.handleAgentCompleted).toHaveBeenCalledWith(agentId);
    });
  });

  describe('fail', () => {
    it('delegates to failAgent with the reason', async () => {
      const agentId = randomUUID();

      await controller.fail(agentId, {
        reason: 'Agent ended without calling complete_task',
      });

      expect(pauseResume.failAgent).toHaveBeenCalledWith(
        agentId,
        'Agent ended without calling complete_task',
      );
    });
  });

  describe('getAgent', () => {
    it('returns id and storageChanges when agent exists', async () => {
      const agentId = randomUUID();
      agentRepo.findOneBy.mockResolvedValue({
        id: agentId,
        storageChanges: {
          created: ['docs/report.md'],
          modified: [],
          deleted: [],
          moved: [],
        },
      });

      const result = await controller.getAgent(agentId);

      expect(result).toEqual({
        id: agentId,
        storageChanges: {
          created: ['docs/report.md'],
          modified: [],
          deleted: [],
          moved: [],
        },
      });
    });

    it('throws NotFoundException when agent does not exist', async () => {
      agentRepo.findOneBy.mockResolvedValue(null);
      await expect(controller.getAgent(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStorage', () => {
    it('delegates to updateStorageChanges and returns void', async () => {
      const agentId = randomUUID();

      await controller.updateStorage(agentId, { created: ['docs/out.md'] });

      expect(pauseResume.updateStorageChanges).toHaveBeenCalledWith(agentId, {
        created: ['docs/out.md'],
      });
    });
  });

  describe('listRoles', () => {
    it('returns roles for the given company', async () => {
      const companyId = randomUUID();
      const roles = [{ id: randomUUID(), name: 'analyst', companyId }];
      roleRepo.findBy.mockResolvedValue(roles);

      const result = await controller.listRoles(companyId);

      expect(roleRepo.findBy).toHaveBeenCalledWith({ companyId });
      expect(result).toEqual(roles);
    });
  });

  describe('listUsers', () => {
    it('returns users for the given company', async () => {
      const companyId = randomUUID();
      const users = [{ id: randomUUID(), identifier: 'alice', companyId }];
      userRepo.findBy.mockResolvedValue(users);

      const result = await controller.listUsers(companyId);

      expect(userRepo.findBy).toHaveBeenCalledWith({ companyId });
      expect(result).toEqual(users);
    });
  });
});

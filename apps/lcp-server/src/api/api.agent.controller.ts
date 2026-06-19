import { LcpAgent } from '@lcp/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DbService } from '../db/db.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { LcpAgentTemplate } from '../templates/LcpAgentTemplate';
import { AgentOrchestrationService } from './agent-orchestration.service';

/** REST controller for starting, resuming, and inspecting {@link LcpAgent} instances. */
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/agent' })
export class AgentController {
  constructor(
    private readonly db: DbService,
    private readonly orchestration: AgentOrchestrationService,
  ) {}

  /**
   * Creates a new agent and dispatches it to the lcp-agent worker pool.
   * Returns the agent record immediately; status starts as `idle`.
   */
  @Post('start')
  async startAgent(@Body() body: LcpAgentTemplate): Promise<LcpAgent> {
    if (!body.companyId || !body.roleId || !body.initialPrompt) {
      throw new BadRequestException(
        'companyId, roleId, and initialPrompt are required',
      );
    }
    return this.orchestration.startAgent(body);
  }

  /**
   * Dispatches a resume job for an existing agent.
   * The agent must be in `idle`, `paused`, or `failed` status.
   */
  @Post('resume/:id')
  async resumeAgent(@Param('id') id: string): Promise<LcpAgent> {
    try {
      return await this.orchestration.resumeAgent(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) throw new NotFoundException(msg);
      throw new BadRequestException(msg);
    }
  }

  /** Retrieves the current state of an agent by its UUID. */
  @Get(':id')
  async getAgent(@Param('id') id: string): Promise<LcpAgent> {
    const agent = await this.db.getAgent(id);
    if (!agent) throw new NotFoundException(`Agent ${id} not found`);
    return agent;
  }
}

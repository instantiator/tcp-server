import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  MessageEvent,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  Res,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UUID } from 'crypto';
import type { Request, Response } from 'express';
import { AuditEventType, LcpCompany, LcpRole, WireEvent } from '@lcp/shared';
import { defer, from, merge, mergeMap, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { DbService } from '../db/db.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyEventService } from '../events/company-event.service';
import { ApiService } from './api.service';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import { UpdateRoleDto } from './dto/role.dto';
import { TaskService } from './task.service';
import { isUUID } from '../utils/ObjectUtils';
import {
  computeCompanyWarnings,
  computeRoleWarnings,
  setWarningsHeader,
} from './validation-warnings';

/** REST controller for company (tenant) create, read, and update operations. */
@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/company' })
export class CompanyController {
  constructor(
    private readonly api: ApiService,
    private readonly db: DbService,
    private readonly tasks: TaskService,
    private readonly companyEvents: CompanyEventService,
  ) {}

  /** Returns all {@link LcpCompany} records. */
  @ApiOperation({ summary: 'List all companies' })
  @Get()
  async listCompanies(): Promise<LcpCompany[]> {
    return this.db.listCompanies();
  }

  /**
   * Creates or replaces a {@link LcpCompany}.
   * If a company with the same slug already exists it is replaced.
   * The requesting user (from the bearer token's `sub` claim) is added as a
   * {@link CompanyUser} with `memberType: 'creator'`.
   */
  @ApiOperation({ summary: 'Create or replace a company' })
  @Post()
  async postCompany(
    @Body() body: CreateCompanyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LcpCompany> {
    const { slug, ...template } = body;
    const user = req.user as Record<string, unknown> | undefined;
    const creatorIdentifier =
      typeof user?.sub === 'string' ? user.sub : 'unknown';
    const creatorName =
      (typeof user?.email === 'string' ? user.email : undefined) ??
      (typeof user?.preferred_username === 'string'
        ? user.preferred_username
        : undefined) ??
      (typeof user?.name === 'string' ? user.name : undefined) ??
      null;
    const company = await this.api.createCompany(
      { ...template, mcpServerList: template.mcpServerList ?? [] },
      slug,
      creatorIdentifier,
      creatorName,
    );
    setWarningsHeader(res, computeCompanyWarnings(company));
    return company;
  }

  /**
   * Partially updates the fields of an existing {@link LcpCompany} identified
   * by UUID or slug. Accepts a partial body so nested fields such as
   * `llmConfig.model` can be patched without overwriting the whole object.
   * The `id` field is immutable and must not be included in the request body.
   * Soft data-quality warnings (e.g. blank `companyContext`) are reported via
   * the `X-Lcp-Warnings` response header — the update still succeeds.
   */
  @ApiOperation({ summary: 'Partially update a company by ID or slug' })
  @Put(':id')
  async putCompany(
    @Param('id') id: string,
    @Body() partial: UpdateCompanyDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LcpCompany> {
    const company = await this.api.setCompany(id, partial);
    setWarningsHeader(res, computeCompanyWarnings(company));
    return company;
  }

  /**
   * Retrieves a {@link LcpCompany} by its UUID or slug.
   * Returns `null` (serialised as an empty body) when no company matches.
   */
  @ApiOperation({ summary: 'Get a company by ID or slug' })
  @Get(':id')
  async getCompany(@Param('id') id: UUID): Promise<LcpCompany | null> {
    return await this.api.getCompany(id);
  }

  /**
   * Deletes a company by UUID or slug. Cascades to its roles, agents, audit
   * events, conversations, knowledge chunks, episodic memory, and company
   * users (see the `AddMissingCompanyRoleForeignKeys` migration).
   */
  @ApiOperation({ summary: 'Delete a company by ID or slug' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCompany(@Param('id') id: string): Promise<void> {
    const company = await this.resolveCompanyOrThrow(id);
    await this.db.deleteCompany(company.id);
  }

  /**
   * Returns all {@link LcpRole} records belonging to the given company,
   * identified by UUID or slug.
   */
  @ApiOperation({ summary: 'List roles for a company by ID or slug' })
  @Get(':id/roles')
  async listRoles(@Param('id') id: string): Promise<LcpRole[]> {
    const company = await this.resolveCompanyOrThrow(id);
    return this.db.listRoles(company.id);
  }

  /**
   * Retrieves a role within this company by its UUID or slug. A bare role
   * slug is ambiguous without a company (role slugs are only unique within
   * their company, not globally) — this route resolves that ambiguity by
   * scoping the lookup to `companyId` (itself UUID-or-slug).
   */
  @ApiOperation({ summary: 'Get a role by slug (or ID) within a company' })
  @Get(':companyId/roles/by-slug/:slug')
  async getRoleBySlug(
    @Param('companyId') companyId: string,
    @Param('slug') slug: string,
  ): Promise<LcpRole> {
    const company = await this.resolveCompanyOrThrow(companyId);
    const role = await this.db.findRoleByIdOrSlug(company.id, slug);
    if (!role) {
      throw new NotFoundException(
        `Role ${slug} not found in company ${company.id}`,
      );
    }
    return role;
  }

  /**
   * Partially updates a role within this company, identified by UUID or
   * slug. See {@link getRoleBySlug} for why the company must be known. See
   * {@link RoleController.createRole} for the `X-Lcp-Warnings` header.
   */
  @ApiOperation({ summary: 'Update a role by slug (or ID) within a company' })
  @Put(':companyId/roles/by-slug/:slug')
  async putRoleBySlug(
    @Param('companyId') companyId: string,
    @Param('slug') slug: string,
    @Body() partial: UpdateRoleDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LcpRole> {
    const company = await this.resolveCompanyOrThrow(companyId);
    const role = await this.db.setRole(
      { ...partial, companyId: company.id },
      isUUID(slug) ? { id: slug } : { slug },
    );
    setWarningsHeader(res, computeRoleWarnings(role));
    return role;
  }

  /**
   * Deletes a role within this company, identified by UUID or slug. See
   * {@link getRoleBySlug} for why the company must be known. Cascades to
   * the role's agents, knowledge chunks, episodic memory, and conversations.
   */
  @ApiOperation({ summary: 'Delete a role by slug (or ID) within a company' })
  @Delete(':companyId/roles/by-slug/:slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRoleBySlug(
    @Param('companyId') companyId: string,
    @Param('slug') slug: string,
  ): Promise<void> {
    const company = await this.resolveCompanyOrThrow(companyId);
    const role = await this.db.findRoleByIdOrSlug(company.id, slug);
    if (!role) {
      throw new NotFoundException(
        `Role ${slug} not found in company ${company.id}`,
      );
    }
    await this.db.deleteRole(role.id);
  }

  /**
   * SSE stream of `company_changed`/`task_changed` events for this company
   * and its tasks. Primed with the company's current state and every current
   * task's summary, so a client that subscribes late renders immediately,
   * then live updates via {@link CompanyEventService}.
   */
  @ApiOperation({ summary: "Stream a company's and its tasks' events" })
  @Sse(':id/events')
  streamCompanyEvents(@Param('id') id: string): Observable<MessageEvent> {
    return defer(() => from(this.buildCompanyStream(id))).pipe(
      mergeMap((events$) => events$),
      map((event) => ({ data: event })),
    );
  }

  /**
   * Resolves `id` once, then merges the priming events with the live
   * {@link CompanyEventService} observable for the resolved company UUID.
   */
  private async buildCompanyStream(id: string): Promise<Observable<WireEvent>> {
    const company = await this.resolveCompanyOrThrow(id);
    const primed = await this.primeCompanyEvents(company.id);
    return merge(from(primed), this.companyEvents.observe(company.id));
  }

  /**
   * Builds the priming {@link WireEvent}s for {@link buildCompanyStream}: the
   * company signal, then each task's current summary — synthesized
   * `state_change` rows (`reason:'replay'`) matching the live path's shapes.
   */
  private async primeCompanyEvents(companyId: UUID): Promise<WireEvent[]> {
    const timestamp = new Date().toISOString();
    const taskSummaries = await this.tasks.listChangeSummaries(companyId);
    return [
      {
        type: 'audit',
        event: {
          timestamp,
          companyId,
          role: 'system',
          agentId: null,
          assignmentId: null,
          taskId: null,
          eventType: AuditEventType.StateChange,
          payload: { entity: 'company', reason: 'replay' },
        },
      },
      ...taskSummaries.map(
        (summary): WireEvent => ({
          type: 'audit',
          event: {
            timestamp,
            companyId,
            role: 'orchestrator',
            agentId: null,
            assignmentId: null,
            taskId: summary.id,
            eventType: AuditEventType.StateChange,
            payload: {
              entity: 'task',
              newStatus: summary.status,
              reason: 'replay',
              summary,
            },
          },
        }),
      ),
    ];
  }

  /** Resolves a company by UUID or slug, throwing 404 if no match. */
  private async resolveCompanyOrThrow(identifier: string): Promise<LcpCompany> {
    const company = await this.db.getCompany(identifier);
    if (!company) {
      throw new NotFoundException(`Company ${identifier} not found`);
    }
    return company;
  }
}

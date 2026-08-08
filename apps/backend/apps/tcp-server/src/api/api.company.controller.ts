import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  MessageEvent,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  Sse,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { UUID } from 'crypto';
import type { Request, Response } from 'express';
import {
  CompanyListItem,
  emptyCompanyStats,
  TcpCompany,
  TcpRole,
  WireEvent,
} from '@tcp/shared';
import { defer, from, merge, mergeMap, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { DbService } from '../db/db.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { CompanyScope, NoCompanyScope } from '../auth/company-scope.decorator';
import { MembershipService } from '../auth/membership.service';
import { getCurrentUserIdentifiers } from '../auth/current-user';
import { CompanyEventService } from '../events/company-event.service';
import { ApiService } from './api.service';
import { CompanyPrimingService } from './company-priming.service';
import { CompanyStatsService } from './company-stats.service';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import { CompanyListItemDto } from './dto/company-stats.dto';
import { UpdateRoleDto } from './dto/role.dto';
import { CompanyResponseDto, RoleResponseDto } from './dto/entity-response.dto';
import { isUUID } from '../utils/ObjectUtils';
import {
  computeCompanyWarnings,
  computeRoleWarnings,
  setWarningsHeader,
} from './validation-warnings';

/** REST controller for company (tenant) create, read, and update operations. */
@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/company' })
export class CompanyController {
  constructor(
    private readonly api: ApiService,
    private readonly db: DbService,
    private readonly stats: CompanyStatsService,
    private readonly priming: CompanyPrimingService,
    private readonly companyEvents: CompanyEventService,
    private readonly membership: MembershipService,
  ) {}

  /**
   * Lists the companies the caller is a {@link CompanyUser} of, each with its
   * {@link CompanyStats} — the browser has to discover what the signed-in
   * user may see (ADR-023). `?all=true` returns every company instead, and is
   * **restricted to administrators** — the identifiers named in
   * `TCP_ADMIN_IDENTIFIERS` (ADR-011, phase-02 amendment). A caller who is not
   * one is refused rather than quietly given the scoped list: degrading one
   * request into a different one hides the fact that they lack the access.
   */
  @ApiOperation({
    summary: "List the caller's companies, with per-company statistics",
  })
  @ApiQuery({
    name: 'all',
    required: false,
    type: Boolean,
    description:
      "Return every company rather than the caller's memberships. Bare `?all` counts as true. Administrators only (`TCP_ADMIN_IDENTIFIERS`); 403 for anyone else.",
  })
  @ApiOkResponse({ type: CompanyListItemDto, isArray: true })
  @NoCompanyScope(
    'scoped to the caller in the handler; ?all=true is admin-only',
  )
  @Get()
  async listCompanies(
    @Req() req: Request,
    @Query('all') all?: string,
  ): Promise<CompanyListItem[]> {
    // `?all` bare and `?all=true` both mean every company. Anything else is
    // the membership-scoped default — a malformed flag must never widen scope.
    const wantsAll = all === 'true' || all === '';
    const identifiers = getCurrentUserIdentifiers(req);
    if (wantsAll && !this.membership.isAdmin(identifiers)) {
      throw new ForbiddenException(
        'Listing every company requires administrator access',
      );
    }
    const companies = await this.db.listCompanies(
      wantsAll ? undefined : identifiers,
    );
    // Stats accompany both modes — the administrative view wants them too.
    const stats = await this.stats.listStats(companies.map((c) => c.id));
    return companies.map((company) => ({
      ...company,
      stats: stats.get(company.id) ?? emptyCompanyStats(),
    }));
  }

  /**
   * Creates or replaces a {@link TcpCompany}.
   * If a company with the same slug already exists it is replaced.
   * The requesting user (from the bearer token's `sub` claim) is added as a
   * {@link CompanyUser} with `memberType: 'creator'`.
   */
  @ApiOperation({ summary: 'Create or replace a company' })
  @ApiOkResponse({ type: CompanyResponseDto })
  @NoCompanyScope(
    'any authenticated caller may create a company; becomes its creator',
  )
  @Post()
  async postCompany(
    @Body() body: CreateCompanyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TcpCompany> {
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
   * Partially updates the fields of an existing {@link TcpCompany} identified
   * by UUID or slug. Accepts a partial body so nested fields such as
   * `llmConfig.model` can be patched without overwriting the whole object.
   * The `id` field is immutable and must not be included in the request body.
   * Soft data-quality warnings (e.g. blank `companyContext`) are reported via
   * the `X-Tcp-Warnings` response header — the update still succeeds.
   */
  @ApiOperation({ summary: 'Partially update a company by ID or slug' })
  @ApiOkResponse({ type: CompanyResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'company' })
  @Put(':id')
  async putCompany(
    @Param('id') id: string,
    @Body() partial: UpdateCompanyDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TcpCompany> {
    const company = await this.api.setCompany(id, partial);
    setWarningsHeader(res, computeCompanyWarnings(company));
    return company;
  }

  /**
   * Retrieves a {@link TcpCompany} by its UUID or slug.
   * Returns `null` (serialised as an empty body) when no company matches.
   */
  @ApiOperation({ summary: 'Get a company by ID or slug' })
  @ApiOkResponse({ type: CompanyResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'company' })
  @Get(':id')
  async getCompany(@Param('id') id: UUID): Promise<TcpCompany | null> {
    return await this.api.getCompany(id);
  }

  /**
   * Deletes a company by UUID or slug. Cascades to its roles, agents, audit
   * events, conversations, knowledge chunks, episodic memory, and company
   * users (see the `AddMissingCompanyRoleForeignKeys` migration).
   */
  @ApiOperation({ summary: 'Delete a company by ID or slug' })
  @CompanyScope({ from: 'param', key: 'id', via: 'company' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCompany(@Param('id') id: string): Promise<void> {
    const company = await this.resolveCompanyOrThrow(id);
    await this.db.deleteCompany(company.id);
  }

  /**
   * Returns all {@link TcpRole} records belonging to the given company,
   * identified by UUID or slug.
   */
  @ApiOperation({ summary: 'List roles for a company by ID or slug' })
  @ApiOkResponse({ type: RoleResponseDto, isArray: true })
  @CompanyScope({ from: 'param', key: 'id', via: 'company' })
  @Get(':id/roles')
  async listRoles(@Param('id') id: string): Promise<TcpRole[]> {
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
  @ApiOkResponse({ type: RoleResponseDto })
  @CompanyScope({ from: 'param', key: 'companyId', via: 'company' })
  @Get(':companyId/roles/by-slug/:slug')
  async getRoleBySlug(
    @Param('companyId') companyId: string,
    @Param('slug') slug: string,
  ): Promise<TcpRole> {
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
   * {@link RoleController.createRole} for the `X-Tcp-Warnings` header.
   */
  @ApiOperation({ summary: 'Update a role by slug (or ID) within a company' })
  @ApiOkResponse({ type: RoleResponseDto })
  @CompanyScope({ from: 'param', key: 'companyId', via: 'company' })
  @Put(':companyId/roles/by-slug/:slug')
  async putRoleBySlug(
    @Param('companyId') companyId: string,
    @Param('slug') slug: string,
    @Body() partial: UpdateRoleDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TcpRole> {
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
  @CompanyScope({ from: 'param', key: 'companyId', via: 'company' })
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
   * SSE stream of this company's `state_change` events — company, task,
   * agent, assignment and enquiry rows (ADR-023). Primed by
   * {@link CompanyPrimingService} with the current state of each of those
   * lists, so a client that subscribes late renders immediately, then live
   * updates via {@link CompanyEventService}.
   */
  @ApiOperation({
    summary:
      "Stream a company's company, task, agent, assignment and enquiry events",
  })
  @CompanyScope({ from: 'param', key: 'id', via: 'company' })
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
    const primed = await this.priming.prime(company.id);
    return merge(from(primed), this.companyEvents.observe(company.id));
  }

  /** Resolves a company by UUID or slug, throwing 404 if no match. */
  private async resolveCompanyOrThrow(identifier: string): Promise<TcpCompany> {
    const company = await this.db.getCompany(identifier);
    if (!company) {
      throw new NotFoundException(`Company ${identifier} not found`);
    }
    return company;
  }
}

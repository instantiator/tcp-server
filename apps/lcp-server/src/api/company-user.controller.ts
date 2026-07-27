import { CompanyUser } from '@tcp/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CreateCompanyUserDto,
  UpdateCompanyUserDto,
} from './dto/company-user.dto';

/** REST controller for per-company human user management. */
@ApiTags('company-users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/company/:companyId/users' })
export class CompanyUserController {
  constructor(
    @InjectRepository(CompanyUser)
    private readonly users: Repository<CompanyUser>,
  ) {}

  /** Returns all users belonging to the given company. */
  @ApiOperation({ summary: 'List users in a company' })
  @Get()
  async listUsers(@Param('companyId') companyId: UUID): Promise<CompanyUser[]> {
    return this.users.findBy({ companyId });
  }

  /**
   * Adds a user to the company.
   * Returns 409 if a user with the same identifier already exists (DB unique constraint).
   */
  @ApiOperation({ summary: 'Add a user to a company' })
  @Post()
  async createUser(
    @Param('companyId') companyId: UUID,
    @Body() body: CreateCompanyUserDto,
  ): Promise<CompanyUser> {
    const user = this.users.create({
      companyId,
      identifier: body.identifier,
      name: body.name ?? null,
      memberType: body.memberType,
      roles: body.roles ?? [],
      knowledgeDomains: body.knowledgeDomains ?? [],
    });
    return this.users.save(user);
  }

  /** Partially updates a user's name, memberType, roles, or knowledgeDomains. */
  @ApiOperation({ summary: 'Update a company user' })
  @Patch(':userId')
  async updateUser(
    @Param('companyId') companyId: UUID,
    @Param('userId') userId: UUID,
    @Body() body: UpdateCompanyUserDto,
  ): Promise<CompanyUser> {
    const user = await this.users.findOne({ where: { id: userId, companyId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    if (body.name !== undefined) user.name = body.name;
    if (body.memberType !== undefined) user.memberType = body.memberType;
    if (body.roles !== undefined) user.roles = body.roles;
    if (body.knowledgeDomains !== undefined)
      user.knowledgeDomains = body.knowledgeDomains;

    return this.users.save(user);
  }

  /** Removes a user from the company. Returns 404 if not found. */
  @ApiOperation({ summary: 'Remove a user from a company' })
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(
    @Param('companyId') companyId: UUID,
    @Param('userId') userId: UUID,
  ): Promise<void> {
    const result = await this.users.delete({ id: userId, companyId });
    if (!result.affected)
      throw new NotFoundException(`User ${userId} not found`);
  }
}

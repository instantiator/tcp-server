import {
  AuditEvent,
  CompanyUser,
  TcpAgent,
  TcpCompany,
  TcpRole,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentDbService } from './agent-db.service';
import { CompanyDbService } from './company-db.service';
import { DbService } from './db.service';
import { RoleDbService } from './role-db.service';

/**
 * Registers TypeORM repositories for all shared entities and exposes
 * {@link DbService} to other modules. The per-entity services behind that
 * facade are provided here but not exported — callers use {@link DbService}.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TcpCompany,
      TcpRole,
      TcpAgent,
      AuditEvent,
      CompanyUser,
    ]),
  ],
  providers: [DbService, CompanyDbService, RoleDbService, AgentDbService],
  exports: [DbService],
})
export class DbModule {}

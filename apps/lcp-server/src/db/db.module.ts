import {
  AuditEvent,
  CompanyUser,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DbService } from './db.service';

/**
 * Registers TypeORM repositories for all shared entities and exposes
 * {@link DbService} to other modules.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      LcpCompany,
      LcpRole,
      LcpAgent,
      AuditEvent,
      CompanyUser,
    ]),
  ],
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}

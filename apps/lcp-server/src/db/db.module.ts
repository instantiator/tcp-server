import {
  AuditEvent,
  CompanyUser,
  TcpAgent,
  TcpCompany,
  TcpRole,
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
      TcpCompany,
      TcpRole,
      TcpAgent,
      AuditEvent,
      CompanyUser,
    ]),
  ],
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LcpCompany } from '@lcp/shared';
import { DbService } from './db.service';

/**
 * Registers the {@link LcpCompany} TypeORM repository and exposes
 * {@link DbService} to other modules.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LcpCompany])],
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}

import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { CompanyController } from './api.company.controller';
import { ApiService } from './api.service';

/** HTTP API module: wires {@link CompanyController}, {@link ApiService}, and {@link DbModule}. */
@Module({
  imports: [DbModule],
  controllers: [CompanyController],
  providers: [ApiService],
})
export class ApiModule {}

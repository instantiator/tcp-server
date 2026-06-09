import { Module } from '@nestjs/common';
import { ApiModule } from './api/api.module';
import { DbModule } from './db/db.module';

@Module({
  imports: [ApiModule, DbModule],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiModule } from './api/api.module';
import { LcpCompany } from './models';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [LcpCompany],
      synchronize: true,
    }),
    ApiModule,
  ],
})
export class AppModule {}

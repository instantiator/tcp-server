import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TcpCompany } from '../models';
import { DbService } from './db.service';

@Module({
  imports: [TypeOrmModule.forFeature([TcpCompany])],
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}

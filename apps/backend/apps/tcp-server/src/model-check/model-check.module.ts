import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ModelCompatibilityService } from './model-compatibility.service';

/** Provides {@link ModelCompatibilityService} for use by controllers. */
@Module({
  imports: [DbModule],
  providers: [ModelCompatibilityService],
  exports: [ModelCompatibilityService],
})
export class ModelCheckModule {}

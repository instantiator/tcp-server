import { Module } from '@nestjs/common';
import { ModelCompatibilityService } from './model-compatibility.service';

/** Provides {@link ModelCompatibilityService} for use by controllers. */
@Module({
  providers: [ModelCompatibilityService],
  exports: [ModelCompatibilityService],
})
export class ModelCheckModule {}

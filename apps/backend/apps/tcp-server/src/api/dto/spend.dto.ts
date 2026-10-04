import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import type { ResumeResult } from '../spend-resume.service';

/** Body of `POST /api/spend/caps/:provider/dismiss`. */
export class DismissCapDto {
  /** `reset` lifts the cap until its window next ends; `indefinite` until it is restored. */
  @ApiProperty({ enum: ['reset', 'indefinite'] })
  @IsIn(['reset', 'indefinite'])
  until!: 'reset' | 'indefinite';
}

/** {@link ResumeResult}, published as a class so the Swagger plugin can read it. */
export class ResumeResultDto implements ResumeResult {
  /** Agents a resume was requested for. */
  resumed!: number;
}

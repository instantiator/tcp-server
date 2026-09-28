import { ApiProperty } from '@nestjs/swagger';
import type { ShutdownStatus } from '../system-drain.service';
import type { ShutdownState } from '../system-shutdown.service';

/** {@link ShutdownStatus}, published as a class so the Swagger plugin can read it. */
export class ShutdownStatusResponseDto implements ShutdownStatus {
  @ApiProperty({ enum: ['idle', 'draining', 'quiesced'] })
  state!: ShutdownState;
  /** True when the current drain aborts in-flight LLM calls rather than waiting. */
  forced!: boolean;
  /** Agent loops still to come to rest. Zero, with state `quiesced`, means safe to halt. */
  agentsRunning!: number;
}

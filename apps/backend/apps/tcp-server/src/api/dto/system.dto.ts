import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ShutdownStatus } from '../system-drain.service';
import type { ShutdownState } from '../system-shutdown.service';
import type { ServiceHealth, SystemHealth } from '../system-health.service';

/** {@link ShutdownStatus}, published as a class so the Swagger plugin can read it. */
export class ShutdownStatusResponseDto implements ShutdownStatus {
  @ApiProperty({ enum: ['idle', 'draining', 'quiesced'] })
  state!: ShutdownState;
  /** True when the current drain aborts in-flight LLM calls rather than waiting. */
  forced!: boolean;
  /** Agent loops still to come to rest. Zero, with state `quiesced`, means safe to halt. */
  agentsRunning!: number;
}

/** One service's line in {@link SystemHealthResponseDto}. */
export class ServiceHealthDto implements ServiceHealth {
  @ApiProperty({
    enum: [
      'tcp-server',
      'tcp-agent',
      'tcp-mcp-storage',
      'tcp-mcp-memory',
      'tcp-mcp-interactions',
      'tcp-mcp-tasks',
    ],
  })
  name!: string;
  @ApiProperty({ enum: ['up', 'down', 'not_configured'] })
  status!: ServiceHealth['status'];
  /** The service's own health document, when it sent one. */
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  detail?: unknown;
  /** Why the probe itself failed (no answer, timeout), when it did. */
  error?: string;
}

/** {@link SystemHealth}, published as a class so the Swagger plugin can read it. */
export class SystemHealthResponseDto implements SystemHealth {
  @ApiProperty({ enum: ['ok', 'degraded'] })
  status!: SystemHealth['status'];
  @ApiProperty({ type: [ServiceHealthDto] })
  services!: ServiceHealthDto[];
}

/** The part of the shutdown state every signed-in user may see. */
export class PublicShutdownStateDto {
  @ApiProperty({ enum: ['idle', 'draining', 'quiesced'] })
  state!: ShutdownState;
}

/**
 * What the web client needs on every page: whether to offer the System menu,
 * and whether to show the shutdown banner.
 */
export class SystemStatusResponseDto {
  /** True when the caller is a system administrator. */
  admin!: boolean;
  shutdown!: PublicShutdownStateDto;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ServerFootprint, ToolFootprint } from '../tool-footprint.service';

/** One MCP server's share of {@link ToolFootprintDto}. */
export class ServerFootprintDto implements ServerFootprint {
  /** Registry name, e.g. `records`. */
  name!: string;
  /** Tools the mode is offered from this server. */
  tools!: number;
  /** Tokens their schemas cost on every turn. */
  tokens!: number;
  /** Why this server couldn't be counted, when it couldn't be reached. */
  @ApiPropertyOptional()
  error?: string;
}

/** What a role's MCP tool schemas cost per turn, in one mode. */
export class ToolFootprintDto implements ToolFootprint {
  @ApiProperty({
    enum: ['plan', 'implement', 'qa', 'chat', 'consultee', 'finalise'],
  })
  mode!: ToolFootprint['mode'];
  @ApiProperty({ type: [ServerFootprintDto] })
  servers!: ServerFootprintDto[];
  /** Total tokens across the servers that could be counted. */
  total!: number;
}

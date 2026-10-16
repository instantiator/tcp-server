import { ApiProperty } from '@nestjs/swagger';

/** One MCP server from the platform registry, as offered to the web role form. */
export class McpServerResponseDto {
  @ApiProperty({ description: 'The registry name, e.g. `storage`.' })
  name!: string;

  @ApiProperty({ description: 'When a role would reach for this server.' })
  usage!: string;

  @ApiProperty({
    description:
      'Whether this deployment has the server configured (its URL is set).',
  })
  available!: boolean;
}

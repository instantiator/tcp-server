import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

/** Which local or custom model server to list, and with what key. */
export class ListLlmModelsDto {
  @ApiProperty({ description: 'A local or custom catalogue provider id.' })
  @IsString()
  provider!: string;

  @ApiProperty({ description: 'The server address, including `/v1`.' })
  @IsString()
  baseUrl!: string;

  @ApiPropertyOptional({
    description:
      'A key just typed. Without one, a key already saved for this provider and address is used.',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiPropertyOptional({
    description:
      "A role of this company whose saved key may be used, as well as the company's own.",
  })
  @IsOptional()
  @IsUUID()
  roleId?: string;
}

/** The model ids a server lists. */
export class LlmModelsResponseDto {
  @ApiProperty({ type: [String] })
  models!: string[];
}

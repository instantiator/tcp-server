import { IsNumber, IsOptional, IsString } from 'class-validator';

export class LlmConfigDto {
  @IsString()
  provider!: string;

  @IsString()
  model!: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsNumber()
  contextWindow?: number;
}

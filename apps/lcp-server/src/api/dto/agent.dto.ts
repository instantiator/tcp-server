import type { UUID } from 'crypto';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class StartAgentDto {
  @IsUUID()
  companyId!: UUID;

  @IsUUID()
  roleId!: UUID;

  @IsString()
  @IsNotEmpty()
  initialPrompt!: string;
}

export class StartChatDto {
  @IsUUID()
  companyId!: UUID;

  @IsUUID()
  roleId!: UUID;
}

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  message!: string;
}

export class CheckModelsDto {
  @IsOptional()
  models?: unknown[];
}

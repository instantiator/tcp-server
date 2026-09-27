import { ApiProperty } from '@nestjs/swagger';
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

/** `POST /api/agent/:id/message`: the turn was queued; watch the agent's SSE stream. */
export class MessageAcceptedResponseDto {
  @ApiProperty({ enum: [true] })
  accepted!: true;
}

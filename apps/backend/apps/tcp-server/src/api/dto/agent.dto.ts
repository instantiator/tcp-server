import { ApiProperty } from '@nestjs/swagger';
import type { UUID } from 'crypto';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

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

/** `GET /api/agent/search` query: which company, and the text to find. */
export class TranscriptSearchQueryDto {
  @IsUUID()
  companyId!: UUID;

  @IsString()
  @Length(2, 200)
  q!: string;
}

/** `GET /api/agent/search`: the agents whose transcripts contain the text. */
export class TranscriptSearchResponseDto {
  @ApiProperty({ type: [String] })
  agentIds!: string[];
}

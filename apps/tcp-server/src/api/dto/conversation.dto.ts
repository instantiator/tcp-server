import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ConversationReplyDto {
  @IsString()
  @IsNotEmpty()
  content!: string;

  @IsOptional()
  @IsString()
  authorIdentifier?: string;
}

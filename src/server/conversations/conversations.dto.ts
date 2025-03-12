import { IsBoolean, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class MessageDto {
  @IsString()
  @IsNotEmpty()
  content: string;

  @IsString()
  @IsNotEmpty()
  role: string;

  @IsOptional()
  timestamp?: Date;
}

export class CreateConversationDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  sourceCode?: string;

  @IsOptional()
  @IsString()
  codeLanguage?: string;

  @IsOptional()
  @IsBoolean()
  isFromCode?: boolean;

  @IsString()
  @IsNotEmpty()
  initialMode: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MessageDto)
  messages?: MessageDto[];
}

export class UpdateConversationDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  sourceCode?: string;

  @IsOptional()
  @IsString()
  codeLanguage?: string;

  @IsOptional()
  @IsBoolean()
  isFromCode?: boolean;

  @IsOptional()
  @IsString()
  initialMode?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MessageDto)
  messages?: MessageDto[];
}

export class AddMessageDto {
  @IsString()
  @IsNotEmpty()
  content: string;

  @IsString()
  @IsNotEmpty()
  role: string;
}

export class SearchConversationsDto {
  @IsString()
  @IsNotEmpty()
  searchTerm: string;
}
import { IsOptional, IsString } from 'class-validator';

export class AIAssistantSettingsDto {
  @IsOptional()
  @IsString()
  customPrompt?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  leftClickBehavior?: string;
}

export class AIAssistantSettingsResponseDto {
  id: number;
  customPrompt?: string;
  apiKey?: string;
  leftClickBehavior: string;
  createdAt: Date;
  updatedAt: Date;
}

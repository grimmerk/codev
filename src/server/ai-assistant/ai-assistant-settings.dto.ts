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
  
  @IsOptional()
  @IsString()
  preferredIDE?: string;
}

export class AIAssistantSettingsResponseDto {
  id: number;
  customPrompt?: string;
  apiKey?: string;
  leftClickBehavior: string;
  preferredIDE: string;
  createdAt: Date;
  updatedAt: Date;
}

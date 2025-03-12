import { Body, Controller, Get, Post } from '@nestjs/common';
import { AIAssistantSettings } from '@prisma/client';
import { AIAssistantSettingsDto } from './ai-assistant-settings.dto';
import { AIAssistantSettingsService } from './ai-assistant-settings.service';

@Controller('ai-assistant-settings')
export class AIAssistantSettingsController {
  constructor(
    private readonly aiAssistantSettingsService: AIAssistantSettingsService,
  ) {}

  @Get()
  async getSettings(): Promise<AIAssistantSettings> {
    return this.aiAssistantSettingsService.getSettings();
  }

  @Post()
  async updateSettings(
    @Body() data: AIAssistantSettingsDto,
  ): Promise<AIAssistantSettings> {
    return this.aiAssistantSettingsService.updateSettings(data);
  }
}

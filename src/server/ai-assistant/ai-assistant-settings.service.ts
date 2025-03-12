import { Injectable } from '@nestjs/common';
import { AIAssistantSettings } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AIAssistantSettingsDto } from './ai-assistant-settings.dto';

@Injectable()
export class AIAssistantSettingsService {
  constructor(private prisma: PrismaService) {}

  async getSettings(): Promise<AIAssistantSettings> {
    // Get first record or create default if none exists
    let settings = await this.prisma.aIAssistantSettings.findFirst();

    if (!settings) {
      settings = await this.prisma.aIAssistantSettings.create({
        data: {
          leftClickBehavior: 'switcher_window',
        },
      });
    }

    return settings;
  }

  async updateSettings(
    data: AIAssistantSettingsDto,
  ): Promise<AIAssistantSettings> {
    let settings = await this.getSettings();

    return this.prisma.aIAssistantSettings.update({
      where: { id: settings.id },
      data: {
        customPrompt:
          data.customPrompt !== undefined
            ? data.customPrompt
            : settings.customPrompt,
        apiKey: data.apiKey !== undefined ? data.apiKey : settings.apiKey,
        leftClickBehavior:
          data.leftClickBehavior !== undefined
            ? data.leftClickBehavior
            : settings.leftClickBehavior,
      },
    });
  }
}

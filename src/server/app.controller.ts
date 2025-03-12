import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import * as dotenv from 'dotenv';
import * as path from 'path';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {
    // Load environment variables
    dotenv.config({ path: path.resolve(process.cwd(), '.env') });
  }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}

@Controller('app')
export class AppEnvController {
  constructor() {
    // Load environment variables
    dotenv.config({ path: path.resolve(process.cwd(), '.env') });
  }

  @Get('env-api-key')
  getEnvApiKey(): { apiKey: string } {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    // Mask the API key for security - only return if it exists
    return {
      apiKey: apiKey ? '••••••••' : '',
    };
  }
}

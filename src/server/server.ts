import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

import { PrismaService } from './prisma.service';

export async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const prismaService = app.get(PrismaService);
  await prismaService.enableShutdownHooks(app);

  app.enableCors();
  await app.listen(55688);
}

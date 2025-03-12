import { Controller, Get, Post, Body } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';

import { UserService } from './user.service';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  async update(
    @Body() userInput: Prisma.UserCreateInput,
  ): Promise<{ status: string }> {
    const user = await this.userService.updateUser(userInput);
    if (user) {
      return { status: 'ok' };
    }
    return { status: 'failed' };
  }

  @Get()
  async read(): Promise<User> {
    const data = await this.userService.getUser();

    return data ?? { id: 1, workingFolder: '' };
  }
}

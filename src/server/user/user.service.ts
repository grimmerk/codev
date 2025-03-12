import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { VSWindow, Prisma, User } from '@prisma/client';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  async getUser(): Promise<User> {
    const user = await this.prisma.user.findFirst();
    return user;
  }

  // https://www.prisma.io/docs/reference/api-reference/prisma-client-reference#upsert
  async updateUser(userInput: Prisma.UserCreateInput): Promise<User> {
    let user = await this.getUser();
    if (user) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: userInput,
      });
    } else {
      user = await this.prisma.user.create({
        data: userInput,
      });
    }

    return user;
  }
}

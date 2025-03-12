import { Injectable } from '@nestjs/common';
import { Prisma, VSWindow } from '@prisma/client';
import { PrismaService } from '../prisma.service';

@Injectable()
export class XWinService {
  constructor(private prisma: PrismaService) {}

  // https://www.prisma.io/docs/reference/api-reference/prisma-client-reference#upsert
  async upsertXWin(args: Prisma.VSWindowUpsertArgs): Promise<VSWindow> {
    const xwin = await this.prisma.vSWindow.upsert(args);
    return xwin;
  }

  async xwins(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.VSWindowWhereUniqueInput;
    where?: Prisma.VSWindowWhereInput;
    orderBy?: Prisma.VSWindowOrderByWithRelationInput;
    include?: Prisma.VSWindowInclude;
  }): Promise<VSWindow[]> {
    const { skip, take, cursor, where, orderBy, include } = params;
    const xwins = await this.prisma.vSWindow.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
      include,
    });
    return xwins;
  }

  async deleteXWin(where: Prisma.VSWindowWhereUniqueInput): Promise<VSWindow> {
    return this.prisma.vSWindow.delete({
      where,
    });
  }

  /** below are not really used */
  async xwin(
    vswinWhereUniqueInput: Prisma.VSWindowWhereUniqueInput,
  ): Promise<VSWindow | null> {
    return this.prisma.vSWindow.findUnique({
      where: vswinWhereUniqueInput,
    });
  }

  async createXWin(data: Prisma.VSWindowCreateInput): Promise<VSWindow> {
    return this.prisma.vSWindow.create({
      data,
    });
  }

  async updateXWin(params: {
    where: Prisma.VSWindowWhereUniqueInput;
    data: Prisma.VSWindowUpdateInput;
  }): Promise<VSWindow> {
    const { where, data } = params;
    return this.prisma.vSWindow.update({
      data,
      where,
    });
  }
}

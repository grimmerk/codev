import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { VSWindow as VSWindowModel } from '@prisma/client';
import { CreateXwinDto, DeleteXwinDto } from './xwin.dto';
import { XWinService } from './xwins.service';

@Controller('xwins')
export class XWinsController {
  constructor(private readonly xwinService: XWinService) {}

  @Delete()
  @HttpCode(204)
  async remove(@Body() deleteCatDto: DeleteXwinDto) {
    const { path } = deleteCatDto;

    await this.xwinService.deleteXWin({
      path_inSpace: { path, inSpace: false },
    });
  }

  /**
   *
   * @param createCatDto
   *  case1: workspace
   *   paths:[] may be more than 1 element
   *   workspace_path: '/Users/grimmer/space/auth.code-workspace' (not empty)
   *  case2: normal project folder
   *   workspace_path: '' (empty string)
   * @param res
   */
  @Post()
  async create(@Body() createCatDto: CreateXwinDto): Promise<VSWindowModel> {
    const { paths, workspace_path } = createCatDto;
    if (!paths?.length) {
      // console.log('no paths, return directly');
      return;
    }

    let path = '';
    let isSpace = false;
    let folders: { path: string; inSpace: boolean }[] = [];
    if (workspace_path) {
      isSpace = true;
      path = workspace_path;
      folders = paths.map((folder: string) => {
        return {
          path: folder,
          inSpace: true,
        };
      });
    } else {
      path = paths[0];
    }

    // https://www.prisma.io/docs/reference/database-reference/database-features
    // https://www.prisma.io/docs/concepts/components/prisma-schema/data-model#defining-a-unique-field
    // @@unique
    const xwin = await this.xwinService.upsertXWin({
      where: { path_inSpace: { path, inSpace: false } },
      update: {
        updatedAt: new Date(),
        embeddedWindows: {
          // set: folders, // not work since it is not to update relations
          // ref: https://github.com/prisma/prisma/issues/5456
          deleteMany: {},
          create: folders,
        },
      },
      create: {
        path,
        isSpace,
        embeddedWindows: {
          // https://stackoverflow.com/questions/68285222/create-or-update-one-to-many-relationship-in-prisma
          // https://stackoverflow.com/questions/65587200/updating-a-many-to-many-relationship-in-prisma
          // connectOrCreate will create if not present and add the categories to the posts as well.
          // connectOrCreate??

          // https://stackoverflow.com/questions/70515366/how-to-update-a-many-to-many-relationship-in-prisma
          // createMany: {
          //   data: [
          //     { boxerId: boxer3.id },
          //   ]
          // },
          // deleteMany: {
          //   OR: [
          //     { boxerId: { equals: boxer1.id } },
          //   ]
          // }
          create: folders,
        },
      },
    });

    return xwin;
  }

  // usually name: null, spaceParentId: null
  @Get()
  async findAll(): Promise<VSWindowModel[]> {
    const xwins = await this.xwinService.xwins({
      where: { inSpace: false },
      orderBy: {
        updatedAt: 'desc',
      },

      include: { embeddedWindows: true },
      // https://www.prisma.io/docs/concepts/components/prisma-client/pagination
      take: 100,
      // Skip the cursor
      // skip: 2,
      // cursor: {
      //     id: myCursor,
      //   },
    });

    return xwins;
  }
}

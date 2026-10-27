import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import {
  SKIP_ALL_THROTTLERS,
  THROTTLE_PROJECT_FOLDERS,
} from '../../auth/auth-throttle';
import { CurrentUser } from '../../auth/current-user.decorator';
import { SessionGuard } from '../../auth/session.guard';
import type { ProjectView } from '../projects.service';
import { FolderDto, RegisterFolderDto } from './folders.dto';
import {
  FoldersService,
  type InitView,
  type InspectionView,
} from './folders.service';

/**
 * Adding a project from a folder on one of the user's machines (spec #378).
 * The three routes share one per-user budget (Decision 8).
 */
@Controller('projects/folders')
// One decorator: two on a class set the same keys, and the outer one wins.
@SkipThrottle({ ...SKIP_ALL_THROTTLERS, [THROTTLE_PROJECT_FOLDERS]: false })
@UseGuards(SessionGuard, ThrottlerGuard)
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Post('inspect')
  @HttpCode(HttpStatus.OK)
  inspect(
    @CurrentUser() user: User,
    @Body() body: FolderDto,
  ): Promise<InspectionView> {
    return this.folders.inspect(user.id, body.runnerId, body.path);
  }

  @Post('init')
  @HttpCode(HttpStatus.OK)
  init(@CurrentUser() user: User, @Body() body: FolderDto): Promise<InitView> {
    return this.folders.init(user.id, body.runnerId, body.path);
  }

  @Post('register')
  async register(
    @CurrentUser() user: User,
    @Body() body: RegisterFolderDto,
  ): Promise<{ project: ProjectView }> {
    return { project: await this.folders.register(user.id, body) };
  }
}

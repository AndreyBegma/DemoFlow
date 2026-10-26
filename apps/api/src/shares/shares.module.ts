import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RunnerModule } from '../runner/runner.module';
import { VideosModule } from '../videos/videos.module';
import { RunnerSharesController } from './runner-shares.controller';
import { ShareStorageModule } from './share-storage';
import { ShareSweeper } from './share-sweeper';
import { ShareUploadService } from './share-upload.service';
import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';

/**
 * Share links (spec #347, ADR-0019): a copy of one render on the server's
 * disk, pulled from the machine through the video relay. The public page
 * and file are #348.
 */
@Module({
  imports: [AuthModule, RunnerModule, VideosModule, ShareStorageModule],
  controllers: [SharesController, RunnerSharesController],
  providers: [SharesService, ShareUploadService, ShareSweeper],
})
export class SharesModule {}

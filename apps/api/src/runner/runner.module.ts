import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeviceCodeService } from './device-code.service';
import { RunnerController } from './runner.controller';
import { RunnerTokenGuard } from './runner-token.guard';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/** Runner pairing, slice 1 (spec #135, ADR-0007). The socket is slice 2. */
@Module({
  imports: [AuthModule],
  controllers: [RunnerController, RunnersController],
  providers: [DeviceCodeService, RunnersService, RunnerTokenGuard],
  exports: [RunnerTokenGuard],
})
export class RunnerModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeviceCodeService } from './device-code.service';
import { RunnerController } from './runner.controller';
import { RunnerGateway } from './runner.gateway';
import { RunnerAuthService } from './runner-auth.service';
import { RunnerConnections } from './runner-connections.service';
import { RunnerTokenGuard } from './runner-token.guard';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/**
 * Runner pairing (spec #135) and the runner socket (spec #151, ADR-0007).
 * The socket's adapter is set in `configureApp`.
 */
@Module({
  imports: [AuthModule],
  controllers: [RunnerController, RunnersController],
  providers: [
    DeviceCodeService,
    RunnersService,
    RunnerAuthService,
    RunnerTokenGuard,
    RunnerConnections,
    RunnerGateway,
  ],
  exports: [RunnerAuthService, RunnerTokenGuard],
})
export class RunnerModule {}

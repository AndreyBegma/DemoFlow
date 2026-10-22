import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountController } from '../users/account.controller';
import { AccountService } from '../users/account.service';
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
 * The socket's adapter is set in `configureApp`. Account deletion (spec #177)
 * lives here too: it closes the account's sockets, and a module of its own
 * would close an import cycle with `AuthModule`.
 */
@Module({
  imports: [AuthModule],
  controllers: [RunnerController, RunnersController, AccountController],
  providers: [
    AccountService,
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

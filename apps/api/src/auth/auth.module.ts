import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { authThrottlerOptions } from './auth-throttle';
import { PasswordHasher } from './password-hasher';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import { VerifiedGuard } from './verified.guard';

/**
 * Accounts. A later module imports this one and protects its routes with
 * `@UseGuards(SessionGuard, VerifiedGuard)`.
 */
@Module({
  imports: [ThrottlerModule.forRoot(authThrottlerOptions)],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    PasswordHasher,
    SessionGuard,
    VerifiedGuard,
  ],
  exports: [SessionService, SessionGuard, VerifiedGuard],
})
export class AuthModule {}

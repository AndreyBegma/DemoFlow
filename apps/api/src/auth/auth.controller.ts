import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import type { Response } from 'express';
import { Clock } from '../common/clock';
import {
  EmailTokenDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  SignInDto,
  SignUpDto,
} from './auth.dto';
import { AuthService } from './auth.service';
import {
  type AuthContext,
  type PublicUser,
  toPublicUser,
} from './auth-context';
import {
  SKIP_ALL_THROTTLERS,
  THROTTLE_IP,
  THROTTLE_MAIL,
  THROTTLE_SIGN_IN,
} from './auth-throttle';
import { CurrentSession, CurrentUser } from './current-user.decorator';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import { clearSessionCookie, setSessionCookie } from './session-cookie';

/**
 * Email/password accounts (spec #120). `me` and sign-out carry no IP limit:
 * the web's server components call `me` on every page, all from one address.
 */
@Controller('auth')
@SkipThrottle(SKIP_ALL_THROTTLERS)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly clock: Clock,
  ) {}

  @Post('sign-up')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_IP]: false, [THROTTLE_MAIL]: false })
  async signUp(@Body() body: SignUpDto): Promise<Record<string, never>> {
    await this.auth.signUp(body.email, body.password);
    return {};
  }

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_IP]: false, [THROTTLE_SIGN_IN]: false })
  async signIn(
    @Body() body: SignInDto,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: PublicUser }> {
    const signedIn = await this.auth.signIn(
      body.email,
      body.password,
      userAgent,
    );
    setSessionCookie(res, signedIn.token, signedIn.expiresAt, this.clock.now());
    return { user: toPublicUser(signedIn.user) };
  }

  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  async signOut(
    @CurrentSession() session: AuthContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.revoke(session.sessionId);
    clearSessionCookie(res);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: User): { user: PublicUser } {
    return { user: toPublicUser(user) };
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_IP]: false })
  async verifyEmail(@Body() body: EmailTokenDto): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  // SessionGuard first: the mail limit is keyed by the signed-in user's email.
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(SessionGuard, ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_IP]: false, [THROTTLE_MAIL]: false })
  async resendVerification(
    @CurrentUser() user: User,
  ): Promise<Record<string, never>> {
    await this.auth.resendVerification(user);
    return {};
  }

  @Post('password-reset')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_IP]: false, [THROTTLE_MAIL]: false })
  async requestPasswordReset(
    @Body() body: PasswordResetRequestDto,
  ): Promise<Record<string, never>> {
    await this.auth.requestPasswordReset(body.email);
    return {};
  }

  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_IP]: false })
  async confirmPasswordReset(
    @Body() body: PasswordResetConfirmDto,
  ): Promise<void> {
    await this.auth.confirmPasswordReset(body.token, body.password);
  }
}

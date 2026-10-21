import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { Clock } from '../../common/clock';
import { SKIP_ALL_THROTTLERS, THROTTLE_IP } from '../auth-throttle';
import { CurrentUser } from '../current-user.decorator';
import { SessionGuard } from '../session.guard';
import { SessionService } from '../session.service';
import { SESSION_COOKIE, setSessionCookie } from '../session-cookie';
import { GithubCallbackDto, GithubStartDto } from './github.dto';
import { GithubAuthService } from './github-auth.service';
import { clearOauthCookie, OAUTH_COOKIE, setOauthCookie } from './oauth-cookie';

/**
 * GitHub sign-in and linking (spec #126). `start` and `callback` are browser
 * navigations, not fetches: they answer with redirects.
 */
@Controller('auth')
@SkipThrottle(SKIP_ALL_THROTTLERS)
export class GithubController {
  constructor(
    private readonly github: GithubAuthService,
    private readonly sessions: SessionService,
    private readonly clock: Clock,
  ) {}

  /** Lets the web hide the button while the OAuth App is not configured. */
  @Get('providers')
  providers(): { github: boolean } {
    return { github: this.github.enabled };
  }

  @Get('github/start')
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_IP]: false })
  async start(
    @Query() query: GithubStartDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    let userId: string | null = null;
    if (query.intent === 'link') {
      userId = await this.sessionUserId(req);
      if (userId === null) {
        throw new UnauthorizedException();
      }
    }
    const { url, cookie } = this.github.start(query.intent, userId);
    setOauthCookie(res, cookie);
    res.redirect(HttpStatus.FOUND, url);
  }

  @Get('github/callback')
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE_IP]: false })
  async callback(
    @Query() query: GithubCallbackDto,
    @Req() req: Request,
    @Headers('user-agent') userAgent: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.github.callback(
      query,
      req.cookies?.[OAUTH_COOKIE],
      await this.sessionUserId(req),
      userAgent,
    );
    clearOauthCookie(res);
    if (result.session) {
      setSessionCookie(
        res,
        result.session.token,
        result.session.expiresAt,
        this.clock.now(),
      );
    }
    res.redirect(HttpStatus.FOUND, result.redirectTo);
  }

  @Delete('github')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  async unlink(@CurrentUser() user: User): Promise<void> {
    await this.github.unlink(user);
  }

  /** The signed-in user, when there is one; these routes do not require it. */
  private async sessionUserId(req: Request): Promise<string | null> {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }
    const resolved = await this.sessions.resolve(token);
    return resolved?.user.id ?? null;
  }
}

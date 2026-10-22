import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { RunnerAuthService } from './runner-auth.service';
import type { RunnerContext, RunnerRequest } from './runner-token';

/** Requires `Authorization: Bearer dfr_…` of an unrevoked machine. */
@Injectable()
export class RunnerTokenGuard implements CanActivate {
  constructor(private readonly auth: RunnerAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RunnerRequest>();
    const runnerAuth = await this.auth.authenticate(req.headers.authorization);
    if (!runnerAuth) {
      throw new UnauthorizedException();
    }
    req.runnerAuth = runnerAuth;
    return true;
  }
}

/** The calling machine and its account. Only behind `RunnerTokenGuard`. */
export const CurrentRunner = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RunnerContext => {
    const { runnerAuth } = context.switchToHttp().getRequest<RunnerRequest>();
    if (!runnerAuth) {
      throw new InternalServerErrorException('Used without RunnerTokenGuard');
    }
    return runnerAuth;
  },
);

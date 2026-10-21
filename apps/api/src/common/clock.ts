import { Injectable } from '@nestjs/common';

/** The time source of everything that expires. Tests replace it. */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Length, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Names are 1–64 characters after trimming, not unique (spec #135, Decision 7). */
export const RUNNER_NAME_MAX = 64;

export class DeviceCodeRequestDto {
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  hostname!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 128)
  os!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 64)
  cliVersion!: string;
}

export class DeviceTokenRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  deviceCode!: string;
}

export class RunnerNameDto {
  @Transform(trim)
  @IsString()
  @Length(1, RUNNER_NAME_MAX)
  name!: string;
}

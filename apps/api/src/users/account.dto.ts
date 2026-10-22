import { IsString, MaxLength } from 'class-validator';

/** `DELETE /me` (spec #177, Decision 1): the account's email, typed. */
export class DeleteAccountDto {
  @IsString()
  @MaxLength(320)
  email!: string;
}

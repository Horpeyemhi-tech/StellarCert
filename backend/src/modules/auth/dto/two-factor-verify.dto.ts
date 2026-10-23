import { IsString, Length, Matches } from 'class-validator';

export class TwoFactorVerifyDto {
  // Pre-auth token is a opaque signed blob issued after password verification.
  // Bound its length to avoid abuse via oversized payloads.
  @IsString()
  @Length(16, 4096)
  preAuthToken: string;

  // Accept eligible TOTP codes (6 digits) or backup codes (8 hex chars).
  // Reject anything else at the boundary so invalid inputs never reach the
  // attempt-counting logic in TwoFactorService.validateLogin.
  @IsString()
  @Length(6, 8)
  @Matches(/^(?:\d{6}|[0-9a-fA-F]{8})$/, {
    message: 'token must be a 6-digit TOTP code or an 8-character hex backup code',
  })
  token: string;
}

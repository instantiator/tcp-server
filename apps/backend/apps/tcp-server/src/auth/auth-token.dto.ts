import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import type {
  DeviceAuthorizationResponse,
  OidcTokenResponse,
} from './auth-token.service';

// Request and response shapes for auth-token.controller.ts, published as classes so the
// Swagger plugin can read them (it cannot read an interface — see
// api/dto/knowledge-response.dto.ts).

/** {@link DeviceAuthorizationResponse}: what a human needs to finish device login. */
export class DeviceAuthorizationResponseDto implements DeviceAuthorizationResponse {
  device_code!: string;
  user_code!: string;
  verification_uri!: string;
  verification_uri_complete?: string;
  /** Seconds until `device_code` expires. */
  expires_in!: number;
  /** Seconds to wait between polls. */
  interval!: number;
}

/** {@link OidcTokenResponse}: a freshly issued access token. */
export class OidcTokenResponseDto implements OidcTokenResponse {
  access_token!: string;
  token_type!: string;
  /** Seconds until `access_token` expires. */
  expires_in!: number;
  refresh_token?: string;
}

/**
 * `DeviceTokenPollResult`, flattened: the token fields are present only when
 * `status` is `complete`. (A union can't be `implement`ed, so this one is
 * kept in step by hand.)
 */
export class DeviceTokenPollResponseDto {
  @ApiProperty({ enum: ['pending', 'slow_down', 'complete'] })
  status!: 'pending' | 'slow_down' | 'complete';
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

/** Body for `POST /api/auth/device/token`. */
export class DeviceTokenRequestDto {
  /** The `device_code` from `POST /api/auth/device`. */
  @IsString()
  @IsNotEmpty()
  device_code!: string;
}

/** Body for `POST /api/auth/refresh`. */
export class RefreshRequestDto {
  @IsString()
  @IsNotEmpty()
  refresh_token!: string;
}

import { Schema } from '@spinajs/validation';

export const PasswordResetRequestDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Password reset request DTO',
  type: 'object',
  properties: {
    Email: { type: 'string', format: 'email', description: 'Email address of the account to reset' },
  },
  required: ['Email'],
};

/** Payload starting a password reset — identifies the account by email. */
@Schema(PasswordResetRequestDtoSchema)
export class PasswordResetRequestDto {
  public Email: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

export const PasswordResetConfirmDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Password reset confirmation DTO',
  type: 'object',
  properties: {
    Email: { type: 'string', format: 'email', description: 'Email address the reset token was issued for' },
    Token: { type: 'string', maxLength: 64, minLength: 1, description: 'Reset token delivered to the user' },
    Password: { type: 'string', maxLength: 32, minLength: 6, description: 'New password (6–32 characters)' },
    ConfirmPassword: { type: 'string', maxLength: 32, minLength: 6, description: 'Must match Password' },
  },
  required: ['Email', 'Token', 'Password', 'ConfirmPassword'],
};

/** Payload completing a password reset with the issued token. */
@Schema(PasswordResetConfirmDtoSchema)
export class PasswordResetConfirmDto {
  public Email: string;

  public Token: string;

  public Password: string;

  public ConfirmPassword: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

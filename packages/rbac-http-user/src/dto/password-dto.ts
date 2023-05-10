import { Schema } from '@spinajs/validation';

export const PasswordDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User password DTO',
  type: 'object',
  properties: {
    OldPassword: { type: 'string', maxLength: 32, minLength: 6 },
    Password: { type: 'string', maxLength: 32, minLength: 6 },
    ConfirmPassword: { type: 'string', maxLength: 32, minLength: 6 },
  },
  required: ['OldPassword', 'Password', 'ConfirmPassword'],
};

@Schema(PasswordDtoSchema)
export class PasswordDto {
  public OldPassword: string;

  public Password: string;

  public ConfirmPassword: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

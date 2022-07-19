import { Schema } from '@spinajs/validation';

export const LoginDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User login DTO',
  type: 'object',
  properties: {
    Login: { type: 'string', format: 'email' },
    Password: { type: 'string', maxLength: 32 },
  },
  required: ['Email', 'Password'],
};

@Schema(LoginDtoSchema)
export class LoginDto {
  public Email: string;

  public Password: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

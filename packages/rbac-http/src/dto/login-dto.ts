import { Schema } from '@spinajs/validation';

export const LoginDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User login DTO',
  type: 'object',
  properties: {
    Login: { type: 'string', maxLength: 32 },
    Password: { type: 'string', maxLength: 32 },
  },
  required: ['Login', 'Password'],
};

@Schema(LoginDtoSchema)
export class LoginDto {
  public Login: string;

  public Password: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

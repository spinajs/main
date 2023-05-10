import { Schema } from '@spinajs/validation';

export const LoginDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'login DTO',
  type: 'object',
  properties: {
    Login: { type: 'string', format: 'email' },
  },
  required: ['Email'],
};

@Schema(LoginDtoSchema)
export class UserLoginDto {
  public Email: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

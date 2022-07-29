import { Schema } from '@spinajs/validation';

export const UserLoginDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User login DTO',
  type: 'object',
  properties: {
    Login: { type: 'string', format: 'email' },
    Password: { type: 'string', maxLength: 32 },
  },
  required: ['Email', 'Password'],
};

@Schema(UserLoginDtoSchema)
export class UserLoginDto {
  public Email: string;

  public Password: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

import { Schema } from '@spinajs/validation';

export const UserLoginDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User login DTO',
  type: 'object',
  properties: {
    Email: { type: 'string', format: 'email', description: 'User email address' },
    Password: { type: 'string', maxLength: 32, description: 'User password' },
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

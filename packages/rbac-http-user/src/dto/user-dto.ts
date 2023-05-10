import { Schema } from '@spinajs/validation';
export const UserDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User DTO',
  type: 'object',
  properties: {
    Email: { type: 'string', format: 'email', maxLength: 64 },
    Login: { type: 'string', maxLength: 64 },
  },
};

@Schema(UserDtoSchema)
export class UserDto {
  public Email: string;

  public Login: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

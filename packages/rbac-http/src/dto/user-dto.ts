import { Schema } from '@spinajs/validation';
export const UserDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User DTO',
  type: 'object',
  properties: {
    Id: { type: 'number' },
    Email: { type: 'string', format: 'email', maxLength: 64 },
    Login: { type: 'string', maxLength: 64 },
    ConfirmPassword: { type: 'string', maxLength: 32, minLength: 6 },
    Password: { type: 'string', maxLength: 32, minLength: 6 },
    NiceName: { type: 'string', maxLength: 64 },
  },
  required: ['Email', 'NiceName'],
};

@Schema(UserDtoSchema)
export class UserDto {
  public Idsss?: number;

  public Email: string;

  public Login: string;

  public Password: string;

  public ConfirmPassword: string;

  public NiceName: string;

  public Role: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

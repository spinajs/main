import { Schema } from '@spinajs/validation';

export const RestorePasswordDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User password DTO',
  type: 'object',
  properties: {
    Password: { type: 'string', maxLength: 32, minLength: 6 },
    ConfirmPassword: { type: 'string', maxLength: 32, minLength: 6 },
  },
  required: ['Password', 'ConfirmPassword'],
};

@Schema(RestorePasswordDtoSchema)
export class RestorePasswordDto {
  public Password: string;

  public ConfirmPassword: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

import { Schema } from '@spinajs/validation';

export const CreateTokenDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Create access token DTO',
  type: 'object',
  properties: {
    Name: { type: 'string', minLength: 1, maxLength: 128, description: 'Human readable token label' },
    Roles: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Roles allowed on the token, must be subset of own roles' },
    ExpiresAt: { type: ['string', 'null'], format: 'date-time', description: 'ISO expiration instant; null or omitted = never expires' },
  },
  required: ['Name', 'Roles'],
};

@Schema(CreateTokenDtoSchema)
export class CreateTokenDto {
  public Name: string;
  public Roles: string[];
  public ExpiresAt?: string | null;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

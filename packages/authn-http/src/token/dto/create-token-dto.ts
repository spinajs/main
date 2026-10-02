import { Schema } from '@spinajs/validation';

export const CreateTokenDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Create access token DTO',
  type: 'object',
  properties: {
    Name: { type: 'string', minLength: 1, maxLength: 128, description: 'Human readable token label' },
    Roles: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Roles allowed on the token, must be subset of what the role policy allows' },
    // `minLength: 1` is load bearing, not cosmetic: an empty string is falsy all
    // the way down the actions layer, so `Profile: ''` would mint an UNPINNED
    // token instead of a refused one - a silent widening of what the token may
    // reach. Rejecting it here is what keeps "asked for a profile" and "pinned
    // to a profile" the same statement.
    Profile: { type: 'string', minLength: 1, maxLength: 128, description: 'Profile (root role) to pin the token to; omitted = legacy union-scoped token' },
    ExpiresAt: { type: ['string', 'null'], format: 'date-time', description: 'ISO expiration instant; null or omitted = never expires' },
  },
  required: ['Name', 'Roles'],
};

@Schema(CreateTokenDtoSchema)
export class CreateTokenDto {
  public Name: string;
  public Roles: string[];
  public Profile?: string;
  public ExpiresAt?: string | null;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

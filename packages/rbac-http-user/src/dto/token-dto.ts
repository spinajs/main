import { Schema } from '@spinajs/validation';
export const TokenDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Token DTO',
  type: 'object',
  properties: {
    Token: { type: 'string', maxLength: 64 },
  },
};

@Schema(TokenDtoSchema)
export class TokenDto {
  public Token: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

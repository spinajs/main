import { Schema } from '@spinajs/validation';

export const ConfirmPasswordDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Confirm password DTO',
  type: 'object',
  properties: {
    Password: { type: 'string', maxLength: 32, description: 'Current password, re-entered to confirm a sensitive change' },
  },
  required: ['Password'],
};

/**
 * Re-authentication payload for sensitive self-service operations — enabling or
 * disabling 2FA. A hijacked session alone must not be enough to weaken a
 * user's second factor.
 */
@Schema(ConfirmPasswordDtoSchema)
export class ConfirmPasswordDto {
  public Password: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

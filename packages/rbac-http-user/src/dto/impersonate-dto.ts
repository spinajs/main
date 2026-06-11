import { Schema } from '@spinajs/validation';

export const ImpersonateDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Impersonate DTO',
  type: 'object',
  properties: {
    TargetUuid: { type: 'string', format: 'uuid', description: 'UUID of the user to impersonate' },
    Password: { type: 'string', maxLength: 32, description: 'Impersonator password (required when rbac.impersonation.requirePassword is true)' },
  },
  required: ['TargetUuid'],
};

@Schema(ImpersonateDtoSchema)
export class ImpersonateDto {
  public TargetUuid: string;

  public Password?: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

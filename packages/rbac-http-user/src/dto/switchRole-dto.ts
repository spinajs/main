import { Schema } from '@spinajs/validation';

export const SwitchRoleDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Switch active role DTO',
  type: 'object',
  properties: {
    Role: { type: 'string', minLength: 1, description: 'Role to activate. Must be one of the user\'s assigned roles.' },
    Password: { type: 'string', maxLength: 32, description: 'User password. Required when activating roles listed in rbac.roleSwitch.requirePassword.' },
  },
  required: ['Role'],
};

@Schema(SwitchRoleDtoSchema)
export class SwitchRoleDto {
  public Role: string;

  public Password?: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

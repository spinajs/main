import { Schema } from '@spinajs/validation';

/**
 * Body payload for updating a configuration entry value.
 *
 * Only the operationally meaningful fields are editable. Structural fields
 * ( `Slug`, `Group`, `Type` ) are owned by code that exposes the option and
 * cannot be changed through this api.
 */
@Schema({
  type: 'object',
  $id: 'configuration.http.updateConfigDTO',
  properties: {
    // value type varies with the entry `Type`, real validation happens against
    // Type/Meta in the controller, so the schema only requires its presence
    Value: {},
    Default: {},
    Watch: { type: 'boolean' },
  },
  required: ['Value'],
})
export class UpdateConfigDto {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public Value: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public Default?: any;

  public Watch?: boolean;

  constructor(data: Partial<UpdateConfigDto>) {
    Object.assign(this, data);
  }
}

import { DI } from '@spinajs/di';

/**
 * Response schema the metadata controller annotates with `@returns {IUserMetadataEntry}`.
 *
 * `Value` is a string regardless of `Type`: the column stores text and `Type`
 * says how to read it. A client that wants the decoded value decodes it itself.
 */
export const UserMetadataEntrySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User metadata entry',
  type: 'object',
  properties: {
    Id: { type: 'integer' },
    Key: { type: 'string' },
    Type: {
      type: 'string',
      enum: ['number', 'float', 'string', 'json', 'boolean', 'datetime'],
    },
    Value: { type: 'string', nullable: true },
  },
};

// The name is what the swagger builder looks up; the same call `@Schema` makes, without a class to carry the name.
DI.register(UserMetadataEntrySchema).asMapValue('__schemas__', 'IUserMetadataEntry');

import { idField, nameField, typeField } from '@spinajs/authz';
import { AuthzCommandSchemaSource } from '@spinajs/authz-http-admin';
import { Injectable } from '@spinajs/di';

// Closed, with the caps of the shared authz field schemas: POST /authz/commands validates each command against them.
const objectRef = { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: typeField, id: idField } };
const relation = nameField;
const subjectSet = { type: 'object', additionalProperties: false, required: ['object', 'relation'], properties: { object: objectRef, relation } };

const tuple = {
  type: 'object',
  additionalProperties: false,
  description: 'object#relation@subject',
  required: ['object', 'relation', 'subject'],
  properties: {
    object: objectRef,
    relation,
    subject: { description: 'A principal or an object { type, id }, or a subject set { object, relation }', oneOf: [objectRef, subjectSet] },
  },
};

const command = (kind: string, description: string) => ({ type: 'object', additionalProperties: false, description, required: ['kind', 'tuple'], properties: { kind: { type: 'string', enum: [kind] }, tuple } });

/** The JSON schemas of tuple.write and tuple.delete, for POST /authz/commands of the HTTP admin. */
@Injectable(AuthzCommandSchemaSource)
export class RebacCommandSchemas extends AuthzCommandSchemaSource {
  schemas(): Readonly<Record<string, object>> {
    return {
      'tuple.write': command('tuple.write', 'Adds a ReBAC tuple; a stored one is a no-op'),
      'tuple.delete': command('tuple.delete', 'Removes a ReBAC tuple; a missing one is a no-op'),
    };
  }
}

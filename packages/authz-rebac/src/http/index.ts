import { idField, nameField, typeField } from '@spinajs/authz';
import { AuthzCommandSchemaSource } from '@spinajs/authz-http-admin';
import { Injectable } from '@spinajs/di';

// Closed, with the caps of the shared authz field schemas: POST /authz/commands validates each command against them.
const objectRef = { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: typeField, id: idField } };
const relation = nameField;
const subjectSet = { type: 'object', additionalProperties: false, required: ['object', 'relation'], properties: { object: objectRef, relation } };

const caveat = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  description: 'A conditional tuple: the caveat name and values for its parameters, keyed by parameter path (env.ip)',
  properties: {
    name: nameField,
    context: {
      type: 'object',
      maxProperties: 64,
      additionalProperties: { oneOf: [{ type: 'string', maxLength: 1024 }, { type: 'number' }, { type: 'boolean' }, { type: 'array', maxItems: 256, items: { type: ['string', 'number'] } }] },
    },
  },
};

const tuple = {
  type: 'object',
  additionalProperties: false,
  description: 'object#relation@subject',
  required: ['object', 'relation', 'subject'],
  properties: {
    object: objectRef,
    relation,
    subject: { description: 'A principal or an object { type, id }, or a subject set { object, relation }', oneOf: [objectRef, subjectSet] },
    caveat,
  },
};

const command = (kind: string, description: string) => ({ type: 'object', additionalProperties: false, description, required: ['kind', 'tuple'], properties: { kind: { type: 'string', enum: [kind] }, tuple } });

/** The JSON schemas of tuple.write and tuple.delete, for POST /authz/commands of the HTTP admin. */
@Injectable(AuthzCommandSchemaSource)
export class RebacCommandSchemas extends AuthzCommandSchemaSource {
  schemas(): Readonly<Record<string, object>> {
    return {
      'tuple.write': command('tuple.write', 'Adds a ReBAC tuple; a stored one is a no-op'),
      'tuple.delete': command('tuple.delete', 'Removes a ReBAC tuple, whatever caveat it carries; a missing one is a no-op'),
    };
  }
}

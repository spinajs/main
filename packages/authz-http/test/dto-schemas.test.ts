import 'mocha';
import { expect } from 'chai';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';
import { isValidField } from '@spinajs/authz';

import { ACCESS_CHECKS_SCHEMA, AccessController, CLIENT_CHECK_SCHEMA, EXPLAIN_QUERY_PROPERTIES, ExplainController, MAX_ACCESS_CHECKS } from '../src/index.js';

const route = (controller: { prototype: object }, name: string) => {
  const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.prototype) as IControllerDescriptor;
  return [...descriptor.Routes.get(name)!.Parameters.values()];
};

describe('authz-http route schemas', () => {
  it('documents the checks body and the explain query through the route parameters (the schemas http-swagger reads)', () => {
    const checks = route(AccessController, 'checks').find((p) => p.Type === 'FromBody')!;
    expect(checks.Schema).to.eq(ACCESS_CHECKS_SCHEMA);
    expect(checks.Schema).to.deep.include({ $id: 'authz.http.accessChecks', type: 'array', maxItems: MAX_ACCESS_CHECKS });

    const query = route(ExplainController, 'explain').filter((p) => p.Type === 'FromQuery');
    expect(query.sort((a, b) => a.Index - b.Index).map((p): unknown => p.Schema)).to.deep.eq([EXPLAIN_QUERY_PROPERTIES.principal, EXPLAIN_QUERY_PROPERTIES.permission, EXPLAIN_QUERY_PROPERTIES.resource, EXPLAIN_QUERY_PROPERTIES.format]);
  });

  it('keeps authz ids on the schemas, so they are validated without coercion', () => {
    expect(ACCESS_CHECKS_SCHEMA.$id).to.match(/^authz\./);
    expect(CLIENT_CHECK_SCHEMA.$id).to.match(/^authz\./);
  });

  it('checks a client entry with the field caps, tolerating unknown keys', () => {
    const entry = { object: { type: 'doc', id: '1' }, permission: 'edit', extra: true };
    expect(isValidField(CLIENT_CHECK_SCHEMA, entry)).to.eq(true);
    expect(isValidField(CLIENT_CHECK_SCHEMA, { ...entry, permission: 'e'.repeat(257) })).to.eq(false);
    expect(isValidField(CLIENT_CHECK_SCHEMA, { ...entry, object: { type: 'doc', id: '1'.repeat(161) } })).to.eq(false);
    expect(isValidField(CLIENT_CHECK_SCHEMA, { ...entry, context: { fieldMode: 'delete' } })).to.eq(false);
    expect(isValidField(CLIENT_CHECK_SCHEMA, 'nonsense')).to.eq(false);
  });
});

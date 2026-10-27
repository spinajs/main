import { expect } from 'chai';
import { analyzePackage } from '../../src/index.js';
import type { JsonSchema } from '../../src/schema/derive.js';

const HIDDEN = ['Password', 'PasswordSetAt', 'user_id'];

function propertyNames(schema: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) schema.forEach((item) => propertyNames(item, out));
  else if (schema && typeof schema === 'object') {
    const { properties } = schema as { properties?: JsonSchema };
    if (properties) Object.keys(properties).forEach((name) => out.add(name));
    Object.values(schema).forEach((value) => propertyNames(value, out));
  }
  return out;
}

describe('end to end: users-http response schemas', function () {
  this.timeout(120000);

  it('never list the @Hidden columns of the User model read from @spinajs/users', async () => {
    const fragment = await analyzePackage({ tsconfig: '../users-http/tsconfig.mjs.json', packageRoot: '../users-http' });
    const userId = 'spinajs/@spinajs/users-http/User';
    const routes = fragment.controllers.flatMap((c) => c.routes).filter((r) => r.returnType.schema === userId);
    expect(routes.length, 'routes returning User').to.be.greaterThan(0);
    expect(fragment.schemas[userId]).to.deep.equal({ $id: userId, type: 'object' });
    const exposed = [...propertyNames(fragment.schemas)].filter((name) => HIDDEN.includes(name));
    expect(exposed).to.deep.equal([]);
  });
});

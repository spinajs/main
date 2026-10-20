import 'mocha';
import { expect } from 'chai';
import { BaseController } from '@spinajs/http';
import { Model, ModelBase, Primary } from '@spinajs/orm';

import { Access, AllowAnonymous, UnfilteredInput, Unscoped, fromModel, fromParam, swaggerAccess, typedExtractor } from '../src/index.js';

@Model('swagger_docs')
class SwaggerDoc extends ModelBase {
  @Primary()
  public Id: string;
}

@Access('project:read')
class SwaggerRoutes extends BaseController {
  @Access(['user:read', 'user:list'], { resource: fromParam('uuid', 'user', { by: 'Uuid' }), domain: 'tenant' })
  public byParam() {}

  @Access('doc:update', { resource: fromModel(SwaggerDoc, 'doc') })
  @Unscoped('export')
  @UnfilteredInput('imports raw documents')
  public byModel() {}

  @AllowAnonymous()
  @Access('file:read', { resource: typedExtractor('file', () => ({ type: 'file' })) })
  public open() {}

  @Access('file:read', { resource: () => ({ type: 'file' }) })
  public custom() {}

  public inherited() {}
}

class Unguarded extends BaseController {
  public x() {}
}

describe('swaggerAccess', () => {
  it('describes permissions, resource, domain and the class @Access a route narrows', () => {
    expect(swaggerAccess(SwaggerRoutes, 'byParam')).to.deep.eq({
      'x-authz-permission': ['user:read', 'user:list'],
      'x-authz-controller-permission': ['project:read'],
      'x-authz-resource': { type: 'user', in: 'path', name: 'uuid', by: 'Uuid' },
      'x-authz-domain': 'tenant',
    });
  });

  it('names the model of fromModel and the reason of @Unscoped', () => {
    expect(swaggerAccess(SwaggerRoutes, 'byModel')).to.deep.include({ 'x-authz-resource': { in: 'path', name: 'doc', model: 'SwaggerDoc' }, 'x-authz-unscoped': 'export', 'x-authz-unfiltered-input': 'imports raw documents' });
  });

  it('marks @AllowAnonymous, reads a typed extractor, and leaves a custom one opaque', () => {
    expect(swaggerAccess(new SwaggerRoutes(), 'open')).to.deep.include({ 'x-authz-anonymous': true, 'x-authz-resource': { type: 'file' } });
    expect(swaggerAccess(SwaggerRoutes, 'custom')!['x-authz-resource']).to.deep.eq({});
  });

  it('falls back to the class @Access and its type-level resource', () => {
    expect(swaggerAccess(SwaggerRoutes, 'inherited')).to.deep.eq({ 'x-authz-permission': ['project:read'], 'x-authz-resource': { type: 'project' } });
  });

  it('is undefined for a route no @Access guards', () => {
    expect(swaggerAccess(Unguarded, 'x')).to.eq(undefined);
  });
});

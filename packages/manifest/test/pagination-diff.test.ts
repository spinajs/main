import { expect } from 'chai';
import 'mocha';
import { diffManifest } from '../src/index.js';
import type { Change, Manifest, RoutePagination, TypeRef } from '../src/index.js';
import { controllerEntry, manifestWith, routeEntry } from './support.js';

const USER = 'spinajs/app/UserDto';
const LIST = 'spinajs/app/UserDto_Array';
const PAGE = 'spinajs/app/Page_UserDto';
const schemas = {
  [USER]: { $id: USER, type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  [LIST]: { $id: LIST, type: 'array', items: { $ref: USER } },
  [PAGE]: { $id: PAGE, type: 'object', properties: { items: { type: 'array', items: { $ref: USER } }, total: { type: 'number' } }, required: ['items', 'total'] },
};
const offset: RoutePagination = { kind: 'offset', item: { text: 'UserDto', schema: USER }, param: { arg: 'query', path: ['page'] }, firstPage: 1 };
const cursor: RoutePagination = { kind: 'cursor', item: { text: 'UserDto', schema: USER }, param: { arg: 'query', path: ['cursor'] } };
const pageReply: TypeRef = { text: 'Page<UserDto>', schema: PAGE };

const withList = (returnType: TypeRef, pagination?: RoutePagination): Manifest =>
  manifestWith({ schemas, controllers: [controllerEntry({ className: 'Users', routes: [routeEntry('get', '/users/list', { returnType, ...(pagination ? { pagination } : {}) })] })] });

const routeChange = (base: Manifest, head: Manifest): Change | undefined => diffManifest(base, head).changes.find((c) => c.section === 'routes' && c.id === 'GET /users/list');

describe('diffManifest: pagination', () => {
  it('reports nothing while the pagination stays', () => {
    expect(routeChange(withList(pageReply, offset), withList(pageReply, { ...offset, firstPage: 0 }))).to.equal(undefined);
  });

  it('a route that stops being paginated is breaking', () => {
    const change = routeChange(withList(pageReply, offset), withList(pageReply));
    expect(change).to.include({ kind: 'changed', breaking: true });
    expect(change?.detail).to.equal('no longer paginated (was offset)');
  });

  it('a changed pagination kind is breaking', () => {
    const change = routeChange(withList(pageReply, offset), withList(pageReply, cursor));
    expect(change).to.include({ breaking: true });
    expect(change?.detail).to.equal('pagination changed from offset to cursor');
  });

  it('gaining pagination alone is not breaking', () => {
    const change = routeChange(withList(pageReply), withList(pageReply, offset));
    expect(change).to.include({ breaking: false });
    expect(change?.detail).to.equal('now paginated (offset)');
  });

  it('an array reply that becomes a page is breaking through the reply schema', () => {
    const change = routeChange(withList({ text: 'UserDto[]', schema: LIST }), withList(pageReply, offset));
    expect(change).to.include({ breaking: true });
    expect(change?.detail).to.contain('now paginated (offset)');
    expect(change?.detail).to.not.equal('now paginated (offset)');
  });
});

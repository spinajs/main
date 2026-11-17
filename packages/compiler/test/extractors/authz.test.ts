import { expect } from 'chai';
import ts from 'typescript';
import type { AuthzSection, ManifestFragment } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';
import { combineScopes, ignoreCommentsOf } from '../../src/extractors/authz.js';

const access = (...permissions: string[]) => ({ type: 'AccessPolicy', options: permissions });
const admin = { type: 'AdminPolicy', options: [] };

describe('authz section', () => {
  let fragment: ManifestFragment;
  let authz: AuthzSection;
  before(async () => {
    fragment = await analyzePackage({ tsconfig: 'test/fixtures/authz-pkg/tsconfig.json', packageRoot: 'test/fixtures/authz-pkg' });
    authz = fragment.authz!;
  });

  const entry = (id: string) => authz.entryPoints.find((e) => e.id === id);

  it('types a model by the nearest registered class of its chain, or by a literal registerAccessResource call', () => {
    expect(fragment.models.map((m) => [m.className, m.accessResource])).to.deep.equal([
      ['Note', 'doc'],
      ['Plain', 'plain'],
      ['Tag', undefined],
    ]);
  });

  it('lists each resource with the relation columns of its decorators and registration options', () => {
    expect(authz.resources.map((r) => [r.type, r.model, r.relations])).to.deep.equal([
      ['doc', 'authz-pkg:Note', [
        { name: 'editor', kind: 'relation', column: 'EditorId' },
        { name: 'self', kind: 'self', column: 'SelfId' },
        { name: 'parent', kind: 'parent', column: 'FolderId', target: 'folder' },
        { name: 'owner', kind: 'owner', column: 'OwnerId' },
      ]],
      ['plain', 'authz-pkg:Plain', [
        { name: 'parent', kind: 'parent', column: 'FolderId', target: 'folder' },
        { name: 'owner', kind: 'owner', column: 'OwnerColumn' },
        { name: 'reviewer', kind: 'relation', column: 'ReviewerId' },
      ]],
      ['job', '@spinajs/queue:JobModel', []],
    ]);
  });

  it('catalogues the permissions the ORM adapter registers for every resource type', () => {
    expect(authz.permissions.filter((p) => p.name.startsWith('doc:'))).to.deep.equal(['read', 'create', 'update', 'delete'].map((a) => ({ name: `doc:${a}`, declaredIn: 'model' })));
    expect(authz.permissions).to.have.length(12);
  });

  it('combines the class and handler scopes of a route', () => {
    expect(entry('GET /docs/:id')).to.deep.include({ kind: 'route', access: [[access('doc:read')]] });
    expect(entry('POST /docs/create')?.access).to.deep.equal([[access('doc:read'), access('doc:create')]]);
  });

  it('captures class-level and event @SocketAccess and @SocketPolicy', () => {
    const docs = fragment.socketControllers.find((c) => c.className === 'DocsSocket')!;
    expect(docs).to.deep.include({ access: ['doc:read'], policies: [[admin], [{ type: 'AccessPolicy', options: ['class'] }]] });
    expect(docs.events.find((e) => e.name === 'seen')).to.deep.include({ access: ['doc:read'], policies: [[{ type: 'AccessPolicy', options: ['route'] }]] });
    const open = fragment.socketControllers.find((c) => c.className === 'OpenSocket')!;
    expect(open).to.not.have.any.keys('access', 'policies');
    expect(open.events[0]).to.not.have.any.keys('access', 'policies');
  });

  it('lists socket commands and events with the class and handler scopes combined', () => {
    expect(entry('docs.edit')).to.deep.include({ kind: 'socket-command', access: [[admin, access('doc:update')], [access('doc:read'), access('doc:update')]] });
    expect(entry('docs.ping')?.access).to.deep.equal([[admin], [access('doc:read')]]);
    expect(entry('docs.seen')).to.deep.include({ kind: 'socket-event', access: [[admin, access('doc:read')], [access('doc:read'), access('doc:read')]] });
    expect(entry('hello')).to.deep.include({ kind: 'socket-event', access: [] });
  });

  it('lists queue handlers, schedules and CLI commands with their @SystemTask reason', () => {
    expect(entry('job:Reindex')).to.deep.include({ kind: 'queue-handler', access: [[access('doc:update')]] });
    expect(entry('job:Reindex')).to.not.have.property('system');
    expect(entry('job:Sweep')).to.deep.include({ access: [], system: 'purges expired drafts of every tenant' });
    expect(entry('event:DocSeen')).to.deep.include({ kind: 'queue-handler', access: [] });
    expect(authz.entryPoints.filter((e) => e.kind === 'queue-handler').map((e) => e.id)).to.deep.equal(['job:Reindex', 'job:Sweep', 'event:DocSeen', 'event:DocPublished']);
    expect(entry('nightly')).to.deep.include({ kind: 'schedule', system: 'nightly reindex' });
    expect(entry('docs:sync')).to.deep.include({ kind: 'cli', access: [] });
  });

  it('records spinajs-authz-ignore comments and leaves the findings to the flow pass', () => {
    expect(authz.ignores).to.deep.equal([{ code: 'AUTHZ001', reason: 'the export reads every document on purpose', source: { file: 'src/controller.ts', line: 10, col: 3, package: 'authz-pkg' } }]);
    expect(authz.findings).to.deep.equal([]);
    expect(authz).to.not.have.property('ir');
  });

  it('gives a socket subclass the class guards of its base, its own @SocketAccess replacing the inherited one', () => {
    const child = fragment.socketControllers.find((c) => c.className === 'ChildSocket')!;
    expect(child).to.deep.include({ access: ['doc:read'], policies: [[admin], [{ type: 'AccessPolicy', options: ['class'] }]] });
    expect(entry('child.own')?.access).to.deep.equal([[admin], [access('doc:read')]]);
    expect(entry('child.base')?.access).to.deep.equal([[admin], [access('doc:read')]]);
    const narrow = fragment.socketControllers.find((c) => c.className === 'NarrowSocket')!;
    expect(narrow).to.deep.include({ access: ['doc:update'], policies: [[admin], [{ type: 'AccessPolicy', options: ['class'] }]] });
    expect(entry('narrow.base')?.access).to.deep.equal([[admin], [access('doc:update')]]);
  });

  it('records the literal resource extractor and anonymous access with the permissions', () => {
    const share = { type: 'AccessPolicy', options: ['doc:share', { allowAnonymous: true, resource: { type: 'doc' } }] };
    expect(entry('narrow.share')?.access).to.deep.equal([[admin, share], [access('doc:update'), share]]);
    expect(entry('GET /open/note/:id')?.access).to.deep.equal([[{ type: 'AccessPolicy', options: ['doc:read', { allowAnonymous: true, resource: { type: 'doc' } }] }]]);
    expect(entry('GET /open/model/:id')?.access).to.deep.equal([[{ type: 'AccessPolicy', options: ['doc:update', { resource: { model: 'authz-pkg:Note' } }] }]]);
    expect(entry('GET /open/typed/:id')?.access).to.deep.equal([[{ type: 'AccessPolicy', options: ['report:run', { resource: { type: 'report' } }] }]]);
  });

  it('declares @Public and a bare @AllowAnonymous as the access of an otherwise unguarded route', () => {
    expect(entry('GET /open/health')?.access).to.deep.equal([[{ type: 'Public', options: ['load balancer probe'] }]]);
    expect(entry('GET /open/ping')?.access).to.deep.equal([[{ type: 'AllowAnonymous', options: [] }]]);
  });

  it('takes the @SystemTask of an event class for its consume() handler', () => {
    expect(entry('event:DocPublished')).to.deep.include({ kind: 'queue-handler', access: [], system: 'mirrors every published document to the search index' });
    expect(entry('event:DocSeen')).to.not.have.property('system');
  });

  it('crosses OR-of-AND scopes, an empty scope requiring nothing', () => {
    expect(combineScopes([[admin]], [])).to.deep.equal([[admin]]);
    expect(combineScopes([], [[admin]])).to.deep.equal([[admin]]);
    expect(combineScopes([[admin], [access('a:b')]], [[access('c:d')]])).to.deep.equal([[admin, access('c:d')], [access('a:b'), access('c:d')]]);
  });
});

describe('spinajs-authz-ignore comments', () => {
  const ignores = (...lines: string[]) => ({
    lf: ignoreCommentsOf(ts.createSourceFile('lf.ts', lines.join('\n'), ts.ScriptTarget.Latest)),
    crlf: ignoreCommentsOf(ts.createSourceFile('crlf.ts', lines.join('\r\n'), ts.ScriptTarget.Latest)),
  });
  const QUERY = 'const rows = await Invoice.all();';

  it('records a comment on its own line or after the code, with its reason', () => {
    const found = ignores('async function f() {', '  // spinajs-authz-ignore AUTHZ001: admin report', `  ${QUERY}`, '  await Invoice.destroy(); // spinajs-authz-ignore AUTHZ002: purge', '  // spinajs-authz-ignore AUTHZ006: last line of the block', '}');
    const expected = [
      { code: 'AUTHZ001', reason: 'admin report', line: 2, col: 3 },
      { code: 'AUTHZ002', reason: 'purge', line: 4, col: 28 },
      { code: 'AUTHZ006', reason: 'last line of the block', line: 5, col: 3 },
    ];
    expect(found.lf).to.deep.equal(expected);
    expect(found.crlf).to.deep.equal(expected);
  });

  describe('right after an opening {, ( or [ and after a comma, on the line before the query', () => {
    const at = (...lines: string[]) => {
      const found = ignores(...lines);
      return { lf: found.lf.map((i) => [i.line, i.col, i.reason]), crlf: found.crlf.map((i) => [i.line, i.col, i.reason]) };
    };
    const both = (row: (number | string)[]) => ({ lf: [row], crlf: [row] });

    it('after the { of a block', () => {
      expect(at('if (all) { // spinajs-authz-ignore AUTHZ001: after a brace', `  ${QUERY}`, '}')).to.deep.equal(both([1, 12, 'after a brace']));
    });

    it('after the { of an arrow body', () => {
      expect(at('const run = async () => { // spinajs-authz-ignore AUTHZ001: arrow body', `  ${QUERY}`, '};')).to.deep.equal(both([1, 27, 'arrow body']));
    });

    it('after an array element and its comma', () => {
      expect(at('await Promise.all([', '  Invoice.all(), // spinajs-authz-ignore AUTHZ001: element', '  Tag.all(),', ']);')).to.deep.equal(both([2, 18, 'element']));
    });

    it('after the last array element and a trailing comma', () => {
      expect(at('await Promise.all([', '  Tag.all(),', '  Invoice.all(), // spinajs-authz-ignore AUTHZ001: last element', ']);')).to.deep.equal(both([3, 18, 'last element']));
    });

    it('after a call argument and its comma', () => {
      expect(at('send(1, // spinajs-authz-ignore AUTHZ001: argument', '  Invoice.all());')).to.deep.equal(both([1, 9, 'argument']));
    });

    it('after an object property and its comma', () => {
      expect(at('const o = { a: 1, // spinajs-authz-ignore AUTHZ001: property', '  b: Invoice.all() };')).to.deep.equal(both([1, 19, 'property']));
    });

    it('after the ( of a call', () => {
      expect(at('send( // spinajs-authz-ignore AUTHZ001: after a parenthesis', '  Invoice.all());')).to.deep.equal(both([1, 7, 'after a parenthesis']));
    });
  });

  it('is no ignore with an empty reason, and the next line never becomes the reason', () => {
    expect(ignores('// spinajs-authz-ignore AUTHZ001:', QUERY)).to.deep.equal({ lf: [], crlf: [] });
  });

  it('is no ignore with a reason of whitespace only', () => {
    expect(ignores('// spinajs-authz-ignore AUTHZ001: \t ', QUERY)).to.deep.equal({ lf: [], crlf: [] });
  });

  it('reads no marker inside a string literal', () => {
    expect(ignores("const s = '// spinajs-authz-ignore AUTHZ001: not a comment';", QUERY)).to.deep.equal({ lf: [], crlf: [] });
  });

  it('reads no marker inside a template literal', () => {
    expect(ignores('const t = `', '// spinajs-authz-ignore AUTHZ001: not a comment', '`;', QUERY)).to.deep.equal({ lf: [], crlf: [] });
  });

  it('reads no marker inside JSX text', () => {
    const text = ['const view = (', '  <p>', '    // spinajs-authz-ignore AUTHZ001: not a comment', '  </p>', ');'].join('\n');
    expect(ignoreCommentsOf(ts.createSourceFile('view.tsx', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX))).to.deep.equal([]);
  });

  it('reads no marker inside a JSDoc comment', () => {
    expect(ignores('/**', ' * @returns {Promise<void>} // spinajs-authz-ignore AUTHZ001: not a line comment', ' */', 'export async function f() {', `  ${QUERY}`, '}')).to.deep.equal({ lf: [], crlf: [] });
  });

  it('takes no code from the next line after a bare marker', () => {
    expect(ignores('const codes = {', '  // spinajs-authz-ignore', "  AUTHZ001: 'read',", '};')).to.deep.equal({ lf: [], crlf: [] });
  });
});

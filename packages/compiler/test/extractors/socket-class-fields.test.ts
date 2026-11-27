import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { hashManifest, mergeFragments, type ManifestFragment, type SocketControllerEntry } from '@spinajs/manifest';
import { analyzePackage, createContext, createProgramFromTsconfig, extractSocketControllers } from '../../src/index.js';
import { NO_EXTERNAL_BASES } from '../../src/extractors/inherited-routes.js';
import { withInheritedHandlers } from '../../src/extractors/inherited-sockets.js';

/** What http-socket's AccessFieldsStage applies: the command's own `@SocketAccess` rule, else its controller's. */
const effective = (controller: SocketControllerEntry, handler: string): string => {
  const command = controller.commands.find((c) => c.handler === handler)!;
  return (command.access ? command.fields : controller.fields) ?? 'none';
};

describe('the class-level fields option of @SocketAccess', () => {
  const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(unit, 'unit', 'test/fixtures/unit');
  const sockets = withInheritedHandlers(extractSocketControllers(ctx, unit.sourceFiles.find((f) => f.fileName.endsWith('socket-class-fields.ts'))!), ctx, NO_EXTERNAL_BASES);
  const socket = (className: string) => sockets.find((s) => s.className === className)!;
  const row = (className: string, handlers = ['plain', 'own', 'rows']) => handlers.map((h) => effective(socket(className), h));

  it('records the class fields, a fields the build cannot read as filter', () => {
    expect(['BareSocket', 'FilteredSocket', 'UnreadSocket', 'NoneSocket'].map((c) => socket(c).fields)).to.deep.equal([undefined, 'filter', 'filter', undefined]);
  });

  it('agrees with the run time for a command without its own rule, with one without fields and with one with fields', () => {
    expect([row('BareSocket'), row('FilteredSocket'), row('UnreadSocket')]).to.deep.equal([
      ['none', 'none', 'filter-rows'],
      ['filter', 'none', 'filter-rows'],
      ['filter', 'none', 'filter-rows'],
    ]);
  });

  it("gives inherited and own commands the nearest class rule's fields, as the run time does", () => {
    expect(row('SubSocket', ['plain', 'own', 'rows', 'extra'])).to.deep.equal(['filter', 'none', 'filter-rows', 'filter']);
    expect(row('SubOpenSocket')).to.deep.equal(['none', 'none', 'filter-rows']);
    expect(row('SubRowsSocket')).to.deep.equal(['filter-rows', 'none', 'filter-rows']);
    expect(row('LeafSocket', ['plain', 'extra'])).to.deep.equal(['filter', 'filter']);
  });

  it('notes a class fields it cannot read once, at the options', () => {
    const notes = ctx.diagnostics.filter((d) => d.code === 'CMP001' && d.message.startsWith('the fields option of @SocketAccess') && d.source?.file.endsWith('socket-class-fields.ts')).map((d) => [d.message, d.source?.line]);
    expect(notes).to.deep.equal([[`the fields option of @SocketAccess cannot be read ({ fields: MODE }): recorded as filtering, the generated client types the result of each command without its own @SocketAccess as Redacted<T>`, 28]]);
  });
});

describe('class-level socket fields from a dependency fragment', function () {
  this.timeout(120_000);
  let fragment: ManifestFragment;
  const feed = (className: string) => fragment.socketControllers.find((c) => c.className === className)!;

  before(async () => {
    fragment = await analyzePackage({ tsconfig: 'test/fixtures/inherited-app/tsconfig.json', packageRoot: 'test/fixtures/inherited-app' });
  });

  it("takes the base's class fields when the subclass declares no class rule", () => {
    expect(feed('GuardedFeed')).to.deep.include({ access: ['feed:read'], fields: 'filter' });
    expect(effective(feed('GuardedFeed'), 'peek')).to.equal('filter');
  });

  it("drops them under the subclass's own class rule without fields", () => {
    expect(feed('OpenGuardedFeed')).to.deep.include({ access: ['feed:share'] });
    expect(feed('OpenGuardedFeed')).to.not.have.property('fields');
  });

  it('records nothing for a base whose fragment has no class fields', () => {
    expect(feed('FilesFeed')).to.not.have.property('fields');
  });
});

describe('inherited and redeclared socket commands, against the run time', function () {
  this.timeout(120_000);
  let fragment: ManifestFragment;

  before(async () => {
    fragment = await analyzePackage({ tsconfig: 'test/fixtures/socket-redeclared/tsconfig.json', packageRoot: 'test/fixtures/socket-redeclared' });
  });

  // The run-time column is what a booted http-socket server did with the same classes: the review of this branch
  // (.superpowers/sdd/v4/finish/build/v4-sx-11c-socket-class-fields-review.md, "Inheritance", runtime.json), fields and permissions checked.
  const RUN_TIME: Array<[string, string, string, string[]]> = [
    ['I1Socket', 'a', 'filter', ['doc:read']],
    ['I1Socket', 'g', 'filter', ['doc:read', 'doc:update']],
    ['I1Socket', 'p', 'none', ['doc:read', 'doc:update']],
    ['I2Socket', 'a', 'filter', ['doc:read']],
    ['I2Socket', 'g', 'filter', ['doc:read', 'doc:update']],
    ['I2Socket', 'p', 'none', ['doc:read', 'doc:update']],
    ['I3Socket', 'a', 'none', ['doc:read']],
    ['I3Socket', 'g', 'filter', ['doc:read', 'doc:update']],
    ['I3Socket', 'p', 'none', ['doc:read', 'doc:update']],
    ['I4Socket', 'a', 'filter', ['doc:read']],
    ['I4Socket', 'g', 'none', ['doc:read', 'doc:update']],
    ['I4Socket', 'p', 'filter-rows', ['doc:read', 'doc:update']],
    ['I5Socket', 'a', 'filter', ['doc:read']],
    ['I5Socket', 'g', 'filter', ['doc:read', 'doc:update']],
    ['I5Socket', 'p', 'none', ['doc:read', 'doc:update']],
    ['I5Socket', 'own', 'filter', ['doc:read']],
  ];

  it('records the fields and the permissions the run time applies, command by command', () => {
    const build = RUN_TIME.map(([className, handler]) => {
      const controller = fragment.socketControllers.find((c) => c.className === className)!;
      const command = controller.commands.find((c) => c.handler === handler)!;
      return [className, handler, effective(controller, handler), [...(controller.access ?? []), ...(command.access ?? [])]];
    });
    expect(build).to.deep.equal(RUN_TIME);
  });
});

describe('a manifest without class-level socket fields', function () {
  this.timeout(120_000);

  it('keeps the bytes and the hash of its committed fragment', async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
    const committed = readFileSync('test/__snapshots__/pkg-basic.fragment.json', 'utf8');
    const hashOf = (f: ManifestFragment) => hashManifest(mergeFragments(f, [], { app: { name: 'pkg-basic', version: '1.0.0', root: '.', outDir: 'lib' }, packages: [], generatedAt: '2026-01-01T00:00:00.000Z' }));
    expect(`${JSON.stringify(fragment, null, 2)}\n`).to.equal(committed);
    // the hash this fixture had before SocketControllerEntry gained `fields`
    expect(hashOf(fragment)).to.equal('3181f19267722882292cc0335bc000a5815094ea3304709ea5df860d4ccf82bf');
  });
});

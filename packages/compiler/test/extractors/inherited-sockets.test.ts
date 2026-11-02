import 'mocha';
import { expect } from 'chai';
import type { ManifestFragment } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';

describe('inherited socket handlers', function () {
  this.timeout(120_000);
  let fragment: ManifestFragment;
  const things = () => fragment.socketControllers.find((c) => c.className === 'ThingsSocket')!;

  before(async () => {
    fragment = await analyzePackage({ tsconfig: 'test/fixtures/no-metadata/tsconfig.json', packageRoot: 'test/fixtures/no-metadata' });
  });

  it('lists the base commands and events on the subclass with their origin', () => {
    expect(things().commands.map((c) => `${c.name} <${c.inheritedFrom}`)).to.deep.equal(['save <no-metadata:CrudSocket']);
    expect(things().events.map((e) => `${e.name} <${e.inheritedFrom}`)).to.deep.equal(['touched <no-metadata:CrudSocket']);
    expect(things().bases).to.deep.equal(['no-metadata:CrudSocket']);
  });

  it('types payload and result with what the subclass binds', () => {
    const save = things().commands[0];
    expect(save.payload.text).to.equal('Hello');
    expect(save.result.text).to.equal('Hello');
    expect(save.payloadIndex).to.equal(0);
    expect(things().events[0].payload.text).to.equal('Hello');
  });

  it('keeps the declaration-site runtime ref of the payload', () => {
    const base = fragment.socketControllerBases!.find((c) => c.className === 'CrudSocket')!;
    expect(things().commands[0].payload.ref).to.deep.equal(base.commands[0].payload.ref);
  });

  it('inherits the @FromDI arguments of the base handlers', () => {
    expect(things().diArgs?.map((a) => `${a.handler}:${a.index}`)).to.deep.equal(['save:1']);
  });

  it('records the handler of each event', () => {
    const base = fragment.socketControllerBases!.find((c) => c.className === 'CrudSocket')!;
    expect(base.events.map((e) => `${e.name}:${e.handler}:${e.payloadIndex}`)).to.deep.equal(['touched:touched:0']);
  });
});

describe('inherited socket handlers from a dependency fragment', function () {
  this.timeout(120_000);
  let fragment: ManifestFragment;
  const feed = () => fragment.socketControllers.find((c) => c.className === 'FilesFeed')!;

  before(async () => {
    fragment = await analyzePackage({ tsconfig: 'test/fixtures/inherited-app/tsconfig.json', packageRoot: 'test/fixtures/inherited-app' });
  });

  it('takes the handlers from the dependency fragment', () => {
    expect(feed().commands.map((c) => `${c.name} <${c.inheritedFrom}`)).to.deep.equal(['feed.publish <inherited-lib:FeedSocket', 'feed.follow <inherited-lib:FeedSocket']);
    expect(feed().events.map((e) => `${e.name} <${e.inheritedFrom}`)).to.deep.equal(['feed.changed <inherited-lib:FeedSocket', 'feed.renamed <inherited-lib:FeedSocket']);
    expect(feed().bases).to.deep.equal(['inherited-lib:FeedSocket']);
  });

  it('types the command and an event with a recorded handler through the declaration file', () => {
    expect(feed().commands[0].payload.text).to.equal('FileDto');
    expect(feed().commands[0].result.text).to.equal('FileDto');
    expect(feed().events[0].payload.text).to.equal('FileDto');
  });

  it('types a streamed command by its item', () => {
    expect(feed().commands[1]).to.deep.include({ stream: true, payload: { text: 'void' } });
    expect(feed().commands[1].result.text).to.equal('FileDto');
  });

  it('keeps the recorded payload of an event whose fragment names no handler', () => {
    expect(feed().events[1].payload).to.deep.equal({ text: 'T' });
  });
});

describe('a socket controller that inherits nothing', function () {
  this.timeout(120_000);

  it('records neither payloadIndex nor an event handler', async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
    const docs = fragment.socketControllers.find((c) => c.className === 'DocsSocket')!;
    expect(docs.commands.length + docs.events.length).to.be.greaterThan(0);
    for (const c of docs.commands) expect(c).to.not.have.property('payloadIndex');
    for (const e of docs.events) {
      expect(e).to.not.have.property('payloadIndex');
      expect(e).to.not.have.property('handler');
    }
  });
});

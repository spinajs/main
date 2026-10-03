import 'mocha';
import { expect } from 'chai';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileOutboxStore } from '../src/node/file-outbox.js';
import * as node from '../src/node/index.js';
import { describeOutboxStore } from './support/outbox-contract.js';

const root = mkdtempSync(join(tmpdir(), 'spinajs-outbox-'));
let cases = 0;
const nextPath = () => join(root, `case-${++cases}`, 'outbox.json');

describeOutboxStore(
  'FileOutboxStore',
  () => {
    const path = nextPath();
    return { create: async () => new FileOutboxStore(path), reopen: async () => new FileOutboxStore(path) };
  },
  { reopens: true },
);

describe('FileOutboxStore', () => {
  after(() => rmSync(root, { recursive: true, force: true }));

  it('writes the whole queue as one JSON file and leaves no temp file behind', async () => {
    const path = nextPath();
    await new FileOutboxStore(path).add({ name: 'x', payload: { n: 1 } });

    const saved = JSON.parse(readFileSync(path, 'utf8')) as { version: number; seq: number; pending: unknown[]; failed: unknown[] };

    expect(saved).to.include({ version: 1, seq: 1 });
    expect(saved.pending).to.have.length(1);
    expect(saved.failed).to.deep.equal([]);
    expect(existsSync(`${path}.tmp`)).to.be.false;
  });

  it('is durable without a clean close: a new instance sees every resolved change while the first is still open', async () => {
    const path = nextPath();
    const first = new FileOutboxStore(path);
    const a = await first.add({ name: 'x', payload: 1 });
    const b = await first.add({ name: 'x', payload: 2 });
    await first.remove(a.seq);

    const second = new FileOutboxStore(path);

    expect((await second.pending()).map((e) => e.seq)).to.deep.equal([b.seq]);
    expect((await second.add({ name: 'x', payload: 3 })).seq).to.be.above(b.seq);
  });

  it('ignores a temp file a crash left behind', async () => {
    const path = nextPath();
    await new FileOutboxStore(path).add({ name: 'x', payload: 1 });
    writeFileSync(`${path}.tmp`, '{"version":1,"seq":99,"pen');

    expect((await new FileOutboxStore(path).pending()).map((e) => e.seq)).to.deep.equal([1]);
  });

  it('refuses a damaged file instead of starting an empty queue', async () => {
    const path = nextPath();
    await new FileOutboxStore(path).add({ name: 'x', payload: 1 });
    writeFileSync(path, '{"version":1,"seq":1,"pen');

    const error = await new FileOutboxStore(path).pending().catch((e: unknown) => e);

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain(path);
  });

  it('applies concurrent changes one after another', async () => {
    const store = new FileOutboxStore(nextPath());

    const entries = await Promise.all(Array.from({ length: 10 }, (_, i) => store.add({ name: 'x', payload: i })));

    expect(entries.map((e) => e.seq)).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await store.pending()).map((e) => e.payload)).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('keeps stores over different files, or in different directories, apart', async () => {
    const dir = join(root, `case-${++cases}`);
    const a = new FileOutboxStore(join(dir, 'a.json'));
    const b = new FileOutboxStore(join(dir, 'b.json'));
    const c = new FileOutboxStore(nextPath());

    await a.add({ name: 'only-a', payload: 1 });
    await b.add({ name: 'only-b', payload: 2 });
    await b.add({ name: 'only-b', payload: 3 });

    expect((await a.pending()).map((e) => e.name)).to.deep.equal(['only-a']);
    expect((await b.pending()).map((e) => e.name)).to.deep.equal(['only-b', 'only-b']);
    expect(await c.pending()).to.deep.equal([]);
    expect((await new FileOutboxStore(join(dir, 'a.json')).pending()).map((e) => e.name)).to.deep.equal(['only-a']);
  });

  it('stays on the old queue when a write fails', async () => {
    const path = nextPath();
    const store = new FileOutboxStore(path);
    await store.add({ name: 'x', payload: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await store.add({ name: 'x', payload: circular }).then(
      () => expect.fail('add should have failed'),
      () => undefined,
    );

    expect((await store.pending()).map((e) => e.seq)).to.deep.equal([1]);
    expect((await store.add({ name: 'x', payload: 2 })).seq).to.equal(2);
  });

  it('is exported by the ./node entry beside the main entry', () => {
    expect(node.FileOutboxStore).to.equal(FileOutboxStore);
    expect(node).to.have.property('SocketClient');
  });
});

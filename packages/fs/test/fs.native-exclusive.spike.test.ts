/* eslint-disable security/detect-non-literal-fs-filename */
import 'mocha';
import { expect } from 'chai';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Spike §11.6: the Node facts fsNative's exclusive writeStream rests on. Imports nothing from @spinajs, so it also runs in a Linux container.
describe(`spike: the 'wx' open flag on ${process.platform}`, function () {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'spinajs-wx-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses an existing file with EEXIST and leaves its content', async () => {
    const path = join(root, 'a.txt');
    await writeFile(path, 'old');

    const error = await open(path, 'wx').then(
      async (h) => {
        await h.close();
        return undefined;
      },
      (e: NodeJS.ErrnoException) => e,
    );

    expect(error?.code).to.equal('EEXIST');
    expect(await readFile(path, 'utf-8')).to.equal('old');
  });

  it('lets exactly one of many concurrent opens create the file', async () => {
    const path = join(root, 'race.txt');

    const results = await Promise.allSettled(Array.from({ length: 16 }, () => open(path, 'wx')));
    const won = results.filter((r): r is PromiseFulfilledResult<FileHandle> => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    await Promise.all(won.map((r) => r.value.close()));

    expect(won).to.have.length(1);
    expect(lost.map((r) => (r.reason as NodeJS.ErrnoException).code)).to.deep.equal(Array<string>(15).fill('EEXIST'));
  });

  it('streams into the handle it opened and closes the handle when the stream ends', async () => {
    const path = join(root, 'n.txt');
    const handle = await open(path, 'wx');

    await pipeline(Readable.from(['hel', 'lo']), handle.createWriteStream({ encoding: 'utf-8' }));

    expect(await readFile(path, 'utf-8')).to.equal('hello');
    expect(handle.fd).to.equal(-1);
  });

  it('reports a parent path that is a file as EEXIST from mkdir -p, the same code as an existing target', async () => {
    await writeFile(join(root, 'file.txt'), 'x');

    const error = await mkdir(join(root, 'file.txt'), { recursive: true }).then(
      () => undefined,
      (e: NodeJS.ErrnoException) => e,
    );

    expect(error?.code).to.equal('EEXIST');
  });
});

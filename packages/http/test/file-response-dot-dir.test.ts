import 'mocha';
import { expect } from 'chai';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendFileAt } from '../src/response-methods/send-file.js';

describe('sendFileAt', () => {
  let dir: string;
  let server: Server;
  let base: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'send-file-'));
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, '.hidden', 'a.txt'), 'hello');
    writeFileSync(join(dir, '.hidden', '.secret'), 'nope');

    const app = express();
    app.get('/file', (req, res) => sendFileAt(res, String(req.query.path), (err) => err && res.status(404).end()));
    server = await new Promise<Server>((ok) => {
      const s = app.listen(0, () => ok(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file?path=`;
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a file whose directory path contains a dot segment', async () => {
    const res = await fetch(base + encodeURIComponent(join(dir, '.hidden', 'a.txt')));

    expect(res.status).to.eq(200);
    expect(await res.text()).to.eq('hello');
  });

  it('still refuses a hidden file name', async () => {
    const res = await fetch(base + encodeURIComponent(join(dir, '.hidden', '.secret')));

    expect(res.status).to.eq(404);
  });
});

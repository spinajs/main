import 'mocha';
import { expect } from 'chai';
import { DiagnosticSeverity, Parser } from '@asyncapi/parser';
import type { Manifest, SourceRef } from '@spinajs/manifest';
import { manifestToAsyncApi } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';

const source: SourceRef = { file: 'src/order.ts', line: 1, col: 1, package: 'app-basic' };
const emptyManifest: Manifest = {
  manifestVersion: 2,
  app: { name: 'app', version: '1.0.0', root: '.', outDir: 'lib' },
  packages: [],
  services: [], values: [], controllers: [], socketControllers: [], socketContracts: [],
  configModules: [], configUsages: [], models: [], migrations: [], schedules: [], commands: [], queueMessages: [],
  schemas: {}, diagnostics: [], generatedAt: '2026-11-10T00:00:00.000Z', hash: '',
};

describe('manifestToAsyncApi: workflow signals', () => {
  it('adds one send channel per literal signal, with the permission of the newest version', async () => {
    const manifest: Manifest = {
      ...(await appBasicManifest()),
      workflows: [
        { name: 'order', version: 1, className: 'OrderV1', signals: [{ name: 'approved' }], source },
        { name: 'order', version: 2, className: 'OrderV2', signals: [{ name: 'approved', permission: 'orders:approve' }, { name: 'note' }, { name: '*' }], source },
      ],
    };
    const doc = manifestToAsyncApi(manifest, { title: 'app-basic', version: '1.0.0' });
    expect(Object.keys(doc.channels).filter((k) => k.startsWith('workflow/'))).to.deep.equal(['workflow/order/approved', 'workflow/order/note']);
    expect(doc.channels['workflow/order/approved']).to.deep.equal({
      address: 'workflow/order/approved',
      messages: { signal: { $ref: '#/components/messages/workflow.order.approved' } },
      'x-spinajs-workflow': 'order',
      'x-spinajs-permission': 'orders:approve',
    });
    expect(doc.channels['workflow/order/note']).to.not.have.property('x-spinajs-permission');
    expect(doc.operations['workflow.order.approved.send']).to.deep.equal({
      action: 'send',
      channel: { $ref: '#/channels/workflow~1order~1approved' },
      messages: [{ $ref: '#/channels/workflow~1order~1approved/messages/signal' }],
    });
    const { diagnostics } = await new Parser().parse(JSON.stringify(doc));
    expect(diagnostics.filter((d) => Number(d.severity) === Number(DiagnosticSeverity.Error))).to.deep.equal([]);
  });

  it('documents no channel for a signal name signal() refuses', () => {
    const doc = manifestToAsyncApi(
      { ...emptyManifest, workflows: [{ name: 'order', version: 1, className: 'OrderV1', signals: [{ name: 'a#b' }, { name: 'a*' }, { name: 'ok' }], source }] },
      { title: 'app', version: '1.0.0' },
    );
    expect(Object.keys(doc.channels)).to.deep.equal(['workflow/order/ok']);
  });

  it('encodes names, so separators never merge two channels, and prefers the permissioned entry of one version', async () => {
    const doc = manifestToAsyncApi(
      {
        ...emptyManifest,
        workflows: [
          { name: 'a/b', version: 1, className: 'A', signals: [{ name: 'c' }], source },
          { name: 'a', version: 1, className: 'B', signals: [{ name: 'b/c' }, { name: '{id}' }, { name: 'x' }, { name: 'x', permission: 'need' }], source },
          { name: 'a.b', version: 1, className: 'C', signals: [{ name: 'c~d' }], source },
        ],
      },
      { title: 'app', version: '1.0.0' },
    );
    expect(Object.keys(doc.channels)).to.deep.equal(['workflow/a$2e;b/c$7e;d', 'workflow/a$2f;b/c', 'workflow/a/$7b;id$7d;', 'workflow/a/b$2f;c', 'workflow/a/x']);
    expect(doc.channels['workflow/a/x']).to.have.property('x-spinajs-permission', 'need');
    expect(doc.channels['workflow/a$2e;b/c$7e;d']).to.deep.include({ messages: { signal: { $ref: '#/components/messages/workflow.a$2e;b.c$7e;d' } }, 'x-spinajs-workflow': 'a.b' });
    expect(Object.keys(doc.operations)).to.have.length(5);
    const { diagnostics } = await new Parser().parse(JSON.stringify(doc));
    expect(diagnostics.filter((d) => Number(d.severity) === Number(DiagnosticSeverity.Error))).to.deep.equal([]);
  });
});

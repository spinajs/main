import 'mocha';
import { expect } from 'chai';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDoctorContext, DEFAULT_RULES } from '../../src/doctor/index.js';
import { hasBuiltFragments, installApp, type InstalledApp, type ProbeResult, type SocketReply } from './support/installed-app.js';

const TMP = resolve('test/fixtures/.tmp-e2e-socket-contract');

const notesSocket = (id: string): string => `
import { BaseSocketController, Command, Payload, SocketController } from '@spinajs/http-socket';
import { defineContract } from '@spinajs/http-socket-common';
import { Schema } from '@spinajs/validation';

type Draft = { text: string };
// Accepts more than the contract lets a client send: a refused \`tag\` can only come from the contract.
type TaggedDraft = { text: string; tag?: string };
type Saved = { id: string };

@Schema({
  type: 'object',
  properties: { low: { type: 'integer' }, high: { type: 'integer', minimum: { $data: '1/low' } } },
  required: ['low', 'high'],
  additionalProperties: false,
})
export class Span {
  public low: number;
  public high: number;

  constructor(data: { low: number; high: number }) {
    this.low = data.low;
    this.high = data.high;
  }
}

type Notes = { commands: { 'notes.save': [Draft, Saved]; 'notes.span': [Span, Saved] }; events: Record<string, never> };

export const NOTES = defineContract<Notes>(${id});

@SocketController('notes', { contract: NOTES })
export class NotesSocketController extends BaseSocketController {
  @Command('save')
  public async save(@Payload() payload: TaggedDraft): Promise<Saved> {
    return { id: payload.text };
  }

  @Command('span')
  public async span(@Payload() payload: Span): Promise<Saved> {
    return { id: String(payload.high) };
  }
}
`;

const CALLS = JSON.stringify([
  ['notes.save', { text: 'a' }],
  ['notes.save', { text: 'a', tag: 'b' }],
  ['notes.span', { low: 1, high: 2 }],
  ['notes.span', { low: 987654, high: 2 }],
]);

const usesData = (value: unknown): boolean => value !== null && typeof value === 'object' && Object.entries(value).some(([key, member]) => key === '$data' || usesData(member));

function expectContractEnforced(replies: SocketReply[]): void {
  const [accepted, refused, inSpan, outOfSpan] = replies;
  expect(accepted.result).to.deep.equal({ id: 'a' });
  expect(refused.error?.code).to.equal('invalid_argument');
  expect(refused.error?.message).to.equal('payload does not match the socket contract');

  expect(inSpan.result).to.deep.equal({ id: '2' });
  expect(outOfSpan.error?.message).to.equal('payload does not match the socket contract');
  expect(JSON.stringify(outOfSpan.error)).to.not.contain('987654');
}

for (const scenario of [
  { name: 'a contract with the default id', literal: '', id: 'app-basic:NOTES' },
  { name: 'an explicitly named contract', literal: `'notes.v1'`, id: 'notes.v1' },
  // its configuration schema holds subschemas the compiler could not read, which Ajv refuses with or without $data
  { name: 'a contract next to the authz-rbac configuration schema', literal: '', id: 'app-basic:NOTES', dependencies: ['@spinajs/authz-rbac'] },
]) {
  describe(`${scenario.name} in a real manifest boot`, function () {
    this.timeout(300_000);

    let installed: InstalledApp;
    const inMode = (mode: string): ProbeResult => installed.boot({ SPINAJS_MANIFEST_MODE: mode, SPINAJS_MANIFEST: installed.manifestPath, E2E_SOCKET_CALLS: CALLS });

    before(async function () {
      if (!hasBuiltFragments()) {
        if (process.env.CI) throw new Error('no built @spinajs fragments (lib/manifest.fragment.json): run `npm run build` at the repo root first');
        console.log('    skipped: no built @spinajs fragments (lib/manifest.fragment.json), run `npm run build` at the repo root');
        this.skip();
      }
      installed = await installApp(TMP, { sources: { 'src/socket/notes.ts': notesSocket(scenario.literal) }, dependencies: scenario.dependencies });
    });

    after(() => {
      if (!process.env.E2E_KEEP) rmSync(TMP, { recursive: true, force: true });
    });

    it('the controller entry and the contract entry carry one id', () => {
      expect(installed.manifest.socketControllers.find((c) => c.className === 'NotesSocketController')?.contract).to.equal(scenario.id);
      expect(installed.manifest.socketContracts.map((c) => c.id)).to.deep.equal([scenario.id]);
    });

    it('the manifest holds the http-socket configuration schema with its $data rule, as in every app using sockets', () => {
      const module = installed.manifest.configModules.find((m) => m.schemaId.includes('socket'));
      expect(module, 'the configuration module of @spinajs/http-socket').to.not.equal(undefined);
      expect(usesData(installed.manifest.schemas[module!.schemaId])).to.equal(true);
    });

    it('require boots and the contract decides the wire', () => {
      const required = inMode('require');
      expect(required.socketCommands).to.include('notes.save');
      expectContractEnforced(required.socketReplies);
    });

    it('prefer boots and the contract decides the wire', () => {
      expectContractEnforced(inMode('prefer').socketReplies);
    });

    it('the doctor sees the contract as bound', async () => {
      const context = createDoctorContext(installed.manifest, { cwd: installed.root });
      const found = (await Promise.all(DEFAULT_RULES.map((rule) => rule.run(installed.manifest, context)))).flat().filter((d) => d.code.startsWith('SOCK'));
      expect(found.map((d) => `${d.code} ${d.message}`)).to.deep.equal([]);
    });
  });
}

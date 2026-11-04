import 'mocha';
import { expect } from 'chai';
import * as fc from 'fast-check';
import type { Manifest } from '@spinajs/manifest';
import { buildClientModel, generateClientFiles, type GeneratedFile } from '../../src/index.js';
import { appBasicManifest, corpusManifest } from '../support/fixture.js';
import { clearMocks, loadMocks, mockFunction, serverCheck, type MocksModule } from '../support/mocks.js';
import { mockCorpusManifest, UNSUPPORTED_IDS } from './corpus.js';

// MOCK_RUNS raises the seeds per DTO for a longer local run.
const RUNS = Number(process.env.MOCK_RUNS ?? 60);

/**
 * Every mock the generated `client.mocks.ts` gives, for any seed and both optional modes, passes the server's
 * `ManifestValidator` for its DTO (JSON body options: no coercion, closed). The DTOs whose mock throws are exactly
 * the ones with a `MOCK001` diagnostic.
 */
describe('client.mocks.ts: parity with the server validation', function () {
  this.timeout(300000);

  after(clearMocks);

  const fixtures: [string, () => Promise<Manifest>][] = [
    ['app-basic', appBasicManifest],
    ['schema-corpus', corpusManifest],
    ['mock-corpus', async () => mockCorpusManifest(await appBasicManifest())],
  ];

  for (const [fixture, load] of fixtures) {
    describe(fixture, () => {
      let manifest: Manifest;
      let file: GeneratedFile;
      let module: MocksModule;
      let dtos: { id: string; name: string }[];
      let check: (id: string, value: unknown) => string | undefined;

      before(async () => {
        manifest = await load();
        [, file] = await generateClientFiles({ manifest, mocks: true });
        module = await loadMocks(file.contents);
        const { ctx } = buildClientModel(manifest);
        dtos = [...ctx.used].map((id) => ({ id, name: ctx.nameOf(id) }));
        check = serverCheck(manifest);
      });

      it('gives only values the server accepts, and skips exactly the MOCK001 schemas', () => {
        const skipped = new Set<string>();
        for (const { id, name } of dtos) {
          const mock = mockFunction(module, name);
          fc.assert(
            fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.constantFrom('some' as const, 'all' as const), (seed, optional) => {
              let value: unknown;
              try {
                value = mock({}, { seed, optional });
              } catch (e) {
                if (!(e instanceof Error) || e.name !== 'MockUnsupported') throw e;
                skipped.add(id);
                return;
              }
              const error = check(id, value);
              if (error !== undefined) throw new Error(`${name} (seed ${seed}, optional ${optional}): ${error}`);
            }),
            { numRuns: RUNS },
          );
        }
        const flagged = new Set((file.diagnostics ?? []).filter((d) => d.code === 'MOCK001' && dtos.some((dto) => dto.id === d.schema)).map((d) => d.schema));
        expect([...skipped].sort()).to.deep.equal([...flagged].sort());
        if (fixture === 'mock-corpus') expect([...skipped].sort()).to.deep.equal([...UNSUPPORTED_IDS].sort());
        else expect([...skipped]).to.deep.equal([]);
      });

      it("answers every route of createMockAppClient with fallback: 'mock' as the reply schema says", async () => {
        const model = buildClientModel(manifest);
        for (const seed of [1, 2, 3, 99]) {
          const client = module.createMockAppClient({}, { fallback: 'mock', seed });
          for (const controller of model.controllers) {
            for (const route of controller.routes) {
              const reply = await client[controller.key][route.name]();
              if (route.returns === 'void') expect(reply, `${controller.key}.${route.name}`).to.equal(undefined);
              else if (route.returnSchema !== undefined) expect(check(route.returnSchema, reply), `${controller.key}.${route.name}`).to.equal(undefined);
            }
          }
        }
      });
    });
  }
});

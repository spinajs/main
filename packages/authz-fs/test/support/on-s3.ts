import { SYSTEM } from '@spinajs/authz';
import { fixtureDsl, laneSteps } from '@spinajs/authz-testing';
import type { BehaviourFixture, Case, FixtureExtension } from '@spinajs/authz-testing';

const { extension } = fixtureDsl;
const { as, fsCall } = laneSteps;

const UPLOADS = { fs: 'uploads' };
const NOT_IMPLEMENTED = { throws: 'MethodNotImplemented' } as const;
const NO_UNZIP = 'fsS3.unzip extracts through fsNative, which calls dstFs.resolvePath, so it cannot extract onto S3';

/** Cases that cannot hold on fsS3 for a provider reason, not a guard reason (RFC L7-1 (d)), by part and name. */
export const NOT_ON_S3: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'B28.fs': {
    'resolvePath, tmppath and tmpname are not checks': 'fsS3.resolvePath of a relative path and fsS3.tmppath throw MethodNotImplemented',
    'enforce: unzip needs fs:read on arch.zip and fs:write on unz': NO_UNZIP,
  },
  'B16.fs-owner': {
    "moving a directory onto another user's directory does not take it over, so its files cannot be deleted": 'S3 has no directories: fsS3.isDir is always false, so the guard checks the directory as a file, and fsS3.move moves one key',
    "unzipping into another user's directory does not take it over, so its files cannot be deleted": NO_UNZIP,
  },
};

function findCase(list: readonly (BehaviourFixture | FixtureExtension)[], id: string, part: string, name: string): Case {
  for (const f of list) {
    const found = f.id === id ? f.parts.find((p) => p.name === part)?.cases.find((c) => c.name === name) : undefined;
    if (found) return found;
  }
  throw new Error(`${id}.${part} has no case ${JSON.stringify(name)}: update NOT_ON_S3`);
}

/** What the B28.fs cases of NOT_ON_S3 still prove on S3: the guard lets the call through, and fsS3's own error comes back. */
function b28OnS3(list: readonly (BehaviourFixture | FixtureExtension)[]): Case[] {
  const world = (name: string) => findCase(list, 'B28', 'fs', name).world;
  return [
    {
      name: 'resolvePath, tmppath and tmpname are not checks: fsS3 answers them itself',
      world: world('resolvePath, tmppath and tmpname are not checks'),
      steps: [fsCall('uploads', 'tmpname', [], 'resolves'), fsCall('uploads', 'resolvePath', ['docs/a.txt'], NOT_IMPLEMENTED), fsCall('uploads', 'tmppath', [], NOT_IMPLEMENTED), { calls: { model: 'm1', count: 0 } }],
    },
    {
      name: 'enforce: unzip with fs:read on arch.zip and fs:write on unz passes the guard; fsS3 cannot extract onto S3',
      world: world('enforce: unzip needs fs:read on arch.zip and fs:write on unz'),
      steps: [{ runAs: { as: SYSTEM, reason: 'behaviour fixture' }, steps: [fsCall('uploads', 'zip', [['docs/b.txt'], UPLOADS, 'arch.zip'], 'resolves')] }, as('alice', fsCall('uploads', 'unzip', ['arch.zip', 'unz', UPLOADS], NOT_IMPLEMENTED)), { calls: { model: 'm1', atLeast: 2 } }],
    },
  ];
}

/** `list` without the cases of NOT_ON_S3, plus the part B28.fs-s3 (what the B28.fs ones still prove there). */
export function fixturesOnS3(list: readonly (BehaviourFixture | FixtureExtension)[]): readonly (BehaviourFixture | FixtureExtension)[] {
  const extra = b28OnS3(list);
  const kept = list.map((f) => ({
    ...f,
    parts: f.parts.map((p) => {
      const drop = NOT_ON_S3[`${f.id}.${p.name}`];
      return drop ? { ...p, cases: p.cases.filter((c) => !Object.hasOwn(drop, c.name)) } : p;
    }),
  }));
  return [...kept, extension('B28', [{ name: 'fs-s3', facets: ['engine', 'host', 'fs'], lanes: ['L7'], note: 'L7 only: B28.fs cases adapted to fsS3 (RFC L7-1 (d)).', cases: extra }])];
}

/** A pending test per case of NOT_ON_S3 in `parts`, titled with the reason, so the runs never drop them silently. */
export function pendingOnS3(parts: readonly string[]): void {
  describe('cases that do not hold on S3 (provider reasons, RFC L7-1 (d))', () => {
    for (const part of parts) for (const [name, why] of Object.entries(NOT_ON_S3[part] ?? {})) it(`${part} ${name}: ${why}`);
  });
}

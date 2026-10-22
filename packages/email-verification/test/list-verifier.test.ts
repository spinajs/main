import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { EmailVerificationStore } from '../src/contracts.js';
import { MemoryEmailVerificationStore } from '../src/stores/memory.js';
import { ListVerifier } from '../src/verifiers/list.js';
import { boot, shutdown } from './support.js';

const TYPES = [EmailVerificationStore, MemoryEmailVerificationStore];
const verifier = () => boot(ListVerifier, { lists: { refreshSeconds: 1, sources: [] } }, TYPES);
const store = () => DI.resolve(MemoryEmailVerificationStore);

function failLoads(): () => void {
  const proto = MemoryEmailVerificationStore.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'loadLists')!;
  proto.loadLists = async () => {
    throw new Error('down');
  };
  return () => void Object.defineProperty(proto, 'loadLists', original);
}

describe('ListVerifier', () => {
  afterEach(shutdown);

  it('answers unknown for a domain on no list', async () => {
    expect(await (await verifier()).verify('x.com')).to.deep.eq({ result: 'unknown' });
  });

  it('refuses a blocked domain and its subdomains, naming the source', async () => {
    const v = await verifier();
    await (await store()).upsertEntries([{ domain: 'mailinator.com', kind: 'block', source: 'admin' }]);
    await v.reload();
    expect(await v.verify('x.mailinator.com')).to.deep.eq({ result: 'refuse', reason: 'listed', source: 'list:admin' });
  });

  it('lets an allow entry win over a block entry', async () => {
    const v = await verifier();
    const s = await store();
    await s.replaceSource('sync', 'block', ['x.foo.com']);
    await s.upsertEntries([{ domain: 'foo.com', kind: 'allow', source: 'admin' }]);
    await v.reload();
    expect(await v.verify('x.foo.com')).to.deep.eq({ result: 'allow', source: 'list:admin' });
  });

  it('reloads on refresh only when the list version moved', async () => {
    const v = await verifier();
    const s = await store();
    let loads = 0;
    const load = s.loadLists.bind(s);
    s.loadLists = async () => {
      loads++;
      return load();
    };
    await v.refresh();
    expect(loads).to.eq(0);
    await s.upsertEntries([{ domain: 'new.com', kind: 'block', source: 'admin' }]);
    await v.refresh();
    expect(loads).to.eq(1);
    expect((await v.verify('new.com')).result).to.eq('refuse');
  });

  it('matches block-mx hosts by label suffix', async () => {
    const v = await verifier();
    await (await store()).upsertEntries([{ domain: 'mx.trash.io', kind: 'block-mx', source: 'admin' }]);
    await v.reload();
    expect(v.match('block-mx', 'a.mx.trash.io')).to.eq('admin');
    expect(v.match('block-mx', 'mx.trash.io.evil.com')).to.eq(undefined);
  });

  it('starts empty when the store cannot load the lists', async () => {
    const restore = failLoads();
    try {
      expect((await (await verifier()).verify('x.com')).result).to.eq('unknown');
    } finally {
      restore();
    }
  });

  it('recovers on a later refresh after a failed first load', async () => {
    const restore = failLoads();
    let v: ListVerifier;
    try {
      v = await verifier();
    } finally {
      restore();
    }
    await (await store()).upsertEntries([{ domain: 'later.com', kind: 'block', source: 'admin' }]);
    await v.refresh();
    expect((await v.verify('later.com')).result).to.eq('refuse');
  });

  it('keeps the newest snapshot when reloads overlap', async () => {
    const v = await verifier();
    const s = await store();
    const load = s.loadLists.bind(s);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    let started!: () => void;
    const slowStarted = new Promise<void>((resolve) => (started = resolve));
    s.loadLists = async () => {
      const entries = await load();
      if (first) {
        first = false;
        started();
        await gate;
      }
      return entries;
    };
    try {
      const slow = v.reload();
      await slowStarted;
      await s.upsertEntries([{ domain: 'late.com', kind: 'block', source: 'admin' }]);
      await v.reload();
      release();
      await slow;
      expect((await v.verify('late.com')).result).to.eq('refuse');
    } finally {
      release();
      s.loadLists = load;
    }
  });

  it('installs an older good reload when a newer one fails', async () => {
    const v = await verifier();
    const s = await store();
    await s.upsertEntries([{ domain: 'old.com', kind: 'block', source: 'admin' }]);
    const load = s.loadLists.bind(s);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    let started!: () => void;
    const slowStarted = new Promise<void>((resolve) => (started = resolve));
    s.loadLists = async () => {
      if (++calls === 1) {
        const entries = await load();
        started();
        await gate;
        return entries;
      }
      throw new Error('down');
    };
    try {
      const slow = v.reload();
      await slowStarted;
      await v.reload().catch(() => undefined);
      release();
      await slow;
      expect((await v.verify('old.com')).result).to.eq('refuse');
    } finally {
      release();
      s.loadLists = load;
    }
  });

  it('prefers the admin source when two sources list one domain', async () => {
    const v = await verifier();
    const s = await store();
    await s.replaceSource('sync', 'block', ['dup.com']);
    await s.upsertEntries([{ domain: 'dup.com', kind: 'block', source: 'admin' }]);
    await v.reload();
    expect(await v.verify('dup.com')).to.deep.eq({ result: 'refuse', reason: 'listed', source: 'list:admin' });
  });

  it('is never cached', async () => {
    const v = await verifier();
    expect(v.cacheable).to.eq(false);
    expect(v.ttlFor()).to.eq(0);
  });
});

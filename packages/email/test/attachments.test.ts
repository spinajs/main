import 'mocha';
import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { FsBootsrapper } from '@spinajs/fs';
import { jobOptions } from '@spinajs/queue';

import { BlackHoleEmailSender, EmailSend, IEmail } from '../src/index.js';
import { capturingEmailService, recordPerf, recordingLog } from './capture.js';

chai.use(chaiAsPromised);

const PROVIDER_FACTORY = '__file_provider__';
const PROVIDER_MAP = '__file_provider_instance__';

interface FakeFs {
  readonly Name: string;
  download(path: string): Promise<string>;
}

/** Shared by every fake filesystem of a test, in call order. */
const events: string[] = [];

function fakeFs(name: string, download?: (path: string) => Promise<string>): FakeFs {
  return {
    Name: name,
    async download(path: string) {
      events.push(`read ${name}:${path}`);
      return download ? download(path) : `/local/${name}/${path}`;
    },
  };
}

/**
 * Publishes fake filesystems where `getFs` looks them up, as fsService does with real ones. Undoes only what it added:
 * the provider names, the map when it created it, and the factory registration when it made it.
 */
function fakeFilesystems() {
  const names: string[] = [];
  let ownsFactory = false;
  let ownsMap = false;

  before(() => {
    const root = DI.RootContainer;
    if (!root.hasRegistered(PROVIDER_FACTORY)) {
      new FsBootsrapper().bootstrap();
      ownsFactory = true;
    }
    ownsMap = !root.Cache.has(PROVIDER_MAP);
  });

  afterEach(() => {
    const map = DI.RootContainer.Cache.has(PROVIDER_MAP) ? (DI.get(PROVIDER_MAP) as Map<string, unknown>) : undefined;
    for (const name of names.splice(0)) map?.delete(name);
    events.length = 0;
  });

  after(() => {
    const root = DI.RootContainer;
    if (ownsMap) root.uncache(PROVIDER_MAP);
    // Registry.unregister matches by name, which every arrow factory shares; drop the key the bootstrapper created.
    if (ownsFactory) (root.Registry as unknown as { registry: Map<string, unknown[]> }).registry.delete(PROVIDER_FACTORY);
  });

  return (...list: FakeFs[]) => {
    for (const f of list) {
      DI.register(f).asMapValue(PROVIDER_MAP, f.Name);
      names.push(f.Name);
    }
  };
}

class AccessDeniedLike extends Error {
  public readonly decision = { allowed: false, reason: { code: 'no-permit' } };
}

function serviceWith(check: boolean, defaultProvider = 'uploads') {
  const parts = capturingEmailService();
  Object.defineProperty(parts.service, 'CheckAttachments', { value: check, configurable: true });
  Object.defineProperty(parts.service, 'DefaultFileProvider', { value: defaultProvider, configurable: true });
  const send = parts.sender.send.bind(parts.sender);
  parts.sender.send = async (email: IEmail) => {
    events.push('send');
    return send(email);
  };
  return parts;
}

const mailWith = (...attachements: NonNullable<IEmail['attachements']>): IEmail => ({ to: ['client@acme.com'], connection: 'test', subject: 'Your invoice', attachements });

describe('DefaultEmailService attachments', () => {
  recordPerf();
  const publish = fakeFilesystems();

  it('reads every attachment through its filesystem before the transport and hands it the local file', async () => {
    publish(fakeFs('uploads'), fakeFs('archive'));
    const { service, sender } = serviceWith(true);
    const mail = mailWith({ name: 'a.txt', path: 'docs/a.txt', provider: 'uploads' }, { name: 'b.txt', path: 'docs/b.txt', provider: 'archive', cid: 'img' });

    await service.send(mail);

    expect(events).to.deep.equal(['read uploads:docs/a.txt', 'read archive:docs/b.txt', 'send']);
    expect(sender.Captured[0].attachements).to.deep.equal([
      { name: 'a.txt', path: 'docs/a.txt', provider: 'uploads', file: '/local/uploads/docs/a.txt' },
      { name: 'b.txt', path: 'docs/b.txt', provider: 'archive', cid: 'img', file: '/local/archive/docs/b.txt' },
    ]);
  });

  it('does not change the mail the caller passed', async () => {
    publish(fakeFs('uploads'));
    const { service, sender } = serviceWith(true);
    const mail = mailWith({ name: 'a.txt', path: 'docs/a.txt', provider: 'uploads' });
    const attachements = mail.attachements;

    await service.send(mail);

    expect(sender.Captured[0]).to.not.equal(mail);
    expect(mail.attachements).to.equal(attachements);
    expect(mail.attachements).to.deep.equal([{ name: 'a.txt', path: 'docs/a.txt', provider: 'uploads' }]);
  });

  it('reads an attachment without a provider from fs.defaultProvider', async () => {
    publish(fakeFs('uploads'));
    const { service, sender } = serviceWith(true, 'uploads');

    await service.send(mailWith({ name: 'a.txt', path: 'docs/a.txt' }));

    expect(events).to.deep.equal(['read uploads:docs/a.txt', 'send']);
    expect(sender.Captured[0].attachements![0].file).to.equal('/local/uploads/docs/a.txt');
  });

  it('reads the attachment even when the caller set file', async () => {
    publish(fakeFs('uploads'));
    const { service, sender } = serviceWith(true);

    await service.send(mailWith({ name: 'a.txt', path: 'docs/a.txt', provider: 'uploads', file: '/etc/passwd' }));

    expect(events).to.deep.equal(['read uploads:docs/a.txt', 'send']);
    expect(sender.Captured[0].attachements![0].file).to.equal('/local/uploads/docs/a.txt');
  });

  it('a denied read stops the send and rethrows the same error, logged once and counted', async () => {
    const denied = new AccessDeniedLike('fs:read denied on uploads:docs/b.txt');
    publish(
      fakeFs('uploads', async (path) => {
        if (path === 'docs/b.txt') throw denied;
        return `/local/uploads/${path}`;
      }),
    );
    const { service, sender, logged, emitted, perf } = serviceWith(true);
    // A mail with secret values still gets the original error: attachment errors hold paths, not the secrets.
    const mail = { ...mailWith({ name: 'a.txt', path: 'docs/a.txt', provider: 'uploads' }, { name: 'b.txt', path: 'docs/b.txt', provider: 'uploads' }), redact: ['secret'] };

    const caught = await service.send(mail).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(caught).to.equal(denied);
    expect(sender.Captured).to.have.length(0);
    expect(events).to.not.include('send');
    expect(emitted).to.have.length(0);
    expect(logged.filter((c) => c[0] === 'error')).to.have.length(1);
    expect(perf.filter((m) => m.name === 'email.send.failed' && m.kind === 'counter')).to.have.length(1);
    expect(perf.some((m) => m.name === 'email.sent')).to.equal(false);
  });

  it('an unknown filesystem fails with IOFail and sends nothing', async () => {
    const { service, sender } = serviceWith(true);

    await expect(service.send(mailWith({ name: 'a.txt', path: 'docs/a.txt', provider: 'missing' }))).to.be.rejectedWith(IOFail);
    expect(sender.Captured).to.have.length(0);
  });

  it('with email.attachments.check off leaves the attachments to the transport', async () => {
    publish(fakeFs('uploads'));
    const { service, sender } = serviceWith(false);
    const mail = mailWith({ name: 'a.txt', path: 'docs/a.txt', provider: 'uploads', file: '/etc/passwd' });

    await service.send(mail);

    expect(events).to.deep.equal(['send']);
    expect(sender.Captured[0].attachements).to.deep.equal([{ name: 'a.txt', path: 'docs/a.txt', provider: 'uploads' }]);
    expect(mail.attachements![0].file).to.equal('/etc/passwd');
  });
});

describe('BlackHoleEmailSender attachments', () => {
  const publish = fakeFilesystems();

  function blackHole() {
    const sender = new BlackHoleEmailSender({ name: 'test', service: 'BlackHoleEmailSender' });
    Object.defineProperty(sender, 'Log', { value: recordingLog().log, configurable: true });
    Object.defineProperty(sender, 'DefaultFileProvider', { value: 'uploads', configurable: true });
    return sender;
  }

  it('reads each attachment without file through its filesystem', async () => {
    publish(fakeFs('uploads'), fakeFs('archive'));

    await blackHole().send(mailWith({ name: 'a.txt', path: 'docs/a.txt' }, { name: 'b.txt', path: 'docs/b.txt', provider: 'archive' }));

    expect(events).to.deep.equal(['read uploads:docs/a.txt', 'read archive:docs/b.txt']);
  });

  it('does not read an attachment that carries file', async () => {
    publish(fakeFs('uploads'));

    await blackHole().send(mailWith({ name: 'a.txt', path: 'docs/a.txt', provider: 'uploads', file: '/local/uploads/docs/a.txt' }));

    expect(events).to.deep.equal([]);
  });

  it('rejects with the error of a refused read', async () => {
    const denied = new AccessDeniedLike('denied');
    publish(fakeFs('uploads', () => Promise.reject(denied)));

    await expect(blackHole().send(mailWith({ name: 'a.txt', path: 'docs/a.txt' }))).to.be.rejectedWith(denied);
  });
});

describe('EmailSend', () => {
  it('runs as the principal that queued it', () => {
    expect(Reflect.getOwnMetadata('queue:options', EmailSend)).to.include({ runAs: 'initiator', type: 'job' });
    expect(jobOptions(new EmailSend())).to.deep.equal({ runAs: 'initiator' });
  });
});

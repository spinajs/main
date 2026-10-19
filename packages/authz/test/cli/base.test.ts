import * as chai from 'chai';
import 'mocha';

import { AuthzAdminFailure, SYSTEM, currentPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { AuthzCliBase, describeCliError } from '@spinajs/authz/cli';

const expect = chai.expect;

class Probe extends AuthzCliBase {
  public lines: string[] = [];
  public errors: string[] = [];
  public prepared = 0;
  public prepareError?: Error;

  public async execute(): Promise<void> {}

  public run<T>(parse: () => T, body: (parsed: T) => Promise<void>): Promise<void> {
    return this.command(parse, body);
  }

  protected out(line = ''): void {
    this.lines.push(line);
  }

  protected fail(message: string): void {
    this.errors.push(message);
  }

  protected async prepare(): Promise<void> {
    this.prepared++;
    if (this.prepareError) throw this.prepareError;
  }
}

describe('AuthzCliBase', () => {
  it('parses, then runs the body as SYSTEM', async () => {
    const cmd = new Probe();
    let seen: Principal | undefined;
    await cmd.run(
      () => 7,
      async (n) => {
        seen = currentPrincipal();
        expect(n).to.equal(7);
      },
    );
    expect(seen).to.equal(SYSTEM);
    expect(cmd.prepared).to.equal(1);
    expect(cmd.errors).to.deep.equal([]);
  });

  it('a parse error becomes one message and the body never runs', async () => {
    const cmd = new Probe();
    let ran = false;
    await cmd.run(
      () => {
        throw new Error('bad subject');
      },
      async () => {
        ran = true;
      },
    );
    expect(ran).to.equal(false);
    expect(cmd.errors).to.deep.equal(['bad subject']);
  });

  it('a prepare error is reported like a parse error', async () => {
    const cmd = new Probe();
    cmd.prepareError = new Error('no ORM');
    const parsed: unknown[] = [];
    await cmd.run(
      () => parsed.push(1),
      async () => undefined,
    );
    expect(parsed).to.deep.equal([]);
    expect(cmd.errors).to.deep.equal(['no ORM']);
  });

  it('a body error becomes one message', async () => {
    const cmd = new Probe();
    await cmd.run(
      () => undefined,
      async () => {
        throw new AuthzAdminFailure('unknown_role', 'role "x" does not exist', 'role');
      },
    );
    expect(cmd.errors).to.deep.equal(['role "x" does not exist (unknown_role, role)']);
  });

  it('describeCliError names the code and field of an AuthzAdminFailure', () => {
    expect(describeCliError(new AuthzAdminFailure('conflict', 'taken'))).to.equal('taken (conflict)');
    expect(describeCliError(new Error('boom'))).to.equal('boom');
    expect(describeCliError('plain')).to.equal('plain');
  });
});

import { SYSTEM } from '@spinajs/authz';
import type { Assignment, AuthzCommand, AuthzService, Principal } from '@spinajs/authz';

import type { AuthzCliCommand } from '../../src/cli/index.js';

export interface Call {
  readonly method: string;
  readonly actor: Principal;
  readonly args: readonly unknown[];
  readonly insideRunAs: boolean;
}

/** A recording AuthzService and AuthzAdmin pair; `insideRunAs` tells whether the call came from the runAs body. */
export function fakeAuthz(opts: { decision?: unknown; commandResult?: unknown } = {}) {
  const calls: Call[] = [];
  const runAs: Array<{ principal: Principal; reason: string }> = [];
  let inside = false;

  const record = (method: string, actor: Principal, ...args: unknown[]) => calls.push({ method, actor, args, insideRunAs: inside });

  const admin = {
    assign: async (actor: Principal, a: Record<string, unknown>, opts?: unknown) => {
      record('assign', actor, a, opts);
      return { id: 'asg-1', ...a } as unknown as Assignment;
    },
    revoke: async (actor: Principal, id: string, opts?: unknown) => record('revoke', actor, id, opts),
    execute: async (actor: Principal, commands: readonly AuthzCommand[], o?: unknown) => {
      record('execute', actor, commands, o);
      if (opts.commandResult === 'none') return [];
      return [opts.commandResult ?? { ok: true, kind: commands[0].kind, affected: 3 }];
    },
  };

  const service = {
    runAs: async (principal: Principal, reason: string, fn: () => Promise<unknown>) => {
      runAs.push({ principal, reason });
      inside = true;
      try {
        return await fn();
      } finally {
        inside = false;
      }
    },
    admin: () => admin,
    explain: async (req: unknown) => {
      record('explain', SYSTEM, req);
      return opts.decision;
    },
  } as unknown as AuthzService;

  return { service, admin, calls, runAs };
}

export interface Captured {
  readonly out: string[];
  readonly err: string[];
  readonly exitCode: () => number | undefined;
  restore(): void;
}

/** Captures console output and process.exitCode of a command run. */
export function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));

  return {
    out,
    err,
    exitCode: () => process.exitCode as number | undefined,
    restore: () => {
      console.log = log;
      console.error = error;
      process.exitCode = exitCode;
    },
  };
}

export function withAuthz<T extends AuthzCliCommand>(command: T, service: AuthzService): T {
  command.Authz = service;
  return command;
}

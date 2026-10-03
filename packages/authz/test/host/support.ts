import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AuthzService } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';

type Path = string | readonly string[];

const segments = (path: Path): string[] => (Array.isArray(path) ? [...path] : (path as string).split('.').filter((s) => s !== ''));

// The kit owns the DI root state (install, root registrations), which hostHarness shares.
export const { config, installHost, uninstallHost, resetHost, rootDomains, domains, disposeDomains, resetRoot, registerInRoot, instance } = testHost;

export const setConfig = (path: Path, value: unknown): void => config().set(segments(path), value);
export const clearConfig = (path: Path): void => config().unset(path);
export const resetConfig = (): void => config().reset();

export async function rootService(): Promise<AuthzService> {
  return DI.resolve(AuthzService);
}

export type { IContainer };

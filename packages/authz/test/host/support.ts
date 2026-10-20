import * as chai from 'chai';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';

import { AUTHZ_CONFIGURATION_SCHEMA, AuthzService } from '@spinajs/authz';
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

/**
 * A Configuration of `values` alone, without file sources, so the schemas see exactly these values. testHost's
 * TestConfiguration never validates, so a test of the schema or its defaults boots one of these in a child container.
 */
export function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class AuthzTestConfiguration extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

/** Registers the authz schema and a Configuration of `values` in `container`; the schema applies when that Configuration resolves. */
export function registerConfiguration(container: IContainer, values: Record<string, unknown>): void {
  container.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  container.register(configurationOf(values)).as(Configuration);
}

/** A child of root with its own resolved Configuration of `values`; the caller disposes the child. */
export async function childWith(values: Record<string, unknown>): Promise<{ child: IContainer; configuration: Configuration }> {
  const child = DI.RootContainer.child();
  try {
    registerConfiguration(child, values);
    return { child, configuration: (await child.resolve(Configuration)) as Configuration };
  } catch (e) {
    await child.dispose();
    throw e;
  }
}

/** The violation paths of the InvalidConfiguration `p` rejects with, itself or as the cause of an authz boot error. */
export async function violationPaths(p: Promise<unknown>): Promise<string[]> {
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  const invalid = error instanceof InvalidConfiguration ? error : (error as { cause?: unknown } | undefined)?.cause;
  chai.expect(invalid, `the configuration is refused (got ${String(error)})`).to.be.instanceOf(InvalidConfiguration);
  return (invalid as InvalidConfiguration).violations.map((v) => v.path);
}

/** The violation paths the authz schema reports for `values`, from a child Configuration that fails to boot. */
export async function violationsOf(values: Record<string, unknown>): Promise<string[]> {
  const child = DI.RootContainer.child();
  try {
    registerConfiguration(child, values);
    return await violationPaths(Promise.resolve().then(() => child.resolve(Configuration)));
  } finally {
    await child.dispose();
  }
}

export type { IContainer };

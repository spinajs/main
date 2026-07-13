import { FrameworkConfiguration } from "@spinajs/configuration";
import { DI } from "@spinajs/di";
import { fs } from "@spinajs/fs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ILogArchiveContext } from "../../src/archive/index.js";
import { LOG_FILE_DEFAULTS } from "../../src/config/log.js";
import type { IFileTargetOptions } from "@spinajs/log-common";

/**
 * Builds a FrameworkConfiguration that registers two real local fs providers
 * ( `active` + `archive` ) rooted at the given base dirs. Used to exercise the
 * archive subsystem against a REAL local fs.
 */
export function makeConfig(activeBase: string, archiveBase: string, activeName: string, archiveName: string) {
  return class extends FrameworkConfiguration {
    protected onLoad() {
      return {
        logger: {
          targets: [{ name: "Empty", type: "BlackHoleTarget" }],
          rules: [{ name: "*", level: "trace", target: "Empty" }],
        },
        fs: {
          defaultProvider: activeName,
          providers: [
            { service: "fsNative", name: activeName, basePath: activeBase },
            { service: "fsNative", name: archiveName, basePath: archiveBase },
          ],
        },
      };
    }
  };
}

/**
 * Creates a unique temp workspace with `logs` + `archive` subdirs. Returns the
 * base paths and a cleanup fn.
 */
export function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "spinajs-log-archive-"));
  const activeBase = join(root, "logs");
  const archiveBase = join(root, "archive");

  return {
    root,
    activeBase,
    archiveBase,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Default target options for tests, overridable per case.
 */
export function makeOptions(overrides: Partial<IFileTargetOptions["options"]> = {}): IFileTargetOptions["options"] {
  // start from the same canonical defaults the package ships ( logger.file ),
  // so tests exercise the real default values from a single source
  return {
    ...LOG_FILE_DEFAULTS,
    path: "app.log",
    archivePath: "",
    rotate: "",
    ...overrides,
  } as IFileTargetOptions["options"];
}

/**
 * Builds a context wired to the two registered providers with a trivial
 * write-lock ( serial promise chain ). `rotate` is injected by the caller so a
 * test can point it at the service or a spy.
 */
export function makeContext(opts: {
  activeFs: fs;
  archiveFs: fs;
  activePath: string;
  archiveDir: string;
  options: IFileTargetOptions["options"];
  rotate: () => Promise<void>;
}): ILogArchiveContext {
  let lock: Promise<unknown> = Promise.resolve();

  return {
    fs: opts.activeFs,
    archiveFs: opts.archiveFs,
    activePath: opts.activePath,
    archiveDir: opts.archiveDir,
    options: opts.options,
    // minimal Log stand-in - archive code only calls trace/warn
    logger: {
      trace: () => {},
      warn: () => {},
      info: () => {},
      error: () => {},
    } as any,
    rotate: opts.rotate,
    withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = lock.then(() => fn());
      lock = run.catch(() => {});
      return run;
    },
  };
}

export async function resolveFs(name: string): Promise<fs> {
  return DI.resolve<fs>("__file_provider__", [name]);
}

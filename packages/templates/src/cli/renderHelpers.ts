import { DI } from '@spinajs/di';
import * as fs from 'fs';
import * as path from 'path';
import { Templates } from '../index.js';
import { IRenderProgress, RenderPhase, RenderProgressCallback } from '../progress.js';

/** Ensure the parent directory of `filePath` exists, creating it recursively if needed. */
export function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Load an optional JSON model file, returning an empty object when no readable file is given. */
export function loadJsonModel(modelPath?: string): Record<string, unknown> {
  if (modelPath && fs.existsSync(modelPath)) {
    return JSON.parse(fs.readFileSync(modelPath, { encoding: 'utf-8' }));
  }

  return {};
}

export interface IResolveHtmlOptions {
  template?: boolean;
  model?: string;
  lang?: string;
}

/**
 * Resolve the HTML for a CLI render. In template mode the input is rendered
 * through the text engine selected by its file extension (pug/handlebars/...);
 * in raw mode the input file is read as-is.
 */
export async function resolveInputHtml(input: string, options: IResolveHtmlOptions): Promise<string> {
  if (options.template) {
    const templates = await DI.resolve(Templates);
    return templates.render(input, loadJsonModel(options.model), options.lang);
  }

  if (!fs.existsSync(input)) {
    throw new Error(`Input HTML file ${input} does not exist`);
  }

  return fs.readFileSync(input, { encoding: 'utf-8' });
}

const PROGRESS_BAR_WIDTH = 20;

function progressBar(percent: number): string {
  const filled = Math.max(0, Math.min(PROGRESS_BAR_WIDTH, Math.round((percent / 100) * PROGRESS_BAR_WIDTH)));
  return '█'.repeat(filled) + '·'.repeat(PROGRESS_BAR_WIDTH - filled);
}

/** Format one progress snapshot as a compact single line. */
export function formatProgressLine(p: IRenderProgress): string {
  const secs = (p.elapsedMs / 1000).toFixed(1);
  return `[${progressBar(p.percent)}] ${String(p.percent).padStart(3)}% ${p.phase.padEnd(9)} ${p.message ?? ''} ${secs}s`;
}

/**
 * A progress callback for one-shot CLI commands. On a TTY it rewrites a single
 * live line; otherwise (piped / CI) it prints one line per phase change. The
 * live line is terminated with a newline on Done/Failed.
 *
 * @param write - sink for output (defaults to stdout); injectable for testing.
 * @param isTty - whether to use the live single-line mode (defaults to stdout's TTY state).
 */
export function cliProgressReporter(
  write: (s: string) => void = (s) => void process.stdout.write(s),
  isTty: boolean = !!process.stdout.isTTY,
): RenderProgressCallback {
  let lastPhase: RenderPhase | undefined;

  return (p: IRenderProgress) => {
    const line = formatProgressLine(p);
    const finished = p.phase === RenderPhase.Done || p.phase === RenderPhase.Failed;

    if (isTty) {
      write(`\r${line.padEnd(80)}`);
      if (finished) {
        write('\n');
      }
    } else if (p.phase !== lastPhase) {
      lastPhase = p.phase;
      write(`${line}\n`);
    }
  };
}

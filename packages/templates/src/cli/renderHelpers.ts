import { DI } from '@spinajs/di';
import * as fs from 'fs';
import * as path from 'path';
import { Templates } from '../index.js';

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

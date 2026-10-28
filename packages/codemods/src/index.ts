import type { Project, SourceFile } from 'ts-morph';
import { libMjsImports } from './transforms/lib-mjs-imports.js';
import { esmModuleSupport } from './transforms/esm-module-support.js';
import { problemJsonNote } from './transforms/problem-json-note.js';

export interface Transform {
  name: string;
  description: string;
  /** returns true when it changed the file */
  apply(project: Project, file: SourceFile): boolean;
}

export const V4_TRANSFORMS: Transform[] = [libMjsImports, esmModuleSupport, problemJsonNote];

export * from './run.js';

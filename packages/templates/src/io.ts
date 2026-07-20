import * as fs from 'fs';
import * as path from 'path';

/** Ensure the parent directory of `filePath` exists, creating it recursively if needed. */
export function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

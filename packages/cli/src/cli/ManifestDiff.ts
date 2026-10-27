import { diffManifest, readManifest, renderMarkdown } from '@spinajs/manifest';
import { CliCommand, Command, Option } from '../index.js';

interface ManifestDiffOptions {
  format?: 'markdown' | 'json';
  failOn?: 'breaking';
}

@Command('manifest:diff <base> <head>', 'Compares two application manifests and classifies breaking changes')
@Option({ flags: '--format <format>', description: 'output format', defaultValue: 'markdown', choices: ['markdown', 'json'] })
@Option({ flags: '--fail-on <level>', description: 'exit with code 1 when the diff reaches this level', choices: ['breaking'] })
export class ManifestDiff extends CliCommand {
  protected write(text: string): void {
    process.stdout.write(text);
  }

  public async execute(base: string, head: string, options: ManifestDiffOptions): Promise<void> {
    const diff = diffManifest(await readManifest(base), await readManifest(head));

    this.write(options.format === 'json' ? `${JSON.stringify(diff, null, 2)}\n` : renderMarkdown(diff));
    if (options.failOn === 'breaking' && diff.breaking) process.exitCode = 1;
  }
}

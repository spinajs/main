/**
 * Framework options eg. to set current app or env.
 * They are consumed directly from process.argv by the configuration
 * module, so they are stripped before argv is handed to commander
 * (otherwise commander treats them as unknown options).
 */
const SPINAJS_ARGV_OPTIONS = ['--app', '--env', '--apppath'];

export function stripFrameworkOptions(argv: string[]): string[] {
  const result: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // `--app=foo` style: single token, just drop it
    if (SPINAJS_ARGV_OPTIONS.some((o) => arg.startsWith(`${o}=`))) {
      continue;
    }

    // `--app foo` style: drop the option and its following value (if present)
    if (SPINAJS_ARGV_OPTIONS.includes(arg)) {
      i++;
      continue;
    }

    result.push(arg);
  }

  return result;
}

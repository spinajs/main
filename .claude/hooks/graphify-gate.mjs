// Enforces the CLAUDE.md graphify rule for every agent: while graphify-out/graph.json exists, a code
// search (Grep tool, or grep/rg/findstr/Select-String/git grep not fed by a pipe) is refused until the
// most recent `graphify query|explain|path` of the same agent found nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const stateDir = path.join(os.tmpdir(), 'claude-graphify-gate');
const stateFile = path.join(stateDir, `${input.session_id ?? 'none'}-${input.agent_id ?? 'main'}.json`);

const GRAPHIFY = /\bgraphify(?:\.exe)?\s+(query|explain|path)\b/i;
const EMPTY = /No matching nodes found|No node matching '/;

function graphExists(from) {
  for (let dir = path.resolve(from ?? process.cwd()); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'graphify-out', 'graph.json'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { lastEmpty: false };
  }
}

/** A search reads files itself; a grep that only filters another command's output (after a pipe) does not. */
function searchesFiles(raw) {
  // Quoted text (commit messages, echo arguments) is data, not a command.
  const command = raw.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""');
  if (/(?:^|[;&|(\n]\s*)git\s+grep\b/i.test(command)) return true;
  for (const pipeline of command.split(/&&|\|\||;|\n/)) {
    const [first] = pipeline.split(/(?<!\|)\|(?!\|)/);
    if (/^\s*(?:\S+[\\/])?(?:grep|egrep|fgrep|rg|findstr|Select-String|sls)(?:\.exe)?\b/i.test(first)) return true;
  }
  return false;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

if (mode === 'post') {
  const command = String(input.tool_input?.command ?? '');
  if (GRAPHIFY.test(command)) {
    fs.mkdirSync(stateDir, { recursive: true });
    // graphify exits non-zero when nothing matches, so the result arrives as a failure (PostToolUseFailure).
    const output = JSON.stringify({ response: input.tool_response, error: input.error });
    fs.writeFileSync(stateFile, JSON.stringify({ lastEmpty: EMPTY.test(output) }));
  }
} else if (mode === 'pre') {
  const isGrepTool = input.tool_name === 'Grep';
  const command = String(input.tool_input?.command ?? '');
  if ((isGrepTool || searchesFiles(command)) && graphExists(input.cwd) && !readState().lastEmpty) {
    deny(
      'graphify-out/graph.json exists: answer codebase questions with `graphify query "<question>"`, `graphify explain "<concept>"` or `graphify path "<A>" "<B>"` and read files only at the lines it locates. ' +
        'A text search is allowed only after your most recent graphify call found nothing ("No matching nodes found"). Filtering another command\'s output through a pipe (`cmd | grep x`) is not blocked.',
    );
  }
}

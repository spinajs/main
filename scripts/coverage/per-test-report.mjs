/**
 * Which tests run which source lines, from the files scripts/coverage/per-test-hook.cjs writes, mapped to
 * the .ts sources through the source maps node records in its own coverage files. Finds tests that run
 * exactly the lines of another test, tests whose lines another test of the package all runs, and tests
 * with no line of their own. Covering the same lines is not the same test: boundary-value tests walk one
 * path on purpose, so these are candidates to review.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join, relative } from 'path';
import { SourceMap } from 'module';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const LISTED = 30;

export function analyzePerTest(root, out) {
  const sourceMaps = loadSourceMaps(join(out, 'tmp'));
  const lineKeys = [];
  const lineIds = new Map();
  const mappers = new Map();
  const tests = [];

  const perTestDir = join(out, 'per-test');
  for (const file of existsSync(perTestDir) ? readdirSync(perTestDir) : []) {
    const data = JSON.parse(readFileSync(join(perTestDir, file), 'utf8'));
    const pkg = basename(data.cwd);
    const rangeLines = data.ranges.map(([url, start, end]) => linesOf(url, Number(start), Number(end)));
    for (const t of data.tests) {
      const ran = new Map();
      for (const id of t.seq) for (const line of rangeLines[Math.abs(id) - 1]) ran.set(line, id > 0);
      const lines = [...ran].filter(([, yes]) => yes).map(([line]) => line).sort((a, b) => a - b);
      tests.push({ pkg, name: `${t.title}${t.file ? ` ( ${t.file.replaceAll('\\', '/')} )` : ''}`, lines });
    }
  }

  const testsOfLine = new Map();
  tests.forEach((t, i) => t.lines.forEach((line) => listIn(testsOfLine, line).push(i)));

  const groups = new Map();
  for (const t of tests) {
    if (t.lines.length) listIn(groups, t.pkg + createHash('sha1').update(Int32Array.from(t.lines)).digest('hex')).push(t);
  }
  const duplicates = [...groups.values()].filter((g) => g.length > 1);

  const subsumed = [];
  for (const t of tests) {
    if (!t.lines.length) continue;
    const rarest = t.lines.reduce((a, b) => (testsOfLine.get(a).length <= testsOfLine.get(b).length ? a : b));
    const by = testsOfLine
      .get(rarest)
      .map((i) => tests[i])
      .find((o) => o !== t && o.pkg === t.pkg && o.lines.length > t.lines.length && isSubset(t.lines, o.lines));
    if (by) subsumed.push({ pkg: t.pkg, test: t.name, by: by.name, lines: t.lines.length });
  }

  const noUnique = tests.filter((t) => t.lines.length && t.lines.every((line) => testsOfLine.get(line).length > 1));
  const empty = tests.filter((t) => !t.lines.length);
  const hot = [...testsOfLine].sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(([line, of]) => ({ line: lineKeys[line], tests: of.length }));

  const report = {
    tests: tests.length,
    duplicates: duplicates.map((g) => ({ pkg: g[0].pkg, lines: g[0].lines.length, tests: g.map((t) => t.name) })),
    subsumed,
    noUniqueLine: noUnique.map((t) => ({ pkg: t.pkg, test: t.name })),
    noSourceLine: empty.map((t) => ({ pkg: t.pkg, test: t.name })),
    mostRunLines: hot,
  };
  return { report, markdown: markdown(report, tests) };

  function linesOf(url, start, end) {
    const map = mapperOf(url);
    if (!map) return [];
    const lines = [];
    let i = lowerBound(map.starts, start);
    for (; i < map.starts.length && map.starts[i] + map.lengths[i] <= end; i++) {
      if (map.lengths[i] === 0) continue;
      const key = map.original(i);
      if (key === undefined) continue;
      let id = lineIds.get(key);
      if (id === undefined) {
        lineIds.set(key, (id = lineKeys.length));
        lineKeys.push(key);
      }
      lines.push(id);
    }
    return lines;
  }

  function mapperOf(url) {
    if (mappers.has(url)) return mappers.get(url);
    let mapper;
    const cached = sourceMaps[url];
    if (cached) {
      const sm = new SourceMap(cached.data);
      mapper = {
        ...lineTable(cached.lineLengths),
        original(line) {
          const e = sm.findEntry(line, this.lengths[line]);
          if (e.generatedLine !== line || !e.originalSource) return undefined;
          const rel = sourcePath(e.originalSource);
          return rel && `${rel}:${e.originalLine + 1}`;
        },
      };
    } else if (url.startsWith('file:') && sourcePath(url)) {
      const rel = sourcePath(url);
      mapper = { ...lineTable(readFileSync(fileURLToPath(url), 'utf8').split(/\n/).map((l) => l.length)), original: (line) => `${rel}:${line + 1}` };
    }
    mappers.set(url, mapper);
    return mapper;
  }

  function sourcePath(source) {
    const rel = relative(root, source.startsWith('file:') ? fileURLToPath(source) : source).replaceAll('\\', '/');
    return /^packages\/[^/]+\/src\//.test(rel) ? rel : undefined;
  }
}

function loadSourceMaps(dir) {
  const maps = {};
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    if (file.startsWith('per-test-')) continue;
    Object.assign(maps, JSON.parse(readFileSync(join(dir, file), 'utf8'))['source-map-cache'] ?? {});
  }
  return maps;
}

// node's lineLengths leave the line breaks out, one character each.
function lineTable(lengths) {
  const starts = [];
  let offset = 0;
  for (const length of lengths) {
    starts.push(offset);
    offset += length + 1;
  }
  return { starts, lengths };
}

function listIn(map, key) {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  return list;
}

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isSubset(small, big) {
  let j = 0;
  for (const value of small) {
    while (j < big.length && big[j] < value) j++;
    if (big[j] !== value) return false;
  }
  return true;
}

function markdown(report, tests) {
  const byPackage = new Map();
  const row = (pkg) => byPackage.get(pkg) ?? byPackage.set(pkg, { tests: 0, duplicated: 0, subsumed: 0, noUnique: 0 }).get(pkg);
  tests.forEach((t) => row(t.pkg).tests++);
  report.duplicates.forEach((g) => (row(g.pkg).duplicated += g.tests.length - 1));
  report.subsumed.forEach((s) => row(s.pkg).subsumed++);
  report.noUniqueLine.forEach((s) => row(s.pkg).noUnique++);
  const flagged = [...byPackage].filter(([, r]) => r.duplicated || r.subsumed).sort(([, a], [, b]) => b.duplicated + b.subsumed - (a.duplicated + a.subsumed));
  const more = (list) => (list.length > LISTED ? [`- … ${list.length - LISTED} more in per-test-report.json`] : []);

  return [
    '## Test overlap',
    '',
    `${report.tests} tests recorded · **${report.duplicates.length} duplicate groups** ( ${report.duplicates.reduce((n, g) => n + g.tests.length - 1, 0)} redundant tests ) · ` +
      `${report.subsumed.length} subsumed by another test · ${report.noUniqueLine.length} with no line of their own · ${report.noSourceLine.length} run no source line`,
    '',
    '_Duplicate: runs exactly the lines another test of the package runs. Subsumed: another test of the package runs all its lines and more. Same lines is not the same test ( boundary values walk one path on purpose ): review, do not delete blindly._',
    '',
    '<details><summary>Per package</summary>',
    '',
    '| Package | Tests | Duplicates | Subsumed | No own line |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...flagged.map(([pkg, r]) => `| ${pkg} | ${r.tests} | ${r.duplicated} | ${r.subsumed} | ${r.noUnique} |`),
    '',
    '</details>',
    '',
    '<details><summary>Duplicate groups</summary>',
    '',
    ...report.duplicates.slice(0, LISTED).flatMap((g) => [`- \`${g.pkg}\`, ${g.lines} lines:`, ...g.tests.map((t) => `  - ${t}`)]),
    ...more(report.duplicates),
    '',
    '</details>',
    '',
    '<details><summary>Subsumed tests</summary>',
    '',
    ...report.subsumed.slice(0, LISTED).map((s) => `- \`${s.pkg}\` ${s.test}  \n  ⊂ ${s.by}`),
    ...more(report.subsumed),
    '',
    '</details>',
    '',
    '<details><summary>Lines run by the most tests</summary>',
    '',
    ...report.mostRunLines.map((h) => `- \`${h.line}\`: ${h.tests} tests`),
    '',
    '</details>',
  ].join('\n');
}

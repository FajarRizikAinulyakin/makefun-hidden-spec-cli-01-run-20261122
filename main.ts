// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a line break (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitLines(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

/** Every 0-based position where O occurs in the file's lines at one tier (occurrences may overlap). */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  for (let i = 0; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, 1, 2; only 0 when strict) with an occurrence of O at or after `from`,
 * and those occurrences; `eofOnly` keeps only occurrences ending at the file's last line.
 */
function findTier(
  file: string[],
  o: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; occs: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occs = occurrences(file, o, tier).filter((i) => i >= from && (!eofOnly || i + o.length === file.length));
    if (occs.length > 0) return { tier, occs };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a fresh line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/**
 * The lines N writes in place of the matched span: context lines are the file's own matched
 * lines; at tier 2 every other line is re-indented from O's first line to the file's first
 * matched line; at tiers 0 and 1 the lines are written as they are (SPEC.md section 5).
 */
function replacementLines(file: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  if (tier !== 2) return n.map((e) => (e.ctx !== null ? file[pos + e.ctx]! : e.text));
  const f = leadWs(file[pos]!);
  const p = leadWs(o[0]!);
  return n.map((e) => {
    if (e.ctx !== null) return file[pos + e.ctx]!;
    const t = e.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    return t.startsWith(p) ? f + t.slice(p.length) : t;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves applied, as [old, new] pairs, in the order the edits made them. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk's body line: context, old, new, or a `\` line. */
interface UBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
}

interface UHunk {
  a: number;
  body: UBodyLine[];
}

interface USection {
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitA: string | undefined;
  gitB: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path a `--- `/`+++ ` line names: after the four characters, up to the first tab, trimmed; null for /dev/null. */
function dashPath(line: string): string | null {
  const raw = line.slice(4).split('\t', 1)[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/')) return raw.slice(2);
  if (raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Split a hunk body into the old lines O and the new lines N (context lines marked with their O index). */
function splitBody(body: UBodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const l of body) {
    if (l.kind === 'ctx') {
      n.push({ text: l.text, ctx: o.length });
      o.push(l.text);
    } else if (l.kind === 'old') {
      o.push(l.text);
    } else if (l.kind === 'new') {
      n.push({ text: l.text, ctx: null });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line (SPEC.md section 6). */
function backslashAfterLast(body: UBodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === 'back';
}

/** Whether a `\` line follows the last `+` line of a creation's hunks. */
function backslashAfterLastPlus(hunks: UHunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h -= 1) {
    const body = hunks[h]!.body;
    for (let i = body.length - 1; i >= 0; i -= 1) {
      if (body[i]!.kind === 'new') return body[i + 1] !== undefined && body[i + 1]!.kind === 'back';
    }
  }
  return false;
}

/** Apply one section's hunks to a file's lines, in order (SPEC.md section 6). */
function applyHunks(f: FileLines, hunks: UHunk[], strict: boolean, path: string): FileLines {
  let lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = splitBody(hunk.body);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(hunk.a + d, lines.length));
      const rep = replacementLines(lines, at, o, n, 0);
      if (at === lines.length) final = !backslashAfterLast(hunk.body);
      lines = [...lines.slice(0, at), ...rep, ...lines.slice(at)];
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.occs[0]!;
    for (const pos of found.occs) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const rep = replacementLines(lines, best, o, n, found.tier);
    if (best + o.length === lines.length) final = !backslashAfterLast(hunk.body);
    lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
    d += n.length - o.length;
  }
  return { lines, br: f.br, final };
}

/** Parse a unified diff into its sections' edits (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const fresh = (): USection => ({
    dashOld: undefined,
    dashNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    gitA: undefined,
    gitB: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const git = GIT_RE.exec(line);
    if (line.startsWith('diff --git ')) {
      if (git === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitA = git[1]!;
      cur.gitB = git[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: UBodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') body.push({ kind: 'ctx', text: '' });
        else if (bl[0] === ' ') body.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl[0] === '-') body.push({ kind: 'old', text: bl.slice(1) });
        else if (bl[0] === '+') body.push({ kind: 'new', text: bl.slice(1) });
        else if (bl[0] === '\\') body.push({ kind: 'back', text: bl });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1]!);
      } else {
        cur = fresh();
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1]!);
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) cur.dashNew = dashPath(line);
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  return sections.map((s) => {
    const oldPath = s.dashOld !== undefined ? s.dashOld : s.renameFrom !== undefined ? s.renameFrom : s.gitA !== undefined ? s.gitA : null;
    const newPath = s.dashNew !== undefined ? s.dashNew : s.renameTo !== undefined ? s.renameTo : s.gitB !== undefined ? s.gitB : null;
    if (oldPath === null && newPath === null) return () => {};
    const isCreate = oldPath === null || s.newFile;
    const isDelete = !isCreate && (newPath === null || s.deletedFile);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;
    if (isCreate) {
      const np = newPath!;
      return (tree: Tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const made: string[] = [];
        for (const h of s.hunks) for (const l of h.body) if (l.kind === 'new') made.push(l.text);
        const fin = !backslashAfterLastPlus(s.hunks);
        tree.now.set(np, made.length === 0 ? '' : made.join('\n') + (fin ? '\n' : ''));
      };
    }
    if (isDelete) {
      const op = oldPath!;
      return (tree: Tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      };
    }
    if (isMove) {
      const op = oldPath!;
      const np = newPath!;
      return (tree: Tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const out = applyHunks(splitLines(before), s.hunks, strict, op);
        tree.now.set(np, joinLines(out));
        tree.now.set(op, null);
        tree.moves.push([op, np]);
      };
    }
    const p = oldPath!;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const out = applyHunks(splitLines(before), s.hunks, strict, p);
      tree.now.set(p, joinLines(out));
    };
  });
}

/** Parse SEARCH/REPLACE blocks into their edits (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);
    let sep = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    const oldLines = lines.slice(searchAt + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitLines(before);
      const found = findTier(f.lines, oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.occs.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occs[0]!;
      const rep = replacementLines(f.lines, pos, oldLines, newLines.map((t) => ({ text: t, ctx: null })), found.tier);
      f.lines.splice(pos, oldLines.length, ...rep);
      tree.now.set(p, joinLines(f));
    });
    prevEnd = end + 1;
    prevPath = p;
    i = end + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null: none), its body lines, and whether it is anchored to the end of the file. */
interface VChunk {
  anchor: string | null;
  body: UBodyLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** The section's lines with their 1-based patch line numbers, trailing blank lines removed. */
  lines: Array<{ text: string; no: number }>;
  chunks: VChunk[];
  lineNo: number;
}

const V_ADD = '*** Add File: ';
const V_DELETE = '*** Delete File: ';
const V_UPDATE = '*** Update File: ';
const V_MOVE = '*** Move to: ';

/** Parse a V4A patch into its sections' edits (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let prefix = '';
    if (line.startsWith(V_ADD)) {
      kind = 'add';
      prefix = V_ADD;
    } else if (line.startsWith(V_DELETE)) {
      kind = 'delete';
      prefix = V_DELETE;
    } else if (line.startsWith(V_UPDATE)) {
      kind = 'update';
      prefix = V_UPDATE;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const start = i;
    let j = i + 1;
    while (j < last && !lines[j]!.startsWith(V_ADD) && !lines[j]!.startsWith(V_DELETE) && !lines[j]!.startsWith(V_UPDATE)) j += 1;
    const raw: Array<{ text: string; no: number }> = [];
    for (let k = i + 1; k < j; k += 1) raw.push({ text: lines[k]!, no: k + 1 });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push({ kind, path: line.slice(prefix.length).trim(), moveTo: null, lines: raw, chunks: [], lineNo: start + 1 });
    i = j;
  }
  for (const s of sections) {
    if (s.kind === 'add') {
      for (const l of s.lines) {
        if (l.text !== '' && !l.text.startsWith('+')) throw new Exit2(`error: parse ${l.no}`);
      }
    } else if (s.kind === 'delete') {
      if (s.lines.length > 0) throw new Exit2(`error: parse ${s.lines[0]!.no}`);
    } else {
      let at = 0;
      if (at < s.lines.length && s.lines[at]!.text.startsWith(V_MOVE)) {
        s.moveTo = s.lines[at]!.text.slice(V_MOVE.length).trim();
        at += 1;
      }
      let cur: VChunk | null = null;
      for (; at < s.lines.length; at += 1) {
        const l = s.lines[at]!;
        if (l.text.startsWith('@@')) {
          cur = { anchor: l.text.slice(2).trim() === '' ? null : l.text.slice(2).trim(), body: [], eof: false };
          s.chunks.push(cur);
        } else if (l.text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${l.no}`);
          cur.eof = true;
          cur = null;
        } else if (l.text === '' || l.text[0] === ' ' || l.text[0] === '-' || l.text[0] === '+') {
          if (cur === null) {
            if (s.chunks.length > 0) throw new Exit2(`error: parse ${l.no}`);
            cur = { anchor: null, body: [], eof: false };
            s.chunks.push(cur);
          }
          if (l.text === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l.text[0] === ' ') cur.body.push({ kind: 'ctx', text: l.text.slice(1) });
          else if (l.text[0] === '-') cur.body.push({ kind: 'old', text: l.text.slice(1) });
          else cur.body.push({ kind: 'new', text: l.text.slice(1) });
        } else {
          throw new Exit2(`error: parse ${l.no}`);
        }
      }
      if (s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.lineNo}`);
    }
  }
  return sections.map((s) => {
    if (s.kind === 'add') {
      const p = s.path;
      const made = s.lines.map((l) => (l.text === '' ? '' : l.text.slice(1)));
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, made.length === 0 ? '' : made.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      const p = s.path;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = s.path;
    const np = s.moveTo;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (np !== null && !safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (np !== null && tree.get(np) !== null) throw new Fail('exists', np);
      const f = splitLines(before);
      let lines = f.lines;
      let cursor = 0;
      for (const chunk of s.chunks) {
        if (chunk.anchor !== null) {
          const anchor = chunk.anchor;
          let foundAt = -1;
          for (const tier of strict ? [0] : [0, 1, 2]) {
            for (let k = cursor; k < lines.length; k += 1) {
              if (lineEq(lines[k]!, anchor, tier)) {
                foundAt = k;
                break;
              }
            }
            if (foundAt >= 0) break;
          }
          if (foundAt < 0) throw new Fail('no-match', p);
          cursor = foundAt + 1;
        }
        const { o, n } = splitBody(chunk.body);
        if (o.length === 0) {
          const at = chunk.eof ? lines.length : cursor;
          const rep = n.map((e) => e.text);
          lines = [...lines.slice(0, at), ...rep, ...lines.slice(at)];
          cursor = at + rep.length;
          continue;
        }
        const found = findTier(lines, o, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.occs[0]!;
        const rep = replacementLines(lines, pos, o, n, found.tier);
        lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + o.length)];
        cursor = pos + rep.length;
      }
      const out = { lines, br: f.br, final: f.final };
      if (np !== null) {
        tree.now.set(np, joinLines(out));
        tree.now.set(p, null);
        tree.moves.push([p, np]);
      } else {
        tree.now.set(p, joinLines(out));
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const done = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      done.add(oldP);
      done.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!done.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

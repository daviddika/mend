// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements the whole of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
interface FileState {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Section 5, tier 2 re-indent: replace P (O's first line's leading whitespace) by F (the file's). */
function reindentLine(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions i >= from where O occurs in lines at the given tier. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const want = o.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at least once at or after `from`, with its positions. */
let strictOnly = false;

function findTier(lines: string[], o: string[], from: number): { tier: number; positions: number[] } | null {
  const maxTier = strictOnly ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions = occurrencesAt(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output lines (section 2). */
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

/** One body line of a hunk, chunk or block: context, removed, added, or a `\` marker. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'mark';
  text: string;
}

/** Whether a `\` line follows the body's last context or `+` line (section 6, no-newline rule). */
function bodyNoEol(body: BodyItem[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const it = body[i]!;
    if (it.kind === 'ctx' || it.kind === 'add') return body[i + 1] !== undefined && body[i + 1]!.kind === 'mark';
  }
  return false;
}

/** The old lines O of a body (context and `-` lines), in order. */
function oldLines(body: BodyItem[]): string[] {
  const out: string[] = [];
  for (const it of body) if (it.kind === 'ctx' || it.kind === 'del') out.push(it.text);
  return out;
}

/**
 * The lines that replace the matched lines: context lines are written as the file's own matched lines,
 * other lines of N are re-indented at tier 2 (section 5).
 */
function buildReplacement(body: BodyItem[], fileLines: string[], pos: number, tier: number): string[] {
  const o = oldLines(body);
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = leadingWs(fileLines[pos] ?? '');
  const out: string[] = [];
  let oIdx = 0;
  for (const it of body) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oIdx]!);
      oIdx++;
    } else if (it.kind === 'del') {
      oIdx++;
    } else if (it.kind === 'add') {
      out.push(tier === 2 ? reindentLine(it.text, p, f) : it.text);
    }
  }
  return out;
}

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

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface UnifiedHunk {
  /** A: the old start line (1-based) from `@@ -A[,B] +C[,D] @@`. */
  a: number;
  body: BodyItem[];
}

interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

/** The path of a `--- ` / `+++ ` header line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** Strip one leading `a/` or `b/` from a header path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | null = null;
  let inHeader = false;
  const newSection = (): UnifiedSection => {
    const s: UnifiedSection = {
      pairOld: null,
      pairNew: null,
      hasPair: false,
      renameFrom: null,
      renameTo: null,
      diffOld: null,
      diffNew: null,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      section = newSection();
      section.diffOld = m[1]!;
      section.diffNew = m[2]!;
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (section === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: BodyItem[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ') {
          body.push({ kind: 'ctx', text: bl.slice(1) });
          i++;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'del', text: bl.slice(1) });
          i++;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'add', text: bl.slice(1) });
          i++;
          continue;
        }
        if (c === '\\') {
          body.push({ kind: 'mark', text: bl.slice(1) });
          i++;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it (a blank patch line is an empty context line).
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && /^[ \t]*$/.test(last.text)) body.pop();
        else break;
      }
      section.hunks.push({ a, body });
      inHeader = false;
      continue;
    }
    if (section !== null && inHeader) {
      if (l.startsWith('--- ')) {
        const next = lines[i + 1];
        if (next === undefined || !next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        section.pairOld = stripAB(headerPath(l));
        section.pairNew = stripAB(headerPath(next));
        section.hasPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        section.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        section.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        section.isCreate = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        section.isDelete = true;
        i++;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored.
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      section = newSection();
      section.pairOld = stripAB(headerPath(l));
      section.pairNew = stripAB(headerPath(lines[i + 1]!));
      section.hasPair = true;
      inHeader = true;
      i += 2;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i++;
  }
  return sections;
}

function resolveUnifiedPaths(sec: UnifiedSection): { old: string | null; nw: string | null } {
  if (sec.hasPair) {
    return {
      old: sec.pairOld === '/dev/null' ? null : sec.pairOld,
      nw: sec.pairNew === '/dev/null' ? null : sec.pairNew,
    };
  }
  if (sec.renameFrom !== null || sec.renameTo !== null) return { old: sec.renameFrom, nw: sec.renameTo };
  if (sec.diffOld !== null) return { old: sec.diffOld, nw: sec.diffNew };
  return { old: null, nw: null };
}

/** Whether a `\` line follows the section's last `+` line (creation no-newline rule). */
function creationNoEol(hunks: UnifiedHunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi]!.body;
    for (let j = body.length - 1; j >= 0; j--) {
      if (body[j]!.kind === 'add') return body[j + 1] !== undefined && body[j + 1]!.kind === 'mark';
    }
  }
  return false;
}

/** Apply one hunk to a file; returns the new file and the hunk's line delta (N length minus O length). */
function applyUnifiedHunk(f: FileState, hunk: UnifiedHunk, d: number, path: string): { f: FileState; delta: number } {
  const o = oldLines(hunk.body);
  if (o.length === 0) {
    const n = hunk.body.filter((it) => it.kind === 'add').map((it) => it.text);
    let ins = hunk.a + d;
    if (ins < 0) ins = 0;
    if (ins > f.lines.length) ins = f.lines.length;
    const lines = [...f.lines.slice(0, ins), ...n, ...f.lines.slice(ins)];
    const finalBreak = ins === f.lines.length ? !bodyNoEol(hunk.body) : f.finalBreak;
    return { f: { br: f.br, lines, finalBreak }, delta: n.length };
  }
  const found = findTier(f.lines, o, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.positions[0]!;
  let bestDist = Math.abs(pos - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      pos = p;
      bestDist = dist;
    }
  }
  const repl = buildReplacement(hunk.body, f.lines, pos, found.tier);
  const lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + o.length)];
  const finalBreak = pos + o.length === f.lines.length ? !bodyNoEol(hunk.body) : f.finalBreak;
  return { f: { br: f.br, lines, finalBreak }, delta: repl.length - o.length };
}

function unifiedEdit(sec: UnifiedSection): Edit {
  return (tree) => {
    const { old, nw } = resolveUnifiedPaths(sec);
    if (old === null || sec.isCreate) {
      const p = nw ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.body) if (it.kind === 'add') plus.push(it.text);
      const noEol = creationNoEol(sec.hunks);
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (nw === null || sec.isDelete) {
      const p = old ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = old;
    const q = nw;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (!safe(q)) throw new Fail('unsafe', q);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (old !== nw && tree.get(q) !== null) throw new Fail('exists', q);
    let f = parseFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyUnifiedHunk(f, h, d, p);
      f = r.f;
      d += r.delta;
    }
    const text = serializeFile(f);
    if (old !== nw) {
      tree.now.set(p, null);
      tree.now.set(q, text);
      tree.moves.push([p, q]);
    } else {
      tree.now.set(p, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  /** 0-based index of the `>>>>>>> REPLACE` line, bounding the next block's path search. */
  endIdx: number;
}

function parseSearchReplace(lines: string[]): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eqIdx = -1;
    let j = i + 1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
      j++;
    }
    if (eqIdx === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let repIdx = -1;
    let k = eqIdx + 1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = k;
        break;
      }
      k++;
    }
    if (repIdx === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const afterIdx = blocks.length > 0 ? blocks[blocks.length - 1]!.endIdx + 1 : 0;
    let path: string | null = null;
    for (let p = searchIdx - 1; p >= afterIdx; p--) {
      const t = lines[p]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    blocks.push({
      path,
      oldLines: lines.slice(i + 1, eqIdx),
      newLines: lines.slice(eqIdx + 1, repIdx),
      endIdx: repIdx,
    });
    i = repIdx + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function searchReplaceEdit(block: SearchReplaceBlock): Edit {
  return (tree) => {
    const p = block.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (block.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = parseFile(cur);
    const found = findTier(f.lines, block.oldLines, 0);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const pp = leadingWs(block.oldLines[0]!);
    const ff = leadingWs(f.lines[pos]!);
    const repl = block.newLines.map((l) => (found.tier === 2 ? reindentLine(l, pp, ff) : l));
    const lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + block.oldLines.length)];
    tree.now.set(p, serializeFile({ br: f.br, lines, finalBreak: f.finalBreak }));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** Null or '' means no anchor. */
  anchor: string | null;
  eof: boolean;
  body: BodyItem[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | undefined;
  /** Add File lines, in order. */
  lines: string[] | null;
  chunks: V4aChunk[] | null;
  lineNo: number;
}

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function isV4aSectionStart(l: string): boolean {
  return l.startsWith(V4A_ADD) || l.startsWith(V4A_DELETE) || l.startsWith(V4A_UPDATE);
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith(V4A_ADD)) {
      const path = l.slice(V4A_ADD.length).trim();
      const secLineNo = i + 1;
      // Each collected line notes whether it came from a blank patch line: blank lines at the
      // end of a section are not part of it, but a `+` line is a line of the file even when empty.
      const collected: Array<{ text: string; fromBlank: boolean }> = [];
      i++;
      while (i < last) {
        const bl = lines[i]!;
        if (isV4aSectionStart(bl)) break;
        if (bl === '') {
          collected.push({ text: '', fromBlank: true });
          i++;
          continue;
        }
        if (bl.startsWith('+')) {
          collected.push({ text: bl.slice(1), fromBlank: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (collected.length > 0 && collected[collected.length - 1]!.fromBlank) collected.pop();
      sections.push({ kind: 'add', path, moveTo: undefined, lines: collected.map((c) => c.text), chunks: null, lineNo: secLineNo });
      continue;
    }
    if (l.startsWith(V4A_DELETE)) {
      const path = l.slice(V4A_DELETE.length).trim();
      const secLineNo = i + 1;
      i++;
      while (i < last) {
        const bl = lines[i]!;
        if (isV4aSectionStart(bl)) break;
        if (blank(bl)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind: 'delete', path, moveTo: undefined, lines: null, chunks: null, lineNo: secLineNo });
      continue;
    }
    if (l.startsWith(V4A_UPDATE)) {
      const path = l.slice(V4A_UPDATE.length).trim();
      const secLineNo = i + 1;
      i++;
      let moveTo: string | undefined;
      if (i < last && lines[i]!.startsWith(V4A_MOVE)) {
        moveTo = lines[i]!.slice(V4A_MOVE.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let chunk: V4aChunk | null = null;
      const closeChunk = (stripTrailing: boolean): void => {
        if (chunk === null) return;
        if (stripTrailing) {
          while (chunk.body.length > 0) {
            const lastItem = chunk.body[chunk.body.length - 1]!;
            if (lastItem.kind === 'ctx' && /^[ \t]*$/.test(lastItem.text)) chunk.body.pop();
            else break;
          }
        }
        chunks.push(chunk);
        chunk = null;
      };
      while (i < last) {
        const bl = lines[i]!;
        if (isV4aSectionStart(bl)) break;
        if (bl.trimEnd() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
          chunk.eof = true;
          closeChunk(false);
          i++;
          continue;
        }
        if (bl.startsWith('@@')) {
          closeChunk(false);
          chunk = { anchor: bl.slice(2).trim(), eof: false, body: [] };
          i++;
          continue;
        }
        if (bl.startsWith(V4A_MOVE)) throw new Exit2(`error: parse ${i + 1}`);
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
          const kind: BodyItem['kind'] = bl === '' || bl[0] === ' ' ? 'ctx' : bl[0] === '-' ? 'del' : 'add';
          chunk.body.push({ kind, text: bl === '' ? '' : bl.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk(true);
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLineNo}`);
      sections.push({ kind: 'update', path, moveTo, lines: null, chunks, lineNo: secLineNo });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** Apply one V4A chunk; returns the new file and the cursor just after the lines written. */
function applyV4aChunk(f: FileState, chunk: V4aChunk, cursor: number, path: string): { f: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null && chunk.anchor !== '') {
    const found = findTier(f.lines, [chunk.anchor], cur);
    if (found === null) throw new Fail('no-match', path);
    cur = found.positions[0]! + 1;
  }
  const o = oldLines(chunk.body);
  if (o.length === 0) {
    const n = chunk.body.filter((it) => it.kind === 'add').map((it) => it.text);
    const ins = chunk.eof ? f.lines.length : cur;
    const lines = [...f.lines.slice(0, ins), ...n, ...f.lines.slice(ins)];
    return { f: { br: f.br, lines, finalBreak: f.finalBreak }, cursor: ins + n.length };
  }
  const found = findTier(f.lines, o, cur);
  if (found === null) throw new Fail('no-match', path);
  let positions = found.positions;
  if (chunk.eof) positions = positions.filter((p) => p + o.length === f.lines.length);
  if (positions.length === 0) throw new Fail('no-match', path);
  const pos = positions[0]!;
  const repl = buildReplacement(chunk.body, f.lines, pos, found.tier);
  const lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + o.length)];
  return { f: { br: f.br, lines, finalBreak: f.finalBreak }, cursor: pos + repl.length };
}

function v4aEdit(sec: V4aSection): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const ls = sec.lines!;
      tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    let moveTo: string | undefined;
    if (sec.moveTo !== undefined) {
      moveTo = sec.moveTo;
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(cur);
    let cursor = 0;
    for (const chunk of sec.chunks!) {
      const r = applyV4aChunk(f, chunk, cursor, p);
      f = r.f;
      cursor = r.cursor;
    }
    const text = serializeFile(f);
    if (moveTo !== undefined) {
      tree.now.set(p, null);
      tree.now.set(moveTo, text);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits (as the kit's starter)                        */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Section 1, 2, 10: invocation, output, order and atomicity           */
/* ------------------------------------------------------------------ */

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
    else if (kind === 'unified') edits = parseUnified(lines).map(unifiedEdit);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map(searchReplaceEdit);
    else edits = parseV4a(lines).map(v4aEdit);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // --strict matches lines exactly (tier 0 only, section 5).
  strictOnly = strict;
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
  const rPairs: Array<[string, string]> = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) rPairs.push([o, n]);
  }
  const rOlds = new Set(rPairs.map(([o]) => o));
  const rNews = new Set(rPairs.map(([, n]) => n));
  for (const [o, n] of rPairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  for (const p of tree.now.keys()) {
    if (rOlds.has(p) || rNews.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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

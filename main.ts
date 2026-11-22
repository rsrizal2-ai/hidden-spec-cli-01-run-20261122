// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 of SPEC.md (command line, output and exit codes, safe paths, format detection,
// JSON edits, all-or-nothing write) are the kit's starting point; sections 5 to 8 (three-tier line matching,
// unified diffs, SEARCH/REPLACE blocks, V4A patches) and the `R` move line of section 2 are written here.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
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

/* ------------------------------------------------------------------ */
/* Section 3: a file's lines, its line break, and its final break.    */
/* ------------------------------------------------------------------ */

interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers.                           */
/* ------------------------------------------------------------------ */

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** 0-based positions where O occurs in F at the given tier; occurrences may overlap. */
function occurrences(O: string[], F: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > F.length) return out;
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function findTier(O: string[], F: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, F, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Like findTier, but only occurrences at or after `from`; for an end-of-file chunk only
 *  occurrences ending at the file's last line count, at the first tier where such a one is. */
function findTierFrom(
  O: string[],
  F: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(O, F, t).filter((p) => p >= from);
    if (eofOnly) occ = occ.filter((p) => p + O.length === F.length);
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NItem {
  ctx: boolean;
  oIdx: number;
  text: string;
}

/** Build the lines N writes, given the match at `pos` and the tier it was found at. */
function buildReplacement(N: NItem[], O: string[], F: string[], pos: number, tier: number): string[] {
  const lead = (s: string): string => {
    const m = /^[ \t]*/.exec(s);
    return m === null ? '' : m[0];
  };
  const fLead = O.length > 0 && pos < F.length ? lead(F[pos]!) : '';
  const pLead = O.length > 0 ? lead(O[0]!) : '';
  return N.map((n) => {
    if (n.ctx) return F[pos + n.oIdx]!;
    if (tier === 2) {
      const t = n.text;
      if (t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(pLead)) return fLead + t.slice(pLead.length);
      return t;
    }
    return n.text;
  });
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                           */
/* ------------------------------------------------------------------ */

interface BodyItem {
  kind: ' ' | '-' | '+';
  text: string;
  noNl: boolean;
}
interface Hunk {
  a: number;
  items: BodyItem[];
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let lines = [...doc.lines];
  let final = doc.final;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NItem[] = [];
    for (const it of h.items) {
      if (it.kind === ' ') {
        O.push(it.text);
        N.push({ ctx: true, oIdx: O.length - 1, text: it.text });
      } else if (it.kind === '-') {
        O.push(it.text);
      } else {
        N.push({ ctx: false, oIdx: -1, text: it.text });
      }
    }
    let noNlAtEnd = false;
    for (let k = h.items.length - 1; k >= 0; k--) {
      const it = h.items[k]!;
      if (it.kind === ' ' || it.kind === '+') {
        noNlAtEnd = it.noNl;
        break;
      }
    }
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = at === lines.length;
      const ins = buildReplacement(N, O, lines, at, 0);
      lines.splice(at, 0, ...ins);
      if (atEnd) final = !noNlAtEnd;
      d += N.length;
      continue;
    }
    const found = findTier(O, lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const pos = best;
    const rep = buildReplacement(N, O, lines, pos, found.tier);
    const reachesEnd = pos + O.length === lines.length;
    lines.splice(pos, O.length, ...rep);
    if (reachesEnd) final = !noNlAtEnd;
    d += N.length - O.length;
  }
  return { lines, br: doc.br, final };
}

interface Section {
  headerOld: string | null | undefined;
  headerNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  creation: boolean;
  deletion: boolean;
  seenHunk: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    headerOld: undefined,
    headerNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    gitOld: undefined,
    gitNew: undefined,
    creation: false,
    deletion: false,
    seenHunk: false,
    hunks: [],
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path a `--- ` / `+++ ` line names: text after the four characters, up to the first tab,
 *  surrounding spaces removed; `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function headerPathValue(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  return p === '/dev/null' ? null : stripAB(p);
}

function parseDiffGit(l: string, ln: number): [string, string] {
  const rest = l.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${ln}`);
  const sep = rest.lastIndexOf(' b/');
  if (sep < 0) throw new Exit2(`error: parse ${ln}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${ln}`);
  return [x, y];
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  const oldP =
    s.headerOld !== undefined ? s.headerOld : s.renameOld !== undefined ? s.renameOld : s.gitOld !== undefined ? s.gitOld : null;
  const newP =
    s.headerNew !== undefined ? s.headerNew : s.renameNew !== undefined ? s.renameNew : s.gitNew !== undefined ? s.gitNew : null;
  const isCreation = oldP === null || s.creation;
  const isDeletion = !isCreation && (newP === null || s.deletion);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null && newP === null) return;
    if (isCreation) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlus: BodyItem | null = null;
      for (const h of s.hunks) {
        for (const it of h.items) {
          if (it.kind === '+') {
            plus.push(it.text);
            lastPlus = it;
          }
        }
      }
      const final = lastPlus === null || !lastPlus.noNl;
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDeletion) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (oldP === null || newP === null) return;
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(parseDoc(before), s.hunks, strict, oldP);
      tree.now.set(newP, writeDoc(out));
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, new: newP });
      return;
    }
    const before = tree.get(oldP!);
    if (before === null) throw new Fail('missing', oldP!);
    const out = applyHunks(parseDoc(before), s.hunks, strict, oldP!);
    tree.now.set(oldP!, writeDoc(out));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let cur: Section | null = null;
  let body: BodyItem[] | null = null;
  let hunkA = 0;
  const finishBody = (): void => {
    if (body !== null && cur !== null) {
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === ' ' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a: hunkA, items: body });
      body = null;
    }
  };
  const finishSection = (): void => {
    finishBody();
    if (cur !== null) {
      edits.push(unifiedSectionEdit(cur, strict));
      cur = null;
    }
  };
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx]!;
    const ln = idx + 1;
    if (body !== null) {
      if (l.startsWith('diff --git ')) {
        finishBody();
        finishSection();
        const [x, y] = parseDiffGit(l, ln);
        cur = newSection();
        cur.gitOld = x;
        cur.gitNew = y;
        continue;
      }
      if (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')) {
        finishBody();
        finishSection();
        cur = newSection();
        cur.headerOld = headerPathValue(l);
        cur.headerNew = headerPathValue(lines[idx + 1]!);
        idx++;
        continue;
      }
      if (l.startsWith('@@')) {
        finishBody();
        const m = HUNK_RE.exec(l);
        if (m === null) throw new Exit2(`error: parse ${ln}`);
        hunkA = Number(m[1]);
        cur!.seenHunk = true;
        body = [];
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        if (l[0] === '\\') {
          if (body.length > 0) body[body.length - 1]!.noNl = true;
          continue;
        }
        body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1), noNl: false });
        continue;
      }
      finishBody();
      continue;
    }
    if (cur === null) {
      if (l.startsWith('diff --git ')) {
        const [x, y] = parseDiffGit(l, ln);
        cur = newSection();
        cur.gitOld = x;
        cur.gitNew = y;
        continue;
      }
      if (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')) {
        cur = newSection();
        cur.headerOld = headerPathValue(l);
        cur.headerNew = headerPathValue(lines[idx + 1]!);
        idx++;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${ln}`);
      continue;
    }
    if (l.startsWith('diff --git ')) {
      finishSection();
      const [x, y] = parseDiffGit(l, ln);
      cur = newSection();
      cur.gitOld = x;
      cur.gitNew = y;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[idx + 1] ?? '').startsWith('+++ ')) {
        if (!cur.seenHunk && cur.headerOld === undefined && cur.headerNew === undefined) {
          cur.headerOld = headerPathValue(l);
          cur.headerNew = headerPathValue(lines[idx + 1]!);
          idx++;
          continue;
        }
        finishSection();
        cur = newSection();
        cur.headerOld = headerPathValue(l);
        cur.headerNew = headerPathValue(lines[idx + 1]!);
        idx++;
        continue;
      }
      if (!cur.seenHunk) throw new Exit2(`error: parse ${idx + 2 > lines.length ? lines.length + 1 : idx + 2}`);
      continue;
    }
    if (l.startsWith('+++ ')) continue;
    if (!cur.seenHunk && l.startsWith('rename from ')) {
      cur.renameOld = l.slice('rename from '.length).trim();
      continue;
    }
    if (!cur.seenHunk && l.startsWith('rename to ')) {
      cur.renameNew = l.slice('rename to '.length).trim();
      continue;
    }
    if (!cur.seenHunk && l.startsWith('new file mode')) {
      cur.creation = true;
      continue;
    }
    if (!cur.seenHunk && l.startsWith('deleted file mode')) {
      cur.deletion = true;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      hunkA = Number(m[1]);
      cur.seenHunk = true;
      body = [];
      continue;
    }
    continue;
  }
  finishSection();
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                   */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    const found = findTier(oldLines, doc.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rep = buildReplacement(
      newLines.map((t) => ({ ctx: false, oIdx: -1, text: t })),
      oldLines,
      doc.lines,
      pos,
      found.tier,
    );
    const out = [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + oldLines.length)];
    tree.now.set(path, writeDoc({ lines: out, br: doc.br, final: doc.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLn = idx + 1;
    let eq = -1;
    for (let j = idx + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (l.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLn}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (l.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLn}`);
    let path: string | null = null;
    for (let j = idx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLn}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srEdit(path, lines.slice(idx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevEnd = rep;
    idx = rep;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                             */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function applyV4aChunks(doc: FileDoc, chunks: VChunk[], strict: boolean, path: string): FileDoc {
  let lines = [...doc.lines];
  const final = doc.final;
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null && c.anchor !== '') {
      const found = findTierFrom([c.anchor], lines, strict, cursor, false);
      if (found === null) throw new Fail('no-match', path);
      cursor = found.pos + 1;
    }
    const O: string[] = [];
    const N: NItem[] = [];
    for (const it of c.items) {
      if (it.kind === ' ') {
        O.push(it.text);
        N.push({ ctx: true, oIdx: O.length - 1, text: it.text });
      } else if (it.kind === '-') {
        O.push(it.text);
      } else {
        N.push({ ctx: false, oIdx: -1, text: it.text });
      }
    }
    if (O.length === 0) {
      const at = c.eof ? lines.length : cursor;
      const ins = buildReplacement(N, O, lines, at, 0);
      lines.splice(at, 0, ...ins);
      cursor = at + ins.length;
      continue;
    }
    const found = findTierFrom(O, lines, strict, cursor, c.eof);
    if (found === null) throw new Fail('no-match', path);
    const rep = buildReplacement(N, O, lines, found.pos, found.tier);
    lines.splice(found.pos, O.length, ...rep);
    cursor = found.pos + rep.length;
  }
  return { lines, br: doc.br, final };
}

function v4aAddEdit(path: string, secLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, secLines.length === 0 ? '' : secLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const out = applyV4aChunks(parseDoc(before), chunks, strict, path);
    const text = writeDoc(out);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
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
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      // A `+` line is a deliberate line of the file even when its rest is empty; a truly
      // blank patch line is an empty line of the file, except blank lines at the end of
      // the section, which are not part of it. Track which is which to trim only blanks.
      const secLines: Array<{ text: string; blank: boolean }> = [];
      i++;
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x)) break;
        if (x.startsWith('+')) secLines.push({ text: x.slice(1), blank: false });
        else if (x === '') secLines.push({ text: '', blank: true });
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (secLines.length > 0 && secLines[secLines.length - 1]!.blank) secLines.pop();
      edits.push(v4aAddEdit(path, secLines.map((s) => s.text)));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x)) break;
        if (blank(x)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLn = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; items: BodyItem[] } | null = null;
      const finishChunk = (): void => {
        if (cur !== null) {
          chunks.push({ anchor: cur.anchor, eof: cur.eof, items: cur.items });
          cur = null;
        }
      };
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x)) break;
        if (x.startsWith('@@')) {
          finishChunk();
          cur = { anchor: x.slice(2).trim(), eof: false, items: [] };
          i++;
          continue;
        }
        if (x === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: true, items: [] };
          else cur.eof = true;
          finishChunk();
          i++;
          continue;
        }
        if (x.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (x === '' || x[0] === ' ' || x[0] === '-' || x[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) {
              i++;
              continue;
            }
            cur = { anchor: null, eof: false, items: [] };
          }
          cur.items.push({ kind: x === '' ? ' ' : (x[0] as ' ' | '-' | '+'), text: x === '' ? '' : x.slice(1), noNl: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        while (cur.items.length > 0) {
          const it = cur.items[cur.items.length - 1]!;
          if (it.kind === ' ' && it.text === '') cur.items.pop();
          else break;
        }
        finishChunk();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLn}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
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
  // Output rows: one per changed path, in byte order of the path; a move that succeeded
  // prints `R <old> -> <new>` (sorted by <new>) instead of its `D` and `A` lines.
  const rByNew = new Map<string, string>();
  for (let k = tree.moves.length - 1; k >= 0; k--) {
    const m = tree.moves[k]!;
    if (rByNew.has(m.new)) continue;
    if (tree.original(m.old) === null) continue;
    if (tree.get(m.old) !== null) continue;
    if (tree.original(m.new) !== null) continue;
    if (tree.get(m.new) === null) continue;
    rByNew.set(m.new, m.old);
  }
  const suppressedOld = new Set<string>([...rByNew.values()]);
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (suppressedOld.has(p)) continue;
    if (rByNew.has(p)) {
      rows.push({ key: p, text: `R ${rByNew.get(p)!} -> ${p}` });
      continue;
    }
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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

// Pure plan-reader core — ported from command-code v1.54.0 (see notes/02-plan-reader-tui.md).
// No TUI, no I/O. Everything here is (strings, numbers) -> (strings, numbers).

// ---------- types ----------

export type Annotation = { line: number; text: string; createdAt: string };

export type PlanAction = { id: string; label: string; description?: string };

export type Row =
  | { kind: "line"; lineNumber: number; text: string; hasAnnotation: boolean }
  | { kind: "annotation"; lineNumber: number; text: string }
  | { kind: "action"; id: string; label: string };

export type DisplayRow = { row: Row; text: string; isFirstSegment: boolean };

export type Cursor =
  | { kind: "line"; lineNumber: number }
  | { kind: "action"; id: string };

export type LineRole =
  | { role: "heading"; headingLevel: number }
  | { role: "code" }
  | { role: "code-fence" }
  | { role: "quote" }
  | { role: "table" }
  | { role: "bullet" }
  | { role: "text" };

// ---------- text ----------

export function splitPlanLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+/;
const QUOTE_RE = /^\s*>/;
const TABLE_RE = /^\s*\|/;
const BULLET_RE = /^\s*[-*+]\s+/;

export function classifyPlanLines(lines: string[]): LineRole[] {
  let inFence = false;
  return lines.map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return { role: "code-fence" as const };
    }
    if (inFence) return { role: "code" as const };
    const heading = line.match(HEADING_RE);
    if (heading?.[1]) return { role: "heading" as const, headingLevel: heading[1].length };
    if (QUOTE_RE.test(line)) return { role: "quote" as const };
    if (TABLE_RE.test(line)) return { role: "table" as const };
    if (BULLET_RE.test(line)) return { role: "bullet" as const };
    return { role: "text" as const };
  });
}

import stringWidth from "string-width";

// Per-grapheme width: string-width (East Asian Width + emoji aware), same lib cmdc uses.
type Measure = (grapheme: string) => number;
const measureGrapheme: Measure = (g) => stringWidth(g);

function segment(text: string): string[] {
  const s = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(s.segment(text), (x) => x.segment);
}

function hangIndent(text: string, width: number): string {
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  return lead.length + 8 <= width ? lead : "";
}

/** Grapheme-aware word wrap with hang-indent continuation (cmdc's wrapCellsLine). */
export function wrapPlanText(text: string, width: number, measure: Measure = measureGrapheme): string[] {
  const glyphs = segment(text);
  const total = glyphs.reduce((sum, g) => sum + measure(g), 0);
  if (total <= width) return [text];
  const hang = hangIndent(text, width);
  const out: string[] = [];
  let i = 0;
  let first = true;
  while (i < glyphs.length) {
    const prefix = first ? "" : hang;
    const budget = width - prefix.length;
    let acc = 0;
    let c = i;
    let lastSpace = -1;
    while (c < glyphs.length) {
      const w = measure(glyphs[c]!);
      if (acc + w > budget) break;
      acc += w;
      if (glyphs[c] === " ") lastSpace = c;
      c++;
    }
    const join = (a: number, b: number) => glyphs.slice(a, b).join("");
    if (c >= glyphs.length) {
      out.push(prefix + join(i, glyphs.length));
      break;
    }
    const breakAt = lastSpace > i ? lastSpace : Math.max(c, i + 1);
    out.push(prefix + join(i, breakAt));
    i = breakAt;
    while (glyphs[i] === " ") i++;
    first = false;
  }
  return out;
}

// ---------- rows ----------

export function buildPlanReaderRows(input: {
  lines: string[];
  annotations: Annotation[];
  actions?: PlanAction[];
}): Row[] {
  const byLine = new Map<number, Annotation>();
  for (const a of input.annotations) byLine.set(a.line, a);
  const rows: Row[] = [];
  input.lines.forEach((text, idx) => {
    const lineNumber = idx + 1;
    const annotation = byLine.get(lineNumber);
    rows.push({ kind: "line", lineNumber, text, hasAnnotation: annotation !== undefined });
    if (annotation) rows.push({ kind: "annotation", lineNumber, text: annotation.text });
  });
  for (const a of input.actions ?? []) rows.push({ kind: "action", id: a.id, label: a.label });
  return rows;
}

export function buildPlanReaderDisplayRows(input: {
  rows: Row[];
  width: number;
  measure?: Measure;
}): DisplayRow[] {
  const out: DisplayRow[] = [];
  for (const row of input.rows) {
    if (row.kind === "action") {
      out.push({ row, text: "", isFirstSegment: true });
      continue;
    }
    const w = row.kind === "annotation" ? Math.max(1, input.width - 3) : input.width;
    wrapPlanText(row.text, w, input.measure).forEach((text, i) => {
      out.push({ row, text, isFirstSegment: i === 0 });
    });
  }
  return out;
}

// ---------- cursor ----------

export function getPlanReaderCursorRowIndex(input: {
  rows: Row[];
  cursor: Cursor;
}): number {
  return input.rows.findIndex((row) =>
    input.cursor.kind === "action"
      ? row.kind === "action" && row.id === input.cursor.id
      : row.kind === "line" && row.lineNumber === input.cursor.lineNumber,
  );
}

export function getPlanReaderCursorDisplaySpan(input: {
  displayRows: DisplayRow[];
  cursor: Cursor;
}): { first: number; last: number } {
  let first = -1;
  let last = -1;
  input.displayRows.forEach((dr, idx) => {
    const { row } = dr;
    const hit =
      input.cursor.kind === "action"
        ? row.kind === "action" && row.id === input.cursor.id
        : row.kind === "line" && row.lineNumber === input.cursor.lineNumber;
    if (hit) {
      if (first === -1) first = idx;
      last = idx;
    }
  });
  return { first, last };
}

export function movePlanReaderCursor(input: {
  cursor: Cursor;
  direction: "up" | "down";
  lineCount: number;
  actions: PlanAction[];
}): Cursor {
  const { cursor, direction, lineCount, actions } = input;
  if (cursor.kind === "action") {
    const idx = actions.findIndex((a) => a.id === cursor.id);
    if (direction === "down") {
      return actions[idx + 1] ? { kind: "action", id: actions[idx + 1]!.id } : cursor;
    }
    const prev = idx > 0 ? actions[idx - 1] : undefined;
    return prev ? { kind: "action", id: prev.id } : lineCount > 0 ? { kind: "line", lineNumber: lineCount } : cursor;
  }
  if (direction === "up") return { kind: "line", lineNumber: Math.max(1, cursor.lineNumber - 1) };
  if (cursor.lineNumber >= lineCount) {
    const first = actions[0];
    return first ? { kind: "action", id: first.id } : cursor;
  }
  return { kind: "line", lineNumber: cursor.lineNumber + 1 };
}

export function movePlanReaderCursorByPage(input: {
  displayRows: DisplayRow[];
  cursor: Cursor;
  direction: "up" | "down";
  pageRows: number;
}): Cursor {
  const { displayRows, cursor, direction } = input;
  if (displayRows.length === 0) return cursor;
  const span = getPlanReaderCursorDisplaySpan({ displayRows, cursor });
  const edge = direction === "down" ? span.last : span.first;
  const from = edge === -1 ? displayRows.length - 1 : edge;
  const page = Math.max(1, input.pageRows);
  const to = direction === "down" ? Math.min(displayRows.length - 1, from + page) : Math.max(0, from - page);
  const row = displayRows[to]?.row;
  // Landing on an action row is rejected — the caller's key handler keeps the cursor parked.
  return row && row.kind !== "action" ? { kind: "line", lineNumber: row.lineNumber } : cursor;
}

export function snapPlanReaderCursor(input: {
  cursor: Cursor;
  lineCount: number;
  actions: PlanAction[];
}): Cursor {
  const { cursor, lineCount, actions } = input;
  if (cursor.kind === "line") return { kind: "line", lineNumber: Math.min(Math.max(1, cursor.lineNumber), lineCount) };
  if (actions.some((a) => a.id === cursor.id)) return cursor;
  const first = actions[0];
  return first ? { kind: "action", id: first.id } : { kind: "line", lineNumber: Math.max(1, lineCount) };
}

// ---------- scroll ----------

/**
 * Minimal-scroll clamp keeping `row` visible in a window of maxVisible display rows.
 * (Inferred behavior; cmdc applies it to both endpoints of the cursor's display span.)
 */
export function clampScrollOffset(input: {
  row: number;
  total: number;
  maxVisible: number;
  currentOffset: number;
}): number {
  const maxOffset = Math.max(0, input.total - input.maxVisible);
  let offset = Math.min(Math.max(0, input.currentOffset), maxOffset);
  if (input.row < offset) offset = input.row;
  if (input.row >= offset + input.maxVisible) offset = input.row - input.maxVisible + 1;
  return Math.max(0, offset);
}

// ---------- diff ----------

/** Current lines whose trimmed text is not present in the previous version. */
export function diffPlanChangedLines(input: { previous: string; current: string[] }): Set<number> {
  const prev = new Set(input.previous.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
  const changed = new Set<number>();
  input.current.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !prev.has(trimmed)) changed.add(idx + 1);
  });
  return changed;
}

// ---------- sanitization ----------

/** Strip ANSI/OSC escape sequences and C0/C1 control chars (keeps \t).
 *  Hostile plan content must not reach the terminal raw. */
export function sanitizePlanText(text: string): string {
	return text
		// complete sequences first so their printable payload doesn't linger
		.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

// ---------- annotations ----------

/** Replace the annotation on `line`; empty text removes it. Result sorted by line. */
export function upsertPlanAnnotation(input: {
  annotations: Annotation[];
  line: number;
  text: string;
  createdAt: string;
}): Annotation[] {
  const rest = input.annotations.filter((a) => a.line !== input.line);
  const text = input.text.trim();
  if (!text) return rest;
  return [...rest, { line: input.line, text, createdAt: input.createdAt }].sort((a, b) => a.line - b.line);
}

/** Jump targets: union of annotated lines, sorted (cmdc also unions changed lines at call site). */
export function markedLines(annotations: Annotation[], changed: Iterable<number>): number[] {
  const set = new Set<number>();
  for (const a of annotations) set.add(a.line);
  for (const line of changed) set.add(line);
  return [...set].sort((a, b) => a - b);
}

export function jumpMarked(input: {
  marked: number[];
  from: number | undefined; // current cursor line, undefined = "on an action" (start after last)
  direction: "next" | "previous";
  lineCount: number;
}): number | undefined {
  if (input.marked.length === 0) return undefined;
  const from = input.from ?? input.lineCount + 1;
  if (input.direction === "next") {
    return input.marked.find((l) => l > from) ?? input.marked[0];
  }
  return [...input.marked].reverse().find((l) => l < from) ?? input.marked[input.marked.length - 1];
}

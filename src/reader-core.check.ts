// Runnable check: node --experimental-strip-types src/reader-core.check.ts
import assert from "node:assert";
import {
  splitPlanLines,
  classifyPlanLines,
  wrapPlanText,
  buildPlanReaderRows,
  buildPlanReaderDisplayRows,
  movePlanReaderCursor,
  movePlanReaderCursorByPage,
  snapPlanReaderCursor,
  getPlanReaderCursorDisplaySpan,
  clampScrollOffset,
  diffPlanChangedLines,
  upsertPlanAnnotation,
  jumpMarked,
  type Cursor,
} from "./reader-core.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; };

// classify
ok("fence toggles and styles code", () => {
  const roles = classifyPlanLines(["```", "const x = 1", "```", "# Title", "> quote", "| a | b |", "- item", "plain"]);
  assert.deepEqual(roles.map((r) => r.role), ["code-fence", "code", "code-fence", "heading", "quote", "table", "bullet", "text"]);
  assert.equal(roles[3].role === "heading" ? roles[3].headingLevel : 0, 1);
});

// rows: annotation lands under its line, actions appended
ok("rows model", () => {
  const rows = buildPlanReaderRows({
    lines: ["a", "b", "c"],
    annotations: [{ line: 2, text: "why?", createdAt: "t" }],
    actions: [{ id: "execute", label: "Execute plan" }],
  });
  assert.deepEqual(rows.map((r) => (r.kind === "line" ? `L${r.lineNumber}${r.hasAnnotation ? "*" : ""}` : r.kind === "annotation" ? `A${r.lineNumber}` : `X:${r.id}`)),
    ["L1", "L2*", "A2", "L3", "X:execute"]);
});

// wrap
ok("short text not wrapped", () => {
  assert.deepEqual(wrapPlanText("hello", 10), ["hello"]);
});
ok("word wrap keeps words intact", () => {
  assert.deepEqual(wrapPlanText("the quick brown fox", 10), ["the quick", "brown fox"]);
});
ok("hang indent preserved on continuation", () => {
  const out = wrapPlanText("    - one two three four five six seven", 12);
  assert.equal(out[0], "    - one");
  // continuation prefix = the original line's leading whitespace (4 spaces);
  // 7 lines: the break lands on the space after a word, never mid-word-fill
  assert.equal(out.length, 7);
  assert.ok(out.slice(1).every((l) => l.startsWith("    ")), `continuation re-indented: ${JSON.stringify(out)}`);
});
ok("oversize word hard-breaks", () => {
  const out = wrapPlanText("abcdefghij", 4);
  assert.deepEqual(out, ["abcd", "efgh", "ij"]);
});
ok("CJK measured double-width", () => {
  // 7 chars x width 2, budget 6 -> 3 chars per line, then 1
  assert.deepEqual(wrapPlanText("こんにちは世界", 6), ["こんに", "ちは世", "界"]);
  assert.deepEqual(wrapPlanText("👍 ok", 5), ["👍 ok"]); // emoji counts 2: 2+1+2 fits
  assert.deepEqual(wrapPlanText("👍 ok", 4), ["👍", "ok"]); // 2+1+2 > 4 -> break at space
});

// display rows: annotations wrap narrower
ok("display rows", () => {
  const rows = buildPlanReaderRows({ lines: ["long line ".repeat(3).trim()], annotations: [], actions: [{ id: "x", label: "X" }] });
  const dr = buildPlanReaderDisplayRows({ rows, width: 20 });
  assert.equal(dr.filter((d) => d.row.kind === "line").length, 2); // 30 chars -> 2 segments
  assert.equal(dr.at(-1)!.row.kind, "action");
});

// cursor: line <-> action transitions
const actions = [{ id: "submit", label: "Submit" }, { id: "execute", label: "Execute" }];
ok("down from last line lands on first action", () => {
  assert.deepEqual(movePlanReaderCursor({ cursor: { kind: "line", lineNumber: 3 }, direction: "down", lineCount: 3, actions }),
    { kind: "action", id: "submit" });
});
ok("up from first action lands on last line", () => {
  assert.deepEqual(movePlanReaderCursor({ cursor: { kind: "action", id: "submit" }, direction: "up", lineCount: 3, actions }),
    { kind: "line", lineNumber: 3 });
});
ok("actions chain and stop at the end", () => {
  let c: Cursor = { kind: "action", id: "submit" };
  c = movePlanReaderCursor({ cursor: c, direction: "down", lineCount: 3, actions });
  assert.deepEqual(c, { kind: "action", id: "execute" });
  c = movePlanReaderCursor({ cursor: c, direction: "down", lineCount: 3, actions });
  assert.deepEqual(c, { kind: "action", id: "execute" });
});
ok("line clamps at 1 going up", () => {
  assert.deepEqual(movePlanReaderCursor({ cursor: { kind: "line", lineNumber: 1 }, direction: "up", lineCount: 3, actions }),
    { kind: "line", lineNumber: 1 });
});

// paging by display rows
ok("page down moves by display rows, rejects landing on action", () => {
  const rows = buildPlanReaderRows({ lines: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`), annotations: [], actions });
  const dr = buildPlanReaderDisplayRows({ rows, width: 80 });
  const cursor: Cursor = { kind: "line", lineNumber: 1 };
  const paged = movePlanReaderCursorByPage({ displayRows: dr, cursor, direction: "down", pageRows: 10 });
  assert.deepEqual(paged, { kind: "line", lineNumber: 11 });
  // paging onto the action block keeps the cursor where it was
  const nearEnd = movePlanReaderCursorByPage({ displayRows: dr, cursor: { kind: "line", lineNumber: 30 }, direction: "down", pageRows: 100 });
  assert.deepEqual(nearEnd, { kind: "line", lineNumber: 30 });
});
ok("display span covers wrapped segments", () => {
  const rows = buildPlanReaderRows({ lines: ["x".repeat(45)], annotations: [] });
  const dr = buildPlanReaderDisplayRows({ rows, width: 20 });
  const span = getPlanReaderCursorDisplaySpan({ displayRows: dr, cursor: { kind: "line", lineNumber: 1 } });
  assert.deepEqual(span, { first: 0, last: 2 }); // 45/20 -> 3 segments
});

// snap
ok("snap clamps line, relocates dead action", () => {
  assert.deepEqual(snapPlanReaderCursor({ cursor: { kind: "line", lineNumber: 99 }, lineCount: 3, actions }),
    { kind: "line", lineNumber: 3 });
  assert.deepEqual(snapPlanReaderCursor({ cursor: { kind: "action", id: "ghost" }, lineCount: 3, actions }),
    { kind: "action", id: "submit" });
  assert.deepEqual(snapPlanReaderCursor({ cursor: { kind: "action", id: "ghost" }, lineCount: 3, actions: [] }),
    { kind: "line", lineNumber: 3 });
});

// scroll clamp
ok("scroll follows cursor minimally", () => {
  assert.equal(clampScrollOffset({ row: 0, total: 100, maxVisible: 10, currentOffset: 0 }), 0);
  assert.equal(clampScrollOffset({ row: 5, total: 100, maxVisible: 10, currentOffset: 3 }), 3);
  assert.equal(clampScrollOffset({ row: 20, total: 100, maxVisible: 10, currentOffset: 0 }), 11);
  assert.equal(clampScrollOffset({ row: 2, total: 100, maxVisible: 10, currentOffset: 11 }), 2);
  assert.equal(clampScrollOffset({ row: 95, total: 100, maxVisible: 10, currentOffset: 0 }), 86); // row at window bottom
  assert.equal(clampScrollOffset({ row: 99, total: 100, maxVisible: 10, currentOffset: 0 }), 90); // = maxOffset
});

// diff
ok("diff marks lines whose trimmed text is new", () => {
  const changed = diffPlanChangedLines({ previous: "keep\nsame line\n", current: ["keep", "same line", "new one", "   "] });
  assert.deepEqual([...changed], [3]); // unchanged after trim -> not marked; blank ignored
});

// annotations
ok("upsert replaces, empty removes, sorted by line", () => {
  const anns = upsertPlanAnnotation({ annotations: [], line: 5, text: "risky", createdAt: "t" });
  const anns2 = upsertPlanAnnotation({ annotations: anns, line: 2, text: "why?", createdAt: "t" });
  assert.deepEqual(anns2.map((a) => a.line), [2, 5]);
  assert.deepEqual(upsertPlanAnnotation({ annotations: anns2, line: 5, text: "  ", createdAt: "t" }).map((a) => a.line), [2]);
});

// jump
ok("jump next/previous with wraparound", () => {
  const marked = [3, 8, 12];
  assert.equal(jumpMarked({ marked, from: 5, direction: "next", lineCount: 20 }), 8);
  assert.equal(jumpMarked({ marked, from: 5, direction: "previous", lineCount: 20 }), 3);
  assert.equal(jumpMarked({ marked, from: 15, direction: "next", lineCount: 20 }), 3); // wrap
  assert.equal(jumpMarked({ marked, from: 2, direction: "previous", lineCount: 20 }), 12); // wrap
  assert.equal(jumpMarked({ marked: [], from: 5, direction: "next", lineCount: 20 }), undefined);
});

ok("split normalizes CRLF", () => {
  assert.deepEqual(splitPlanLines("a\r\nb"), ["a", "b"]);
});

console.log(`reader-core: ${n} checks passed`);

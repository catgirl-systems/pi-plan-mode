# Reverse-engineering cmdc's plan review UI

Notes on **Command Code** (`cmdc`) v1.54.0 plan mode, taken from the bundled/minified
`dist/cli.mjs` (2.5 MB, 16 lines). Source is an Ink 7 / React 19 TUI; esbuild kept almost
all function names via `__name(...)`, so what's below is recovered verbatim.

**Scope: the review interface only** — the full-screen plan reader, per-row scroll model,
inline comments, version diffing, and the revise/re-review loop with the agent.
UI/UX reproduces cmdc as closely as possible; backend mechanisms follow Pi's philosophy
instead (files as source of truth, tiny transcript deltas, stable prompt prefix).
Mode switching, tool schemas, and permissions are the host's business.

## Files

| File | Contents |
|------|----------|
| [01-plan-storage.md](01-plan-storage.md) | Data model the UI needs: plans dir, index JSON, versions, line annotations, statuses, the annotation→revision prompt |
| [02-plan-reader-tui.md](02-plan-reader-tui.md) | The spec: PlanReader layout + geometry + state machine + keyboard map, PlansView browser, PlanPanel, colors |
| [03-pi-extension-design.md](03-pi-extension-design.md) | Pi extension design: what to keep vs replace, cache-efficient loop, storage layout, skeleton |

## Code

- `index.ts` — **the extension**: PlanReader component (`ctx.ui.custom()`), `/plan-review`
  command, `plan_review` tool, revision/execute loop
- `src/reader-core.ts` — the pure core (rows / wrap / cursor / scroll / diff / annotations),
  ported from the bundle, no TUI or I/O
- `src/plan-store.ts` — storage: index JSON, version snapshots, statuses, comments sidecar
- checks (all assert-based, no framework):

  ```bash
  npx tsc                                              # strict typecheck
  node --experimental-strip-types src/reader-core.check.ts
  node --experimental-strip-types src/plan-store.check.ts
  node --experimental-strip-types src/reader-smoke.check.ts   # drives the real component with raw keystrokes
  ```

Install into pi: `pi install /path/to/this/repo` (uses the `pi.extensions` manifest field),
or symlink `index.ts` + `src/` into `~/.pi/agent/extensions/plan-mode/`.

## The interface in one paragraph

`exit_plan_mode` (or `/plan-review`) opens a **full-screen replacement** of the chat:
the plan file rendered line-by-line (markdown-aware styling, wrapped, line-number gutter,
scrollable window), with a cursor you move over lines and action buttons. You type on any
line to pin a comment under it (⌐ badge), `?`/`x`/`!` pin canned comments instantly,
`ctrl+g` opens `$EDITOR`. Bottom bar: `Submit review (N)` → snapshots a new version,
clears comments, sends the annotations to the agent as a revision prompt; agent rewrites
the plan file; re-opening the reader shows the new version with **changed lines green**.
`Approve` (or `Execute plan`) exits the loop with an approval prompt; pending comments can
go along as non-blocking notes. Plans persist in `~/.commandcode/plans/` and `/plans` is a
searchable browser over them.

The three things actually clever here:
1. **Cursor = line | action** — one keyboard model for prose and buttons; paging moves by
   *display rows* (wrapped segments), not logical lines.
2. **Comments are metadata, not text edits** — stored in an index keyed by line number,
   rendered inline; the plan file stays clean; clearing on submit makes the loop stateless.
3. **Version snapshots + set-diff** — every revision snapshot is kept, changed lines are
   highlighted on the next review, round counter comes from the version number.

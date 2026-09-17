# 02 — Plan storage & lifecycle

## Layout

```
~/.commandcode/plans/
├── plans-index.json          # nv = "plans-index.json"
├── versions/                 # rv = "versions"
│   └── <name>-v1.md          # snapshot taken before each revision
│   └── <name>-v2.md
├── my-plan.md                # the plan files (any *.md ≤ 256 KB / ov=262144)
└── auth-design.md
```

`getPlansDir` = `$HOME/.commandcode/plans` (USERPROFILE fallback on Windows).

## Index file

`plans-index.json`, shape `{ version: 1, plans: { [fileName]: PlanMeta } }`:

```jsonc
{
  "version": 1,
  "plans": {
    "my-plan.md": {
      "title": "My Plan",          // derivePlanTitle: first markdown heading, label "plan:" prefix stripped;
                                   // else filename → words, capitalized
      "sessionId": "…",            // optional, which session created it
      "cwd": "…",                  // optional
      "status": "pending",         // "pending" | "approved" | "not-implemented"
      "createdAt": "ISO",
      "updatedAt": "ISO",
      "annotations": [ { "line": 12, "text": "why?", "createdAt": "ISO" } ], // sorted by line
      "version": 3                 // optional, increments on snapshot
    }
  }
}
```

Writes go through `updateIndex` = read → mutate → write, serialized on a promise chain
(`sv = sv.then(...)`) to avoid read-modify-write races. Corrupt/missing index →
`{version:1, plans:{}}`.

Notably: **annotations live in the index, not in the plan markdown.** The plan file stays
clean; comments are metadata addressed by line number.

## Status lifecycle

- New plan file appears → implicitly "pending" (or listed with fallback meta when not in index).
- `exit_plan_mode` / `plan_review` approval → `recordPlanOutcome({status:"approved"})`.
- Reject → `status: "not-implemented"` (displayed as "◌ set aside" in the UI).
- `listPlans` sorts by `updatedAt` descending. Session filter: if index has sessionId match
  use it, else fall back to mtime ≥ sessionStartMs.

## Versioning

`snapshotPlanVersion({filePath})`:
1. Read current file.
2. Write copy to `versions/<name>-v{currentVersion}.md`.
3. Bump `version` in the index, return new version number.

Called right before submitting feedback (revision round) — so every agent revision is a new
version and the old one is kept in `versions/`.

`readPlanVersionSnapshot({filePath, version})` reads `versions/<name>-v{version}.md`.

## Diff highlighting

`diffPlanChangedLines({previous, current})`: current lines whose *trimmed* text is not in
the previous version's trimmed-line set are "changed". Cheap set-membership diff — the UI
renders these lines green (see 03-tui.md), and the header shows "N lines changed".

## Annotations

- `setPlanAnnotations({filePath, annotations})` — persisted to index on every pin/clear.
- `upsertPlanAnnotation({annotations, line, text, createdAt})` — replaces the annotation on
  that line; empty/whitespace text removes it.
- UI keeps a "pending" in-memory copy while reviewing; persisting marks it dirty so a
  background re-sync doesn't clobber your edits.

## Annotation → prompt generation (the feedback loop)

`buildPlanAnnotationsPrompt({title, filePath, lines, annotations})`:

```
I reviewed the plan "<title>" saved at <filePath> and commented on specific lines:

- Line 12: "Add rate limiting"
  Comment: Why? Explain the reasoning behind this.
- Line 30: "Use Redis"
  Comment: Cut this — remove it from the plan.

Address every comment and update the plan file in place (same path). Do not start
implementing. When the updated plan is written, call exit_plan_mode to present it for
another review — this overrides any earlier instruction to stop and wait.
```

Sent as a *user message* from the review panel. Also, before sending, the current plan is
snapshotted (new version) and pending annotations are cleared.

`buildPlanApprovalNotesPrompt`: same format but "these review notes are NOT blocking; honor
them while implementing (or briefly explain why not)... Do not re-enter plan mode and do not
call exit_plan_mode to re-present the plan."

`buildPlanExecutePrompt`: "Execute the plan "<title>" saved at <filePath>. The plan is
already approved — do NOT enter plan mode... Read the plan file first, then implement it
step by step." (Sent when "Execute plan" is chosen from the /plans browser; if currently in
plan mode, the mode is first flipped to auto-accept.)

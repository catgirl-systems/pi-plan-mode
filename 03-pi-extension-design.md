# 03 — Pi extension design (UX 1:1, backend Pi-native)

Target: a **Pi extension** (`.pi/extensions/` or `~/.pi/agent/extensions/`), TypeScript via
jiti, UI through `ctx.ui.custom()` + `@earendil-works/pi-tui`, storage plain `node:fs`.

Design rule: reproduce cmdc's **UI/UX** as close as possible; replace its **backend
mechanisms** with the ones Pi's architecture favors — files as source of truth, tiny
transcript deltas, stable prompt prefix.

## 1. What stays cmdc-shaped (UI)

- Full-screen reader via `ctx.ui.custom()` (replaces the editor until `done()`); same
  layout, cursor model, scroll feel, draft comments, action bar — spec in
  [02-plan-reader-tui.md](02-plan-reader-tui.md).
- Same keyboard map, same hints, same badge/status rendering.

## 2. What changes and why (backend)

| cmdc does | Why it's cache-hostile / opaque | Pi-native replacement |
|---|---|---|
| `exit_plan_mode` tool result **embeds the whole approved plan** into the transcript | Plan text enters context as a chat message → every later cache prefix carries it; revisions re-paste it | Tool/extension result returns only: status + plan **path** + version. The agent `read`s the file when it needs it — content lands in a tool result once, and re-reads happen only after the file actually changes |
| Revision prompt inlines every annotated line + comment as a user message | Grows with comment count, duplicates what's on disk, lost at compaction | User message stays ~3 lines: plan path + comments sidecar path + instruction. Agent reads both files |
| Annotations live only in a private index; the agent never sees them as data | Agent can't re-check comments after compaction; context = the only carrier | Annotations also persisted to a **sidecar file** next to the plan (`.comments.json`), read by the agent like any file |
| Mode swaps replace the system prompt mid-session | System prompt change invalidates the whole prefix cache | No system-prompt mutation. The "architect" instructions ship as a **skill / prompt template** invoked by the plan flow, or as a static `promptGuidelines` registered once at startup |
| Fresh per-round instructions wording each round | Wasted prefix churn | Keep the revision-request message **byte-identical modulo path/counts** — same shape every round so the deltas stay minimal |

Cache rule of thumb used throughout: **the transcript carries pointers, files carry
payloads**. The plan, the comments, and the approved-plan reference are all files; messages
name them. The agent's own `read`/`edit` tool results are where big content belongs — Pi
already handles that, and re-reads only happen when the file changed.

## 3. Storage layout (cmdc's model, Pi-ified paths)

```
.pi/plans/                          # project-local (default); ~/.pi/agent/plans/ as global fallback
├── plans-index.json                # metadata: title, status, version, sessionId, updatedAt
├── <name>.md                       # the plan — agent edits this file directly
├── <name>.comments.json            # NEW (Pi-native): [{line, text, createdAt}] — agent-readable
└── versions/<name>-v{n}.md         # snapshot before each revision round (diff highlighting)
```

- Keep cmdc's index JSON shape for the UI (titles, statuses, versions, updatedAt ordering).
- The sidecar `.comments.json` is the only addition: same data the UI holds, exposed where
  the agent can read it. It is written when comments are pinned/submitted and deleted (or
  emptied) when the revision round closes, so "no comments" is always unambiguous.
- Statuses: `pending` → `approved` / `not-implemented` (set aside), same as cmdc.

## 4. The loop (review → revise → re-review)

```
UI: Submit review (N comments)
  ├─ 1. snapshot version: versions/<name>-v{v}.md  (index version+1)
  ├─ 2. write <name>.comments.json
  ├─ 3. close custom() → done()
  └─ 4. pi.sendUserMessage(
         "Plan review feedback for .pi/plans/<name>.md (v{v+1} requested): "
       + "{N} comments in .pi/plans/<name>.comments.json. "
       + "Read both, address every comment, update the plan file in place. "
       + "Then invoke /plan-review to present it again.",
         { deliverAs: "followUp" | trigger if idle })
  └─ 5. agent re-reads plan (cache-invalidates only at its read), edits file,
        calls the review entrypoint again → reader reopens, changed lines green
        (diff vs versions/<name>-v{v}.md), round counter = version - 1

UI: Approve / Execute plan
  ├─ comments kept? → append them as "non-blocking notes" in .comments.json (cleared file otherwise)
  ├─ index status := approved
  └─ small message: "Plan approved: .pi/plans/<name>.md (v{v}). Execute it; the file is
     the source of truth." — no plan text in the message
```

Delivery mechanics: when the agent is idle, `pi.sendUserMessage` starts the turn directly;
while busy use `deliverAs: "followUp"`. The review entrypoint itself is a command
(`/plan-review`) and/or a tool the agent calls; either way it opens the same `custom()`
reader and awaits `done()`.

**Keeping the loop agent-discoverable (Pi philosophy: the agent should understand what the
user is doing):** the instruction text always states the full contract — where the plan
lives, where the comments live, what "done" means (update file in place, re-present).
That's one stable sentence the model sees every round; no hidden state it has to guess.

## 5. Extension skeleton

```
pi-plan-mode/
└── index.ts          # everything; split later only if it hurts
```

- `session_start`: ensure dirs, nothing else (no background resources).
- `registerCommand("plan-review")` → open reader via `ctx.ui.custom()` (v1 entrypoint).
- Later, optionally: a `plan_review` tool registered once at startup (stable tool list —
  registering at startup keeps the prefix cacheable; do NOT dynamically activate it).
- No `before_agent_start` system-prompt rewriting. If plan-mode prompt steering is wanted,
  use a skill the flow invokes — skills are content in user/tool context, not prefix churn.

## 6. Ordering (lazy-first)

1. Pure reader core: rows / wrap / cursor ops (02-plan-reader-tui.md §10, items 1–5) +
   assert-based self-check.
2. Storage module: index + versions + sidecar (~80 lines).
3. `custom()` reader: render pass + keys, approve/submit wired to storage.
4. Loop: sendUserMessage revision round + reopen-on-complete with diff.
5. `/plans` browser (reuse rows) — last.

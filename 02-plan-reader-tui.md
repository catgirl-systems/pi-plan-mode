# 03 — The plan mode TUI

Stack: Ink 7 (React 19) + chalk + figures (`gt` = figures package: `pointer` "❯",
`tick` "✔", `bullet` "•", `circle` "◯", `circleDotted` "◌", `dot`, `triangleLeftSmall` "◀",
`triangleRightSmall` "▶") + a custom wrapped-text engine (grapheme-aware via
`Intl.Segmenter`, with hang-indent continuation).

## Theme (dark) — relevant constants

```js
PALETTE = { CYAN:"#7AD4D6", GREEN:"#2EBD8E", GRAY:"#8A94A8", WHITE:"#E5E5E5",
            YELLOW:"#F5B731", RED:"#E84057", BLUE:"#5945B1", MAGENTA:"#F2608A",
            DIM:"#8A94A8", DIMMER:"#4C556A", DIMMEST:"#353D50" }
ACCENT           = "#E4CCFF"   // nA; selection text / active titles (qR/VR = ACCENT)
PLAN_MODE_COLOR  = "#F5B731"   // hA — "plan mode" indicator (light theme: #92600A)
ACCEPT_EDITS_COLOR = "#8367F4" // fA  — "» accept edits on"
HIGHLIGHT_BAR_BG = "#2D2B55"   // EA — selection background
TASTE_COLORS     = { BADGE_BG:"#08575B", BADGE_FG:"#f4f4f4" }  // rA badges (REVIEW badge etc.)
MARKDOWN_COLORS  = { CODE:"#B1BAF9", HEADING:"#A599E9" }       // wA
```

## 1. Mode indicator (bottom of input area) — `ModeIndicator` (UA)

Renders above/below the prompt, per current mode:

```
bypass:       » permission bypass on        (RED)
auto-accept:  » accept edits on             (ACCEPT_EDITS purple)
plan:         plan mode                     (PLAN_MODE yellow, no "»")
dont-ask:     » don't-ask on                (PLAN_MODE yellow)
default:      ? for shortcuts               (DIM)
```
Each is followed by a dim bracket-wrapped shortcut hint (shift+tab hint).
`pendingExitKey` (Ctrl+C twice) replaces it with dim "Press Ctrl+C again to exit".

## 2. Question panel (`_N`) — the in-feed approval dialog

When `exit_plan_mode`/`enter_plan_mode`/`ask_user_question` fires, a question panel is
pushed into the feed. For plan questions it renders **before the options**:

```jsx
<PlanPanel content={planContent} filePath={planFilePath} expanded={expanded} />
```

`PlanPanel` (in-feed, collapsed by default):
- Framed panel titled **"Plan"** + ` · <basename>` suffix; renders plan as Markdown
  (marked + marked-terminal).
- Collapsed to `getCollapsedPlanMaxLines(stdout.rows)` lines with dim hint
  `… +N more lines · ctrl+o to expand` (ctrl+o toggles; also disabled when a plan-approval
  question is up).
- Trim uses `trimPlanMarkdown` (keeps headings balanced).

Tab indicator row: questions get `◯/● header | ◯/● header | ... | ◯ Review` — bullet for
current, tick for answered, ACCENT color for the active one. The review page shows
`1. Submit` / `2. Cancel` options with `[✔]`-style multi-select checkboxes elsewhere.

Keybindings: `app.tools.expand` (ctrl+o) toggles expansion; ctrl+e/ctrl+y cycles the
tool-calls expand mode ("off"/"limited"/"full") but is suppressed when a plan-approval
question is up (guard `if (H?.params.planContent) return`).

Esc while a plan question is up → reject with "Question cancelled by user".

## 3. Full-screen overlay machinery

`askQuestion` with `planContent`/`planFilePath` + `exitPlanMode:true` routes to a
**full-screen view** replacing the whole app (overlay dispatcher in the root component):

- `PlanApprovalView` — plan review in "approval" variant.
- `PlansView` — the `/plans` browser (also full-screen).

`CR` (named "Responsive") is the remount trick: keyed `<Static>`-like item emitting a `"\0"`
text with the staticKey — combined with `hardResetForResize()` (clears terminal, resets Ink
lastOutput internals) every full-screen view fully redraws and survives resize cleanly.

## 4. PlanReader (`mF`) — the star of the show

Props: `{plan, variant: "browse"|"approval", fallbackContent, onBack, onSubmitFeedback,
onExecute, onAutoAccept}`. Renders inside the shared overlay frame `ZR` ("Overlay"):

```
──────────────────────────────────────────────          <- AA divider (ruleColor DIMMER)
Plan review: My Plan · ~/.commandcode/plans/my-plan.md · v3  [✔ approved|◌ set aside|• pending]
Review the plan like a PR — type on any line to comment, enter pins it under the line.
<body: scrollable reader>
══════════════════════════════════════════════
REVIEW   2 pending comments · round 2 · 5 lines changed
  ❯ Submit review (2)        ctrl+r   agent revises the plan, returns it for review
    Execute plan             ctrl+e   executes the plan as written        (browse)
    Approve                  ctrl+a   executes the plan (approval)        (approval)
    Back / Cancel            esc
<italic dim footer: keybinding hints>
```

Title = `Plan review: <title>` in approval variant, plain title in browse variant; suffix
always shows shortened home path (`~/...`), ` · v<version>`, and the status badge
(colored label: `✔ approved` green, `◌ set aside` yellow, `• pending` dim).

### Rows model

```ts
type Row = { kind:"line", lineNumber, text, hasAnnotation }
          | { kind:"annotation", lineNumber, text }      // pinned comment, rendered under its line
          | { kind:"action", id, label, description? }
buildPlanReaderRows({lines, annotations, actions})       // lines+inline comments, then actions
```

Display: each row is wrapped by `wrapPlanText` into display rows (`buildPlanReaderRows` →
`buildPlanReaderDisplayRows`); width = `resolvePlanWrapWidth(termWidth-7-2)` (clamped
20–60, 80 max→80). Actions occupy one row each. Annotations wrap at width-3.

### Cursor model

```ts
type Cursor = { kind:"line", lineNumber } | { kind:"action", id }
```
- `movePlanReaderCursor`: ↑/↓ walks lines 1..N; from last line, down moves to first action;
  from first action, up moves to line N. On an action, ↑/↓ also moves between actions.
- `movePlanReaderCursorByPage`: PgUp/PgDn moves the cursor by `pageRows` **display rows**
  (uses `getPlanReaderCursorDisplaySpan` to find the cursor's first/last display row, moves
  ±pageRows, snaps back to the row's logical line; cursor parked on an action stays put on PgUp).
- Home/End → line 1 / last line. `snapPlanReaderCursor` clamps after content changes.
- Scroll: `clampScrollOffset` keeps both cursor span endpoints visible; body height =
  `terminalHeight - 1 (frame gaps) - 10 - 7` approx (B = max(4, H-10-7)); the actions/footer
  block accounts for the -7.

### Line rendering

```
"  12 " (DIMMER, 4-wide right-aligned, first segment only)  +  "• " (CYAN if annotated, else "  ")
+ line text
```
- Selected line: `backgroundColor = HIGHLIGHT_BAR_BG` (whole row incl. segments).
- **Changed lines** (vs previous version snapshot): GREEN (diff highlight), fetched via
  `readPlanVersionSnapshot(version-1)` + `diffPlanChangedLines`.
- Markdown-aware styling per line (`classifyPlanLines` + `lineStyleProps`):
  - headings (level = `#` count): HEADING color, bold
  - inside ``` fences / code: CODE color (light blue)
  - `>` quotes: DIM italic; tables: CYAN; bullets/text: WHITE
- **Inline annotation** rows: `  ↳ <text> ` with `backgroundColor BADGE_BG` (teal badge),
  white text, dimmer indent gutter; shown only while its line is selected?? — no: rendered
  under its line always; cursor draft replaces it.

### Commenting (the cool part)

- Any printable key while on a line opens a draft: `TextInput` rendered in place:
  `┃ • <input>` in CYAN, placeholder "Type your comment…", bracketed paste stripped.
- Draft hints: `enter to pin · esc discard` (new) / `enter to keep · clear + enter removes ·
  esc keep as was` (editing existing).
- Enter → `upsertPlanAnnotation` + persist (`setPlanAnnotations` → index; errors surface
  "Failed to save comments to disk" in yellow).
- **Quick comments** (`uF` map) typed directly and pinned immediately:
  - `?` → "Why? Explain the reasoning behind this."
  - `x` → "Cut this — remove it from the plan."
  - `!` → "Risky — double-check this before implementing."
  (typing the same char again on an annotated line toggles/clears it)
- `ctrl+g` → open plan file in `$EDITOR` (`openFileInEditor`), reload lines on return.
- `ctrl+n` / `ctrl+p` → jump to next/previous *marked* line (union of annotated lines +
  changed lines), wrapping around. Hint reads "ctrl+n/p jump changes|comments" depending on
  which set is non-empty.

### Action bar (bottom, below a divider)

Status line: bold white-on-BADGE_BG ` REVIEW ` badge + dim
`N pending comments · round R · M lines changed` (round = plan version - 1; only when >1;
changed count only when >0).

Actions (`L`): variant-dependent:
- browse:  `Submit review (N)` (CYAN, ctrl+r, "agent revises the plan, returns it for review")
           — only when N>0; `Execute plan` (GREEN, ctrl+e); `Back` (YELLOW, esc).
- approval: `Submit review (N)` (ctrl+r) when N>0; `Approve` (GREEN, ctrl+a,
  hint "executes the plan · comments go along as notes" when N>0); `Cancel` (esc).

`Submit review` → snapshot version, persist+clear annotations, exit overlay, and send
`buildPlanAnnotationsPrompt` as a user message (`onSubmitFeedback`).

`Approve` in approval variant with N>0 → sub-menu:
```
Approve  (•) with N comments as notes   (GREEN heading; radio via ←/→/Tab)
         ( ) original plan · discard comments
```
←/→/tab toggles choice, enter confirms, esc back. "with notes" sends
`buildPlanApprovalNotesPrompt` as the auto-accept message; "original" discards comments.
Approve with no comments → straight `onAutoAccept()`. A pending auto-accept note (the user
can type a note that is sent alongside "Yes, auto-accept edits") exists in PlanApprovalView
via `onAutoAccept(text?)`.

Cancel with pending comments and no filePath → confirm "Discard N pending comments and exit
review?" (YELLOW). Otherwise straight back.

Footer hint lines (italic dim), by state:
- idle browse: `type + enter to comment · ctrl+n/p jump comments|changes · quick: ? why  x cut  ! risky · ctrl+g $EDITOR`
- action focused: `↑/↓ choose · enter to run`
- draft: `enter to pin · esc discard`
- approve submenu: `←/→ choose · enter confirm · esc back`

### Loading/empty states
`null` plan → dim "Loading plan..."; zero lines → dim "Plan file is empty or missing on disk."

## 5. PlanApprovalView

Thin wrapper: resolves the plan's metadata from `listPlans` by filePath (fallback: derive
title from content + filename, status "pending"), then renders `PlanReader` in
**approval** variant with `fallbackContent = planContent` (the string from the tool call
when no file exists). Used by both `exit_plan_mode` (in plan mode) and `plan_review`.

## 6. PlansView — the `/plans` browser

Frame `ZR`: title **"Plans"**, titleSuffix ` N plans`, subtitle tab toggle:
```
This session ◀▶ All plans       (bold ACCENT for active tab, dim for inactive)
```
←/→ switch tabs; ↑/↓ navigate; type-to-search (query input at top, filters by
title/fileName substring); footer: `type to search · ↑/↓ navigate · ←/→ switch tab · enter
to open · esc to close`.

List rows (windowed by terminal height, `x = H-1-9` visible, clampScrollOffset):
```
❯ <title>  <status label colored>  v3  2 comments  5m     (from PlansScreen row renderer)
```
- pointer `❯` ACCENT when selected, spaces otherwise; title bold ACCENT when selected.
- status: `✔ approved` GREEN / `◌ set aside` YELLOW / `• pending` DIM.
- `v<n>` DIM when version > 1; `N comment(s)` CYAN when > 0; relative time (dim,
  `formatRelativeTimeShort`).
- Empty states: session tab → "No plans in this session yet — use /plan or plan mode to
  create one. Press → for all plans." / all → "No saved plans yet — plans land in
  ~/.commandcode/plans when you use plan mode." / search → `No plans match "q"`.
- Enter → PlanReader (browse variant). From there `Execute plan` sends
  `buildPlanExecutePrompt`; if current mode is plan, mode is first switched to auto-accept.
- `plansTarget` supports `@last` (`/plan-review`) or a name/title match.

## 7. Keyboard map summary (plan reader)

| Key | Action |
|---|---|
| ↑/↓ | move cursor (lines ⇄ action buttons) |
| Home/End | first/last line |
| PgUp/PgDn | page by display rows |
| ←/→ | move between action buttons (when on one) |
| Enter | on line: open comment draft · on action: run it |
| any printable (on a line) | open comment draft |
| `?` / `x` / `!` (on a line) | pin canned comment instantly |
| ctrl+r | Submit review (send comments to agent) |
| ctrl+a | Approve (approval variant; with-comments → notes submenu) |
| ctrl+e | Execute plan (browse variant) |
| ctrl+n / ctrl+p | jump next/previous annotated-or-changed line |
| ctrl+g | open plan file in $EDITOR, reload after |
| esc | close / back / discard draft / cancel confirm |

## 7b. Scroll feel (important)

There is **no free scroll**. The viewport exists only to follow the cursor:

- ↑/↓ = cursor moves one *logical* line; window scrolls minimally so the cursor's full
  wrapped span stays visible (`clampScrollOffset` on both endpoints — a wrapped line never
  half-scrolls out).
- PgUp/PgDn = cursor teleports ±bodyRows *display rows* (wrapped segments, not logical
  lines), viewport snaps with it. On an action button, PgDn is a no-op.
- Home/End = line 1 / line N.

So scrolling is a side effect of cursor motion — one code path (`clampScrollOffset`)
serves arrows, paging, and content changes. Recreate exactly this; don't add a scrollbar
or wheel-scroll mode.

## 8. Geometry (exact numbers)

Everything is derived from `terminalHeight H` and `terminalWidth W`:

```
PlanReader (mF):
  wrapWidth    = resolvePlanWrapWidth(W - 7 - 2)     // clamp: <80 → 20..60, >=80 → 80
  bodyRows     = max(4, (H - 1) - 10 - 7)            // B; 17 rows reserved for chrome
  draftReserve = draftOpen ? 1 : 0                   // W flag, shrinks viewport while typing
  scrollWindow = [offset, offset + bodyRows - draftReserve)
  chrome(7)    = divider + REVIEW line + ~3 actions + margin

PlansView:
  listRows     = max(3, (H - 1) - 9)

PlanPanel (in-feed, collapsed):
  maxLines     = getCollapsedPlanMaxLines(stdout.rows)

Line gutter   = 4-wide right-aligned number + 1 space
Annot gutter  = bullet col ("• " cyan if annotated, else "  ")
Selection     = backgroundColor HIGHLIGHT_BAR_BG on the whole row
Annotation row= wraps at wrapWidth - 3, badge bg " ↳ text "
```

Scroll clamping (`clampScrollOffset({cursor, total, maxVisible, currentOffset})`): minimal
scroll so the cursor stays in the window; applied to both endpoints of the cursor's display
span (first/last wrapped segment), so a wrapped line never half-scrolls out of view.

## 9. Reader state machine

```
        ┌───────── esc ──────────────────────────────┐
        │                                            ▼
   ┌─ BROWSING ─┐  printable on line   ┌─ DRAFT ─┐   │
   │ cursor over│ ───────────────────► │ text in │   │ enter pins /
   │ line/action│ ◄─────── esc ─────── │ place   │───┘ clears(+enter)
   └─│──┬──┬──┬─┘                      └─────────┘
     │  │  │  │ enter on action
     │  │  │  └────────────► ACTION (submit/approve/execute/back)
     │  │  └─── ctrl+g ──► EDITOR ($EDITOR open, busy flag; reload lines after)
     │  └─────── ctrl+a ─► APPROVE_CHOICE (approval variant, N>0 comments)
     │                     ┌ with notes / original ←→ : ←/→ or tab
     │                     └ enter: onAutoAccept(notes?) ; esc: back to BROWSING
     └──────── N>0 && !filePath & esc ► CONFIRM_DISCARD (yellow, enter=yes esc=back)

   Submit review → snapshotVersion() → persist+clear annotations → done(prompt)
   Annotation state is optimistic in-memory ("dirty" flag blocks a re-sync effect
   from clobbering it: `u || d(e.annotations)`).
```

Cursor invariants after any content change (`snapPlanReaderCursor`): clamp line into
1..N; if cursor is on an action that no longer exists (e.g. Submit review disappears when
comments are cleared), fall back to last line.

## 10. Component decomposition for reimplementation

Framework-free decomposition (all pure string→rows→styled-text):

1. `buildPlanReaderRows(lines, annotations, actions)` → logical rows
2. `classifyPlanLines(lines)` → per-line markdown role (fence state machine, one boolean)
3. `wrapPlanText(text, width)` → display rows (grapheme-aware; any terminal wrap lib works)
4. `buildPlanReaderDisplayRows(rows, width)` → flat display rows + firstSegment flag
5. cursor ops (move / page / snap) — pure functions, unit-testable without a TUI
6. render pass: display-row slice + gutter + selection bg + annotation rows + draft input
7. action bar + footer hints

Everything above the render pass (1–5) is a pure module; only 6–7 touch the TUI.


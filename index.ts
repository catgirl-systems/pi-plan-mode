// pi-plan-mode — plan review reader for pi (extension).
//
// UX ported from command-code v1.54.0's PlanReader (see notes/02-plan-reader-tui.md):
// full-screen line-addressed plan review with inline comments, version diffing, and a
// revise/re-review loop. Backend is Pi-native: files carry payloads, the transcript
// carries pointers (notes/03-pi-extension-design.md).

import { Type } from "typebox";
import { constants, realpathSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildPlanReaderDisplayRows,
	buildPlanReaderRows,
	sanitizePlanText,
	classifyPlanLines,
	clampScrollOffset,
	diffPlanChangedLines,
	getPlanReaderCursorDisplaySpan,
	jumpMarked,
	markedLines,
	movePlanReaderCursor,
	movePlanReaderCursorByPage,
	snapPlanReaderCursor,
	upsertPlanAnnotation,
	type Annotation,
	type Cursor,
	type DisplayRow,
	type LineRole,
} from "./src/reader-core.ts";
import {
	defaultPlansDir,
	listPlans,
	readPlanContent,
	readPlanVersionSnapshot,
	snapshotPlanVersion,
	recordPlanOutcome,
	setPlanAnnotations,
	writeComments,
	clearComments,
	commentsPathFor,
	type PlanEntry,
} from "./src/plan-store.ts";
import { findBlockedCommandSegment, readCommand } from "./src/shell-policy.ts";

// ---------- config ----------

const QUICK_COMMENTS: Record<string, string> = {
	"?": "Why? Explain the reasoning behind this.",
	x: "Cut this — remove it from the plan.",
	"!": "Risky — double-check this before implementing.",
};

type Variant = "browse" | "approval";

type ReaderResult =
	| { kind: "submit"; newVersionRequested: true; annotations: Annotation[] }
	| { kind: "execute"; annotations: Annotation[] }
	| { kind: "approve"; annotations: Annotation[] }
	| { kind: "fresh"; annotations: Annotation[] }
	| { kind: "cancel" };

interface ReaderTheme {
	dim(s: string): string;
	accent(s: string): string;
	success(s: string): string;
	warning(s: string): string;
	heading(s: string): string;
	code(s: string): string;
	selected(s: string): string;
}

function makeTheme(t: { fg(color: string, s: string): string; bg(color: string, s: string): string }): ReaderTheme {
	return {
		dim: (s) => t.fg("dim", s),
		accent: (s) => t.fg("accent", s),
		success: (s) => t.fg("success", s),
		warning: (s) => t.fg("warning", s),
		heading: (s) => t.fg("mdHeading", s),
		code: (s) => t.fg("mdCode", s),
		selected: (s) => t.bg("selectedBg", s),
	};
}

// ---------- component ----------

interface ReaderAction {
	id: "feedback" | "execute" | "auto-accept" | "fresh" | "cancel";
	label: string;
	chord: string;
	hint: string;
}

class PlanReader implements Component, Focusable {
	private tui: { requestRender: () => void };
	private theme: ReaderTheme;
	private variant: Variant;
	private dir: string;
	private allowFresh: boolean;
	private filePath: string;
	private title: string;
	private version: number;
	private done: (result: ReaderResult) => void;

	private lines: string[] = [];
	private roles: LineRole[] = [];
	private annotations: Annotation[];
	private changed = new Set<number>();
	private loaded = false;
	private actions: ReaderAction[] = [];

	private cursor: Cursor = { kind: "line", lineNumber: 1 };
	private draft: { line: number; input: Input } | null = null;
	private approveMode = false;
	private approveChoice: "notes" | "original" = "notes";
	private status: string | null = null;
	private scrollOffset = 0;
	private rowsEpoch = 0;

	private displayRows: DisplayRow[] = [];
	private displayEpoch = -1;
	private displayWidth = -1;
	private renderWidth = 80;

	// Focusable: propagate to the draft input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		if (this.draft) this.draft.input.focused = v;
	}

	constructor(opts: {
		tui: { requestRender: () => void };
		theme: { fg(color: string, s: string): string; bg(color: string, s: string): string };
		variant: Variant;
		dir: string;
		allowFresh?: boolean;
		plan: { filePath: string; title: string; version?: number; annotations: Annotation[] };
		done: (result: ReaderResult) => void;
	}) {
		this.allowFresh = opts.allowFresh ?? false;
		this.tui = opts.tui;
		this.theme = makeTheme(opts.theme);
		this.variant = opts.variant;
		this.dir = opts.dir;
		this.filePath = opts.plan.filePath;
		this.title = sanitizePlanText(opts.plan.title);
		this.version = opts.plan.version ?? 1;
		this.annotations = opts.plan.annotations.map((a) => ({ ...a, text: sanitizePlanText(a.text) }));
		this.done = opts.done;
		this.rebuildActions();
		void this.load();
	}

	private async load(): Promise<void> {
		const content = (await readPlanContent(this.filePath)) ?? "";
		this.lines = content.replace(/\r\n/g, "\n").split("\n").map(sanitizePlanText);
		this.roles = classifyPlanLines(this.lines);
		if (this.version > 1) {
			const prev = await readPlanVersionSnapshot({
				filePath: this.filePath,
				dir: this.dir,
				version: this.version - 1,
			});
			if (prev) this.changed = diffPlanChangedLines({ previous: prev, current: this.lines });
		}
		this.loaded = true;
		this.rowsEpoch++;
		this.cursor = snapPlanReaderCursor({ cursor: this.cursor, lineCount: this.lineCount(), actions: [] });
		this.tui.requestRender();
	}

	private lineCount(): number {
		return this.lines.length;
	}

	private commentCount(): number {
		return this.annotations.length;
	}

	private rebuildActions(): void {
		const n = this.commentCount();
		const submit: ReaderAction = {
			id: "feedback",
			label: `Submit review (${n})`,
			chord: "ctrl+r",
			hint: "agent revises the plan, returns it for review",
		};
		this.actions =
			this.variant === "approval"
				? [
						...(n > 0 ? [submit] : []),
						{ id: "auto-accept", label: "Approve", chord: "ctrl+a", hint: n > 0 ? "executes the plan · comments go along as notes" : "executes the plan" },
						...(this.allowFresh ? [{ id: "fresh" as const, label: "Start fresh", chord: "ctrl+f", hint: "new session with only the approved plan" }] : []),
						{ id: "cancel", label: "Cancel", chord: "esc", hint: "" },
					]
				: [
						...(n > 0 ? [submit] : []),
						{ id: "execute", label: "Execute plan", chord: "ctrl+e", hint: "executes the plan as written" },
						{ id: "cancel", label: "Back", chord: "esc", hint: "" },
					];
	}

	private bodyRows(): number {
		const h = process.stdout.rows ?? 28;
		return Math.max(4, h - 1 - 10 - 7);
	}

	// ---------- key handling ----------

	handleInput(data: string): void {
		if (this.approveMode) {
			if (matchesKey(data, Key.escape)) {
				this.approveMode = false;
			} else if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
				this.approveChoice = this.approveChoice === "notes" ? "original" : "notes";
			} else if (matchesKey(data, Key.enter)) {
				const annotations = this.approveChoice === "notes" ? this.annotations : [];
				this.done({ kind: "approve", annotations });
				return;
			}
			this.tui.requestRender();
			return;
		}
		if (this.draft) {
			this.draft.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		const onAction = this.cursor.kind === "action";
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			this.cursor = movePlanReaderCursor({
				cursor: this.cursor,
				direction: matchesKey(data, Key.up) ? "up" : "down",
				lineCount: this.lineCount(),
				actions: this.actions,
			});
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			const down = matchesKey(data, Key.pageDown);
			if (!(onAction && down)) {
				this.cursor = movePlanReaderCursorByPage({
					displayRows: this.getDisplayRows(),
					cursor: this.cursor,
					direction: down ? "down" : "up",
					pageRows: Math.max(1, this.bodyRows() - 1),
				});
			}
		} else if (matchesKey(data, Key.home)) {
			if (this.lineCount() > 0) this.cursor = { kind: "line", lineNumber: 1 };
		} else if (matchesKey(data, Key.end)) {
			if (this.lineCount() > 0) this.cursor = { kind: "line", lineNumber: this.lineCount() };
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const cur = this.cursor;
			if (cur.kind === "action") {
				const idx = this.actions.findIndex((a) => a.id === cur.id);
				if (idx !== -1) {
					const next = this.actions[matchesKey(data, Key.left) ? Math.max(0, idx - 1) : Math.min(this.actions.length - 1, idx + 1)];
					if (next) this.cursor = { kind: "action", id: next.id };
				}
			}
		} else if (matchesKey(data, Key.ctrl("r"))) {
			this.runAction("feedback");
		} else if (matchesKey(data, Key.ctrl("a"))) {
			this.runAction("auto-accept");
		} else if (matchesKey(data, Key.ctrl("e"))) {
			this.runAction("execute");
		} else if (matchesKey(data, Key.ctrl("f"))) {
			this.runAction("fresh");
		} else if (matchesKey(data, Key.ctrl("n")) || matchesKey(data, Key.ctrl("p"))) {
			const next = jumpMarked({
				marked: markedLines(this.annotations, this.changed),
				from: this.cursor.kind === "line" ? this.cursor.lineNumber : undefined,
				direction: matchesKey(data, Key.ctrl("n")) ? "next" : "previous",
				lineCount: this.lineCount(),
			});
			if (next !== undefined) this.cursor = { kind: "line", lineNumber: next };
		} else if (matchesKey(data, Key.ctrl("g"))) {
			void this.openExternalEditor();
		} else if (matchesKey(data, Key.escape)) {
			this.done({ kind: "cancel" });
			return;
		} else if (matchesKey(data, Key.enter)) {
			const cur = this.cursor;
			const act = cur.kind === "action" ? this.actions.find((a) => a.id === cur.id) : undefined;
			if (act) this.runAction(act.id);
			else this.openDraft("");
		} else if (this.cursor.kind === "line" && isPrintable(data)) {
			const quick = QUICK_COMMENTS[data];
			if (quick) {
				const existing = this.annotations.find((a) => a.line === (this.cursor as { lineNumber: number }).lineNumber);
				this.persist(
					upsertPlanAnnotation({
						annotations: this.annotations,
						line: (this.cursor as { lineNumber: number }).lineNumber,
						text: existing?.text === quick ? "" : quick,
						createdAt: new Date().toISOString(),
					}),
				);
			} else {
				this.openDraft(data);
			}
		}
		this.followCursor();
		this.tui.requestRender();
	}

	private runAction(id: ReaderAction["id"]): void {
		if (id === "feedback") {
			if (this.commentCount() > 0) this.done({ kind: "submit", newVersionRequested: true, annotations: this.annotations });
		} else if (id === "execute") {
			this.done({ kind: "execute", annotations: this.annotations });
		} else if (id === "auto-accept") {
			if (this.commentCount() > 0) {
				this.approveMode = true;
				this.approveChoice = "notes";
			} else {
				this.done({ kind: "approve", annotations: [] });
			}
		} else if (id === "fresh") {
			this.done({ kind: "fresh", annotations: this.annotations });
		} else if (id === "cancel") {
			this.done({ kind: "cancel" });
		}
	}

	private async openExternalEditor(): Promise<void> {
		const { default: openEditor } = await import("open-editor");
		await openEditor([{ file: this.filePath }]);
		const content = (await readPlanContent(this.filePath)) ?? "";
		this.lines = content.replace(/\r\n/g, "\n").split("\n");
		this.roles = classifyPlanLines(this.lines);
		this.rowsEpoch++;
		this.cursor = snapPlanReaderCursor({ cursor: this.cursor, lineCount: this.lineCount(), actions: [] });
		this.tui.requestRender();
	}

	private openDraft(initial: string): void {
		const line = (this.cursor as { lineNumber: number }).lineNumber;
		const input = new Input({ placeholder: "Type your comment…" });
		if (initial) {
			input.setValue(initial);
			// setValue leaves the cursor at 0; walk it to the end so typing appends
			for (let i = 0; i < initial.length; i++) input.handleInput("\x1b[C");
		}
		input.onSubmit = (value: string) => {
			this.persist(
				upsertPlanAnnotation({
					annotations: this.annotations,
					line,
					text: value,
					createdAt: new Date().toISOString(),
				}),
			);
			this.draft = null;
			this.tui.requestRender();
		};
		input.onEscape = () => {
			this.draft = null;
			this.tui.requestRender();
		};
		this.draft = { line, input };
		input.focused = this._focused;
	}

	private persist(annotations: Annotation[]): void {
		this.annotations = annotations;
		this.rebuildActions();
		this.rowsEpoch++;
		// lastPersist lets tests (and future callers) await the write deterministically
		this.lastPersist = setPlanAnnotations({ filePath: this.filePath, dir: this.dir, annotations })
			.then(() => {
				this.status = null;
			})
			.catch(() => {
				this.status = "Failed to save comments to disk";
			});
	}

	lastPersist: Promise<void> = Promise.resolve();

	private followCursor(): void {
		const all = this.getDisplayRows();
		const span = getPlanReaderCursorDisplaySpan({ displayRows: all, cursor: this.cursor });
		if (span.first === -1) return;
		const draftReserve = this.draft ? 1 : 0;
		const visible = Math.max(1, this.bodyRows() - draftReserve);
		for (const row of [span.first, span.last]) {
			this.scrollOffset = clampScrollOffset({ row, total: all.length + draftReserve, maxVisible: visible, currentOffset: this.scrollOffset });
		}
	}

	private getDisplayRows(): DisplayRow[] {
		if (this.displayEpoch === this.rowsEpoch && this.displayWidth === this.renderWidth) {
			return this.displayRows;
		}
		const rows = buildPlanReaderRows({ lines: this.lines, annotations: this.annotations, actions: this.actions });
		const wrapWidth = resolveWrapWidth(this.renderWidth);
		this.displayRows = buildPlanReaderDisplayRows({ rows, width: wrapWidth });
		this.displayEpoch = this.rowsEpoch;
		this.displayWidth = this.renderWidth;
		return this.displayRows;
	}

	// ---------- rendering ----------

	render(width: number): string[] {
		this.renderWidth = width;
		const out: string[] = [];
		const isApproval = this.variant === "approval";

		// title
		const suffix = ` · ${shortenHome(this.filePath)} · v${this.version}`;
		out.push(truncateToWidth(`${bold(this.theme.accent(`${isApproval ? "Plan review: " : ""}${this.title}`))}${this.theme.dim(suffix)}`, width));

		if (!this.loaded) {
			out.push(this.theme.dim("Loading plan..."));
			return out;
		}
		if (this.lines.length === 0) {
			out.push(this.theme.dim("Plan file is empty or missing on disk."));
			return out;
		}

		// body
		const all = this.getDisplayRows();
		const draftReserve = this.draft ? 1 : 0;
		const visible = Math.max(1, this.bodyRows() - draftReserve);
		const start = Math.min(this.scrollOffset, Math.max(0, all.length - visible));
		let draftRendered = false;
		for (const dr of all.slice(start, start + visible)) {
			const { row } = dr;
			if (row.kind === "action") continue;
			if (row.kind === "annotation") {
				out.push(truncateToWidth(`${" ".repeat(5)}${this.theme.accent(`↳ ${dr.text}`)}`, width));
				continue;
			}
			const selected = this.cursor.kind === "line" && this.cursor.lineNumber === row.lineNumber;
			const gutter = (dr.isFirstSegment ? String(row.lineNumber).padStart(4, " ") : "    ") + " ";
			const bulletCol = dr.isFirstSegment && row.hasAnnotation ? `${this.theme.accent("•")} ` : "  ";
			let line = `${this.theme.dim(gutter)}${bulletCol}${this.styleLine(dr, row.lineNumber)}`;
			if (selected) line = this.theme.selected(padTo(line, width));
			out.push(truncateToWidth(line, width));
			if (this.draft?.line === row.lineNumber && isLastSegmentOf(all, dr)) {
				draftRendered = true;
				for (const il of this.draft.input.render(width - 6)) {
					out.push(truncateToWidth(`   ${this.theme.accent("┃ •")} ${il}`, width));
				}
			}
		}
		if (this.draft && !draftRendered) {
			for (const il of this.draft.input.render(width - 6)) {
				out.push(truncateToWidth(`   ${this.theme.accent("┃ •")} ${il}`, width));
			}
		}

		// divider + review bar
		out.push(this.theme.dim("─".repeat(Math.max(1, width))));
		const n = this.commentCount();
		const changedNote = this.changed.size > 0 ? ` · ${this.changed.size} line${this.changed.size === 1 ? "" : "s"} changed` : "";
		const roundNote = this.version > 1 ? ` · round ${this.version - 1}` : "";
		out.push(`${bold(this.theme.success(" REVIEW "))}${this.theme.dim(`${n > 0 ? ` ${n} pending comment${n === 1 ? "" : "s"} ·` : ""}${roundNote}${changedNote}`)}`);

		// actions (or approve submenu)
		if (this.approveMode) {
			const radio = (choice: "notes" | "original") => (choice === this.approveChoice ? this.theme.accent("(•)") : this.theme.dim("( )"));
			out.push(`${bold(this.theme.success("Approve"))} ${radio("notes")} with ${n} comment${n === 1 ? "" : "s"} as notes   ${radio("original")} original plan · discard comments`);
		} else {
			for (const a of this.actions) {
				const sel = this.cursor.kind === "action" && this.cursor.id === a.id;
				const label = sel ? `${bold(this.theme.accent(`❯ ${a.label}`))} ` : `${a.label} `;
				const hint = a.hint ? `   ${this.theme.dim(a.hint)}` : "";
				out.push(truncateToWidth(`${label} ${this.theme.dim(a.chord)}${hint}`, width));
			}
		}
		if (this.status) out.push(this.theme.warning(this.status));

		// footer
		out.push(this.theme.dim(italic(this.footerHint())));
		if (this.draft) this.draft.input.focused = this._focused;
		return out;
	}

	private footerHint(): string {
		if (this.approveMode) return "←/→ choose · enter confirm · esc back";
		if (this.draft) return "enter to pin · esc discard";
		if (this.cursor.kind === "action") return "↑/↓ choose · enter to run";
		const marked = markedLines(this.annotations, this.changed);
		return [
			"type + enter to comment",
			...(marked.length > 0 ? [`ctrl+n/p jump ${this.changed.size > 0 ? "changes" : "comments"}`] : []),
			"quick: ? why  x cut  ! risky",
			"ctrl+g $EDITOR",
		].join(" · ");
	}

	private styleLine(dr: DisplayRow, lineNumber: number): string {
		if (this.changed.has(lineNumber)) return this.theme.success(dr.text);
		const role = this.roles[lineNumber - 1];
		switch (role?.role) {
			case "heading":
				return bold(this.theme.heading(dr.text));
			case "code":
			case "code-fence":
				return this.theme.code(dr.text);
			case "quote":
				return this.theme.dim(dr.text);
			case "table":
				return this.theme.accent(dr.text);
			default:
				return dr.text || " ";
		}
	}

	invalidate(): void {
		this.displayEpoch = -1;
	}
}

// ---------- helpers ----------

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data.charCodeAt(0) > 31 && data.charCodeAt(0) !== 127;
}

function resolveWrapWidth(termWidth: number): number {
	const w = Math.max(20, termWidth - 7 - 2);
	return w >= 80 ? 80 : Math.min(60, w);
}

function shortenHome(p: string): string {
	const home = process.env.HOME ?? "";
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function bold(s: string): string {
	return `\x1b[1m${s}\x1b[22m`;
}
function italic(s: string): string {
	return `\x1b[3m${s}\x1b[23m`;
}
function padTo(s: string, width: number): string {
	return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}
function isLastSegmentOf(all: DisplayRow[], dr: DisplayRow): boolean {
	const segments = all.filter((d) => d.row.kind === "line" && d.row.kind === dr.row.kind && d.row.lineNumber === dr.row.lineNumber);
	return segments.at(-1) === dr;
}

// ---------- planning state & tool policy ----------

let planningActive = false;

const PLANNING_READONLY_MESSAGE =
	"Blocked: planning is active — only read-only operations are allowed. Prefer the read/grep/find/ls tools; " +
	"bash runs reviewed read-only commands only. Finish the plan and call plan_review to present it " +
	"(the user can also run /plan off).";

// Default-deny for tools, with the read side explicitly listed. readSeek_* entries are
// this deployment's ReadSeek suite — only its read-oriented tools; readSeek_edit/write/
// rename stay blocked. subagent_consult spawns read-only scouts by contract.
const PLANNING_ALLOWED_TOOLS = new Set([
	"read", "grep", "find", "ls", "plan_review", "plan_mode_question", "subagent_consult",
	"readSeek_grep", "readSeek_search", "readSeek_view", "readSeek_digest", "readSeek_def", "readSeek_refs",
]);

// ---------- entry points ----------

const MAX_PLAN_BYTES = 262144;

/**
 * Containment for LLM-supplied plan_review filePaths: must resolve (symlinks followed
 * and checked) to a regular .md file inside the real plans dir, within the size cap.
 */
function containedPlanPath(plansDir: string, filePath: string): string | null {
	try {
		const realDir = realpathSync(plansDir);
		const realFile = realpathSync(filePath);
		if (!realFile.startsWith(realDir + "/")) return null;
		if (!realFile.endsWith(".md")) return null;
		const st = statSync(realFile);
		if (!st.isFile() || st.size > MAX_PLAN_BYTES) return null;
		return realFile;
	} catch {
		return null;
	}
}

async function openReaderOn(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	variant: Variant,
	dir: string,
	plan: PlanEntry,
	allowFresh: boolean,
): Promise<void> {
	const result = await ctx.ui.custom<ReaderResult>(
		(tui, theme, _keybindings, done) =>
			new PlanReader({
				tui,
				theme,
				variant,
				dir,
				allowFresh,
				plan: { filePath: plan.filePath, title: plan.title, version: plan.version, annotations: plan.annotations },
				done,
			}),
	);
	if (!result || result.kind === "cancel") return;

	if (result.kind === "submit") {
		const newVersion = await snapshotPlanVersion({ filePath: plan.filePath, dir });
		await writeComments(plan.filePath, result.annotations);
		await setPlanAnnotations({ filePath: plan.filePath, dir, annotations: [] });
		pi.sendUserMessage(revisionPrompt(plan.filePath, newVersion, result.annotations.length));
	} else if (result.kind === "execute") {
		await recordPlanOutcome({ filePath: plan.filePath, dir, status: "approved" });
		planningActive = false;
		pi.sendUserMessage(executePrompt(plan.filePath));
	} else if (result.kind === "fresh") {
		await recordPlanOutcome({ filePath: plan.filePath, dir, status: "approved" });
		planningActive = false;
		// fresh implementation: a new session carrying only the plan contract,
		// so planning's exploration never pollutes implementation context
		await ctx.newSession({
			withSession: async (fresh) => {
				await fresh.sendUserMessage(executePrompt(plan.filePath));
			},
		});
	}
	// approve has no meaning in browse variant; cancel: plan file stays saved
}

async function openReader(ctx: ExtensionCommandContext, pi: ExtensionAPI, variant: Variant, target?: string): Promise<void> {
	const dir = defaultPlansDir({ cwd: ctx.cwd, home: process.env.HOME ?? "" });
	const plans = await listPlans({ dir });
	if (plans.length === 0) {
		ctx.ui.notify("No saved plans yet — plans land in .pi/plans/ when you use plan mode.", "info");
		return;
	}
	const t = target?.trim().toLowerCase();
	const plan = t
		? (plans.find((p) => p.fileName.toLowerCase() === t || p.fileName.replace(/\.md$/, "").toLowerCase() === t || p.title.toLowerCase() === t) ?? plans[0]!)
		: plans[0]!;
	await openReaderOn(ctx, pi, variant, dir, plan, true);
}

function revisionPrompt(filePath: string, newVersion: number, count: number): string {
	const comments = commentsPathFor(filePath);
	return (
		`Plan review feedback for ${filePath} (v${newVersion} requested): ${count} comment${count === 1 ? "" : "s"} in ${comments}. ` +
		`Read both files, address every comment, and update the plan file in place. ` +
		`When done, delete the comments file and call plan_review again to present it for another review.`
	);
}

function executePrompt(filePath: string): string {
	return (
		`Execute the plan at ${filePath}. It is already approved — do not enter plan mode and do not re-present it. ` +
		`Read the plan file first, then implement it step by step, referring back to it as you work.`
	);
}

// ---------- plans browser ----------

const STATUS_BADGES: Record<PlanEntry["status"], string> = {
	approved: "✔ approved",
	"not-implemented": "◌ set aside",
	pending: "• pending",
};

function formatRelativeTimeShort(iso: string): string {
	const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (seconds < 60) return "now";
	const minutes = seconds / 60;
	if (minutes < 60) return `${Math.floor(minutes)}m`;
	const hours = minutes / 60;
	if (hours < 24) return `${Math.floor(hours)}h`;
	const days = hours / 24;
	if (days < 7) return `${Math.floor(days)}d`;
	return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

class PlansBrowser implements Component {
	private tui: { requestRender: () => void };
	private theme: ReaderTheme;
	private plans: PlanEntry[];
	private done: (filePath: string | null) => void;
	private selectedIndex = 0;
	private query = "";
	private scrollOffset = 0;

	constructor(opts: {
		tui: { requestRender: () => void };
		theme: { fg(color: string, s: string): string; bg(color: string, s: string): string };
		plans: PlanEntry[];
		done: (filePath: string | null) => void;
	}) {
		this.tui = opts.tui;
		this.theme = makeTheme(opts.theme);
		this.plans = opts.plans;
		this.done = opts.done;
	}

	private filtered(): PlanEntry[] {
		const q = this.query.trim().toLowerCase();
		if (!q) return this.plans;
		return this.plans.filter((p) => p.title.toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q));
	}

	private bodyRows(): number {
		const h = process.stdout.rows ?? 28;
		return Math.max(3, h - 1 - 9);
	}

	handleInput(data: string): void {
		const items = this.filtered();
		if (matchesKey(data, Key.escape)) {
			if (this.query) this.query = "";
			else return this.done(null);
		} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const delta = matchesKey(data, Key.up) ? -1 : 1;
			this.selectedIndex = Math.min(Math.max(0, this.selectedIndex + delta), Math.max(0, items.length - 1));
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			const delta = matchesKey(data, Key.pageUp) ? -this.bodyRows() : this.bodyRows();
			this.selectedIndex = Math.min(Math.max(0, this.selectedIndex + delta), Math.max(0, items.length - 1));
		} else if (matchesKey(data, Key.enter)) {
			const pick = items[this.selectedIndex];
			if (pick) return this.done(pick.filePath);
		} else if (matchesKey(data, Key.backspace)) {
			this.query = this.query.slice(0, -1);
		} else if (isPrintable(data)) {
			this.query += data;
			this.selectedIndex = 0;
		}
		this.followCursor(items.length);
		this.tui.requestRender();
	}

	private followCursor(total: number): void {
		if (total === 0) return;
		this.scrollOffset = clampScrollOffset({ row: this.selectedIndex, total, maxVisible: this.bodyRows(), currentOffset: this.scrollOffset });
	}

	render(width: number): string[] {
		const out: string[] = [];
		const items = this.filtered();
		out.push(truncateToWidth(`${bold(this.theme.accent("Plans"))}${this.theme.dim(` · ${items.length} plan${items.length === 1 ? "" : "s"}`)}`, width));
		out.push(this.theme.dim(`search: ${this.query}▏`));
		if (items.length === 0) {
			out.push(this.theme.dim(this.query ? `No plans match "${this.query}"` : "No plans match"));
		} else {
			const start = Math.min(this.scrollOffset, Math.max(0, items.length - this.bodyRows()));
			for (const [i, plan] of items.slice(start, start + this.bodyRows()).entries()) {
				const idx = start + i;
				const selected = idx === this.selectedIndex;
				const badge = STATUS_BADGES[plan.status];
				const color = plan.status === "approved" ? "success" : plan.status === "pending" ? "dim" : "warning";
				const pointer = selected ? this.theme.accent("❯ ") : "  ";
				const title = selected ? bold(this.theme.accent(plan.title)) : plan.title;
				const bits = [
					this.theme[color](badge),
					...(plan.version && plan.version > 1 ? [this.theme.dim(`v${plan.version}`)] : []),
					...(plan.annotations.length > 0 ? [this.theme.accent(`${plan.annotations.length} comment${plan.annotations.length === 1 ? "" : "s"}`)] : []),
					this.theme.dim(formatRelativeTimeShort(plan.updatedAt)),
				];
				let line = `${pointer}${title}${this.theme.dim("  ")}${bits.join(this.theme.dim("  "))}`;
				if (selected) line = this.theme.selected(padTo(line, width));
				out.push(truncateToWidth(line, width));
			}
		}
		out.push(this.theme.dim(italic(this.query ? "enter to open · esc to clear" : "type to search · ↑/↓ navigate · enter to open · esc to close")));
		return out;
	}

	invalidate(): void {}
}

async function openPlansBrowser(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const dir = defaultPlansDir({ cwd: ctx.cwd, home: process.env.HOME ?? "" });
	const plans = await listPlans({ dir });
	if (plans.length === 0) {
		ctx.ui.notify("No saved plans yet — plans land in .pi/plans/ when you use plan mode.", "info");
		return;
	}
	const filePath = await ctx.ui.custom<string | null>(
		(tui, theme, _keybindings, done) => new PlansBrowser({ tui, theme, plans, done }),
	);
	if (!filePath) return;
	const plans2 = await listPlans({ dir }); // re-list: reader may have changed metadata
	const plan = plans2.find((p) => p.filePath === filePath) ?? plans[0]!;
	await openReaderOn(ctx, pi, "browse", dir, plan, true);
}

async function exportPlan(ctx: ExtensionContext, dest?: string): Promise<void> {
	const dir = defaultPlansDir({ cwd: ctx.cwd, home: process.env.HOME ?? "" });
	const plans = await listPlans({ dir });
	if (plans.length === 0) {
		ctx.ui.notify("No plans to export.", "info");
		return;
	}
	const target = dest
		? (dest.startsWith("/") ? dest : join(ctx.cwd, dest))
		: join(ctx.cwd, "PLAN.md");
	const plan = plans[0]!;
	try {
		// COPYFILE_EXCL keeps "never overwrites" true without a racy pre-check
		await copyFile(plan.filePath, target, constants.COPYFILE_EXCL);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EEXIST") {
			ctx.ui.notify(`Export cancelled: ${target} already exists (export never overwrites).`, "warning");
			return;
		}
		throw err;
	}
	ctx.ui.notify(`Exported "${plan.title}" (v${plan.version ?? 1}) to ${target}`, "info");
}

function planRequestPrompt(cwd: string, task: string): string {
	const dir = defaultPlansDir({ cwd, home: process.env.HOME ?? "" });
	return (
		`Plan request: ${task}\n\n` +
		`Research what's needed — do not implement anything yet. While planning, only read-only operations work: ` +
		`prefer the read/grep/find/ls tools; bash is limited to read-only commands (no redirection, chaining, or code execution). ` +
		`Then write an implementation plan ` +
		`as markdown to ${dir}/<descriptive-name>.md (choose a kebab-case name yourself; the file must be a .md inside that directory). ` +
		`The plan should be opinionated and actionable: recommended approach only, critical file paths, and a verification section. ` +
		`When the plan file is written, call the plan_review tool with its absolute path to present it for approval.`
	);
}

export default function planReviewExtension(pi: ExtensionAPI): void {
	registerCommandsAndTools(pi);

	// planning tool policy: default-deny while planning is active
	pi.on("tool_call", async (event) => {
		if (!planningActive) return;
		if (event.toolName === "bash") {
			const blockedSegment = findBlockedCommandSegment(readCommand(event.input));
			if (blockedSegment !== undefined) {
				return { block: true, reason: `Blocked: planning is active — bash outside the reviewed read-only policy.\nBlocked command: ${blockedSegment}\nPrefer the read/grep/find/ls tools, or run /plan off.` };
			}
			return;
		}
		if (!PLANNING_ALLOWED_TOOLS.has(event.toolName)) {
			return { block: true, reason: PLANNING_READONLY_MESSAGE };
		}
	});
}

function registerCommandsAndTools(pi: ExtensionAPI): void {
	pi.registerCommand("plan", {
		description: "Plan a task: research, write .pi/plans/<name>.md, present for review (start/off/export routes)",
		handler: async (args, ctx) => {
			const raw = args?.trim() ?? "";
			// cmdc-style routes: exact subcommand words; anything else is a planning task
			if (raw === "start" || raw === "") {
				if (raw === "start") planningActive = true;
				ctx.ui.notify(raw === "start" ? "Planning active — edits are blocked until the plan is approved." : "Usage: /plan <task> · /plan start · /plan off · /plan export [path]", "info");
				return;
			}
			if (raw === "off" || raw === "exit") {
				planningActive = false;
				ctx.ui.notify("Planning off — edits allowed again.", "info");
				return;
			}
			if (raw === "export" || raw.startsWith("export ")) {
				const dest = raw.slice(6).trim();
				await exportPlan(ctx, dest || undefined);
				return;
			}
			planningActive = true;
			const prompt = planRequestPrompt(ctx.cwd, raw);
			if (ctx.isIdle()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("plan-review", {
		description: "Open the plan review reader (freshest plan in .pi/plans/, or by name/title)",
		handler: async (args, ctx) => {
			await openReader(ctx, pi, "browse", args?.trim() || undefined);
		},
	});

	pi.registerTool({
		name: "plan_mode_question",
		label: "Plan question",
		description:
			"Ask the user a structured question about a material preference, ambiguity, or tradeoff while planning. " +
			"Use this instead of guessing when the answer would materially change the plan. Not for minor assumptions.",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask, ending with ?" }),
			options: Type.Optional(Type.Array(Type.String(), { description: "2-4 answer choices. Omit for free-form input." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planningActive) {
				return { content: [{ type: "text", text: "error: Planning is not active. This tool asks the user plan-shaping questions — it is only available while planning (user runs /plan)." }], details: {} };
			}
			const question = sanitizePlanText(params.question);
			let answer: string | undefined;
			if (params.options && params.options.length > 0) {
				const choices = [...(params.options as string[]).map(sanitizePlanText), "Other…"];
				const picked = await ctx.ui.select(question, choices);
				if (picked === undefined) return { content: [{ type: "text", text: "User dismissed the question. Proceed with your best judgment and note the assumption in the plan." }], details: {} };
				answer = picked === "Other…" ? await ctx.ui.input(question) : picked;
			} else {
				answer = await ctx.ui.input(question);
			}
			if (!answer?.trim()) return { content: [{ type: "text", text: "No answer given. Proceed with your best judgment and note the assumption in the plan." }], details: {} };
			return { content: [{ type: "text", text: `User answered: ${answer.trim()}` }], details: {} };
		},
	});

	pi.registerCommand("plans", {
		description: "Browse saved plans (.pi/plans/)",
		handler: async (_args, ctx) => {
			await openPlansBrowser(ctx, pi as ExtensionAPI);
		},
	});

	pi.registerTool({
		name: "plan_review",
		label: "Plan review",
		description:
			"Open the plan review panel for a plan file in .pi/plans/. Shows the user the full plan alongside approve/refine choices. " +
			"NEVER paste plan contents as chat text instead — the panel is the canonical way to present a plan. " +
			"Call this ALONE, without other tool calls in the same message.",
		parameters: Type.Object({
			filePath: Type.String({ description: "Absolute path of the plan file to present (a .md file in .pi/plans/)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = defaultPlansDir({ cwd: ctx.cwd, home: process.env.HOME ?? "" });
			const contained = containedPlanPath(dir, params.filePath);
			if (!contained) {
				return {
					content: [{ type: "text", text: `error: plan_review only presents markdown plans inside ${dir} (regular files, max 256 KB, symlinks must stay inside the directory). Write the plan there first, then call plan_review with its absolute path.` }],
					details: {},
				};
			}
			const content = await readPlanContent(contained);
			if (!content?.trim()) {
				return {
					content: [{ type: "text", text: `error: Plan file not found or empty: ${contained}. Write the plan there first (markdown, absolute path).` }],
					details: {},
				};
			}
			const plans = await listPlans({ dir });
			const meta = plans.find((p) => p.filePath === params.filePath);
			const result = await ctx.ui.custom<ReaderResult>(
				(tui, theme, _keybindings, done) =>
					new PlanReader({
						tui,
						theme,
						variant: "approval",
						dir,
						plan: {
							filePath: contained,
							title: meta?.title ?? contained.split("/").pop() ?? "Plan",
							version: meta?.version,
							annotations: meta?.annotations ?? [],
						},
						done,
					}),
			);

			if (!result || result.kind === "cancel") {
				return {
					content: [{ type: "text", text: "Plan not approved — the user wants to keep refining it. The plan file stays saved. Ask what they would like changed, then wait for their direction. Do NOT call plan_review again on your own." }],
					details: {},
				};
			}
			if (result.kind === "submit") {
				const newVersion = await snapshotPlanVersion({ filePath: params.filePath, dir });
				await writeComments(params.filePath, result.annotations);
				await setPlanAnnotations({ filePath: params.filePath, dir, annotations: [] });
				return {
					content: [{ type: "text", text: `Review comments submitted as a follow-up user message (v${newVersion} requested). Address every comment, update the plan file in place, delete the comments file, then call plan_review again.` }],
					details: {},
				};
			}
			if (result.kind === "execute") {
				await recordPlanOutcome({ filePath: params.filePath, dir, status: "approved" });
				planningActive = false;
				return {
					content: [{ type: "text", text: `${executePrompt(params.filePath)}` }],
					details: {},
				};
			}
			if (result.kind === "fresh") {
				return {
					content: [{ type: "text", text: "Fresh-session implementation is only available when the panel is opened via /plan-review (session replacement is command-only). Choose Approve instead, or ask the user to run /plan-review." }],
					details: {},
				};
			}
			// approve
			await recordPlanOutcome({ filePath: params.filePath, dir, status: "approved" });
			planningActive = false;
			const notes = result.annotations.length > 0 ? await writeApprovalNotes(params.filePath, result.annotations) : "";
			return {
				content: [{ type: "text", text: `Plan approved — begin implementation now. ${params.filePath} is the source of truth; read it first and implement step by step.${notes}` }],
				details: {},
			};
		},
	});
}

async function writeApprovalNotes(filePath: string, annotations: Annotation[]): Promise<string> {
	await writeComments(filePath, annotations);
	return ` Non-blocking review notes are in ${commentsPathFor(filePath)} — honor them while implementing (or briefly explain why not); delete the file when done.`;
}

// re-export for tests that want to exercise the loop prompts
export { revisionPrompt, executePrompt, commentsPathFor, clearComments };

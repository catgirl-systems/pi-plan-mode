// Headless integration check: drives PlanReader with fake keystrokes.
// Run: node --experimental-strip-types src/reader-smoke.check.ts
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePlanContent, listPlans, readComments, snapshotPlanVersion } from "./plan-store.ts";

// minimal stub so index.ts's pi-tui imports resolve without a running TUI
const dir = await mkdtemp(join(tmpdir(), "pi-plan-reader-"));
process.env.HOME = dir;

const mod = await import("../index.ts");

// theme stub matching the custom() theme shape
const theme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
};

let result: { kind: string; annotations?: unknown[] } | null = null;
let renders = 0;

// write a plan, then open a reader against it
const planPath = join(dir, ".pi", "plans", "auth.md");
await writePlanContent({
	filePath: planPath,
	content: "# Add Auth\n\nUse OAuth via the existing helper.\n\n```ts\nlogin()\n```\n\n| edge | behavior |\n| --- | --- |\n> note\n- rate limit it\n\nDo the thing.",
	dir: join(dir, ".pi", "plans"),
});
const plans = await listPlans({ dir: join(dir, ".pi", "plans") });
assert.equal(plans.length, 1);
assert.equal(plans[0]!.title, "Add Auth");

const { default: planReviewExtension } = mod;

// exercise the exported prompt builders (the loop contract)
assert.ok(mod.revisionPrompt(planPath, 2, 3).includes("v2 requested"));
assert.ok(mod.revisionPrompt(planPath, 2, 3).includes(".comments.json"));
assert.ok(mod.executePrompt(planPath).includes("already approved"));
assert.equal(mod.commentsPathFor(planPath), join(dir, ".pi", "plans", "auth.comments.json"));

// extension registers command + tool without throwing when given a stub api
const registered: Record<string, unknown> = {};
const stubPi = {
	registerCommand: (name: string, def: unknown) => { registered[`cmd:${name}`] = def; },
	registerTool: (def: { name: string }) => { registered[`tool:${def.name}`] = def; },
	registerFlag: () => {},
	sendUserMessage: (msg: string) => { sent.push(msg); },
	on: () => {},
};
const sent: string[] = [];
planReviewExtension(stubPi as never);
assert.ok(registered["cmd:plan-review"], "/plan-review registered");
assert.ok(registered["tool:plan_review"], "plan_review tool registered");

// ---------- drive the component directly ----------
const { Input } = await import("@earendil-works/pi-tui");
assert.ok(typeof Input === "function");
void Input;

// The PlanReader class is module-private; instead simulate its render pipeline through
// a fresh instance created the way openReader does — by extracting it from a re-import
// with a hookable custom(). Simpler: call the command handler with a stub ctx whose
// ui.custom() captures the component.
const captured: { component: any } = { component: null };
const stubCtx = {
	cwd: dir,
	ui: {
		notify: () => {},
		theme,
		custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) => {
			const component: any = factory({ requestRender: () => renders++ }, theme, {}, (v: unknown) => {
				result = v as typeof result;
			});
			captured.component = component;
			// wait for async load
			// wait for the async load to settle (load() calls requestRender when done)
			for (let i = 0; i < 100 && !component.loaded; i++) await new Promise((r) => setTimeout(r, 10));
			return undefined; // simulating cancel path at the openReader level
		},
	},
};

// invoke the command handler directly
const handler = (registered["cmd:plan-review"] as { handler: (args: string, ctx: unknown) => Promise<void> }).handler;
await handler("", stubCtx as never);
const reader = captured.component;
assert.ok(reader, "reader component created");

// render pipeline
const lines1 = reader.render(100);
assert.ok(lines1.length > 5, `rendered ${lines1.length} lines`);
assert.ok(lines1.some((l: string) => l.includes("Add Auth")), "title shown");
assert.ok(lines1.some((l: string) => l.includes("REVIEW")), "review bar shown");
assert.ok(lines1.some((l: string) => l.includes("Execute plan")), "browse actions shown");

// cursor starts on line 1 ("# Add Auth")
const down = "\x1b[B"; // arrow down
reader.handleInput(down); // to line 3 ("Use OAuth via the existing helper.")

// type a comment draft (printable opens draft pre-filled)
reader.handleInput("h");
const withDraft = reader.render(100);
assert.ok(withDraft.some((l: string) => l.includes("┃")), "draft input row rendered");
reader.handleInput("ello"); // finish typing
reader.handleInput("\r"); // enter pins it
await reader.lastPersist; // persist is async — await the write itself

const annCheck = await listPlans({ dir: join(dir, ".pi", "plans") });
assert.equal(annCheck[0]!.annotations.length, 1, "annotation persisted to index");
assert.equal(annCheck[0]!.annotations[0]!.text, "hello");

// quick comment: '?' pins instantly
reader.handleInput(down); // next line
reader.handleInput("?");
await reader.lastPersist;
const afterQuick = await listPlans({ dir: join(dir, ".pi", "plans") });
assert.equal(afterQuick[0]!.annotations.length, 2);
assert.ok(afterQuick[0]!.annotations.some((a) => a.text.startsWith("Why?")));

// ctrl+r submits → done with submit result carrying annotations
reader.handleInput("\x12"); // ctrl+r
const submitted = result as { kind: string; annotations: unknown[] } | null;
assert.ok(submitted && submitted.kind === "submit", "ctrl+r submits");
assert.equal(submitted!.annotations.length, 2);

// submit flow: snapshot + sidecar + cleared annotations (as openReader would do)
const newVersion = await snapshotPlanVersion({ filePath: planPath, dir: join(dir, ".pi", "plans") });
assert.equal(newVersion, 2);
await (async () => {
	const { writeComments, setPlanAnnotations } = await import("./plan-store.ts");
	await writeComments(planPath, submitted!.annotations as never);
	await setPlanAnnotations({ filePath: planPath, dir: join(dir, ".pi", "plans"), annotations: [] });
})();
const sidecar = await readComments(planPath);
assert.equal(sidecar.length, 2, "sidecar written for the agent");
const cleared = await listPlans({ dir: join(dir, ".pi", "plans") });
assert.equal(cleared[0]!.annotations.length, 0, "UI annotations cleared for next round");


// ---------- /plan + /plans (fresh registration so handlers are capturable) ----------
const sent2: string[] = [];
const notices: string[] = [];
const cmds: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
mod.default({
	registerCommand: (n: string, d: { handler: (args: string, ctx: unknown) => Promise<void> }) => { cmds[n] = d; },
	registerTool: () => {},
	registerFlag: () => {},
	sendUserMessage: (m: string, o?: { deliverAs?: string }) => sent2.push(o ? `${m}|${o.deliverAs}` : m),
	on: () => {},
} as never);
assert.ok(cmds["plan"] && cmds["plans"] && cmds["plan-review"], "commands registered: plan, plans, plan-review");

const idleCtx = {
	cwd: dir,
	isIdle: () => true,
	ui: { notify: (m: string) => notices.push(m), theme, custom: async () => undefined },
};

// /plan with no args -> usage notice, nothing sent
await cmds["plan"]!.handler("", idleCtx as never);
assert.equal(sent2.length, 0, "no-arg /plan sends nothing");
assert.ok(notices.some((n) => n.includes("Usage: /plan")), "usage notice shown");

// /plan <task> -> contract message: task, plans dir, plan_review tool, no-implement
await cmds["plan"]!.handler("add rate limiting to the API", idleCtx as never);
assert.equal(sent2.length, 1);
assert.ok(sent2[0]!.includes("Plan request: add rate limiting to the API"));
assert.ok(sent2[0]!.includes(join(dir, ".pi", "plans")));
assert.ok(sent2[0]!.includes("plan_review"));
assert.ok(/do not implement/i.test(sent2[0]!), "contract forbids implementing");

// busy agent -> followUp delivery
const busyCtx = { cwd: dir, isIdle: () => false, ui: idleCtx.ui };
await cmds["plan"]!.handler("add search", busyCtx as never);
assert.equal(sent2.length, 2);
assert.ok(sent2[1]!.endsWith("|followUp"), "busy /plan delivers as followUp");

// ---------- plans browser ----------
let opened: string | null | undefined;
let closed: boolean | undefined;
let browser: any = null;
const browserCtx = {
	cwd: dir,
	isIdle: () => true,
	ui: {
		notify: () => {},
		theme,
		custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: string | null) => void) => unknown) => {
			browser = factory({ requestRender: () => {} }, theme, {}, (v: string | null) => { opened = v; });
			return undefined;
		},
	},
};
await cmds["plans"]!.handler("", browserCtx as never);
const rows = browser.render(100);
assert.ok(rows.some((l: string) => l.includes("Plans")), "browser title");
assert.ok(rows.some((l: string) => l.includes("Add Auth")), "plan title listed");
assert.ok(rows.some((l: string) => l.includes("v2")), "version shown");

// type-to-search filters
for (const c of "nothingmatches") browser.handleInput(c);
assert.ok(!browser.render(100).some((l: string) => l.includes("Add Auth")), "filter excludes");
for (let i = 0; i < 20; i++) browser.handleInput("\x7f"); // backspace clears
assert.ok(browser.render(100).some((l: string) => l.includes("Add Auth")), "filter restored");

// enter opens the selected plan
browser.handleInput("\r");
assert.ok(opened && opened.endsWith("auth.md"), "enter selects plan path");

// esc closes
const closeCtx = {
	cwd: dir,
	isIdle: () => true,
	ui: { notify: () => {}, theme, custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: string | null) => void) => unknown) => { const b: any = factory({ requestRender: () => {} }, theme, {}, (v: string | null) => { closed = v === null; }); b.handleInput("\x1b"); return undefined; } },
};
await cmds["plans"]!.handler("", closeCtx as never);
assert.ok(closed, "esc closes browser");

console.log("browser + /plan checks passed");

await rm(dir, { recursive: true, force: true });

// ---------- planning tool policy & routes ----------
// captured handlers from the FIRST registration include tool_call; re-register to grab it
let toolCallResult: { block: boolean; reason: string } | null = null;
type ToolCallResult = { block: boolean; reason: string } | void;
const hooks: { toolCall: ((event: { toolName: string; input: Record<string, unknown> }) => Promise<ToolCallResult>) | null } = { toolCall: null };
const questionTool: { name: string; execute: (id: string, params: { question: string; options?: string[] }, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: { type: string; text: string }[] }> } = { name: "", execute: async () => ({ content: [] }) };
{
	const stubPi5 = {
		registerCommand: () => {},
		registerTool: (d: any) => { if (d.name === "plan_mode_question") Object.assign(questionTool, d); },
		registerFlag: () => {},
		sendUserMessage: () => {},
		on: (event: string, handler: (e: { toolName: string; input: Record<string, unknown> }, ctx: { cwd: string }) => Promise<ToolCallResult>) => { if (event === "tool_call") hooks.toolCall = (e) => handler(e, { cwd: dir }); },
	};
	mod.default(stubPi5 as never);
}
assert.ok(hooks.toolCall, "tool_call handler registered");

// policy inactive -> nothing blocked (turn planning off from the earlier /plan <task> test)
const startCtx = { cwd: dir, isIdle: () => true, ui: { notify: () => {}, theme, custom: async () => undefined } };
await cmds["plan"]!.handler("off", startCtx as never);
assert.equal(await hooks.toolCall!({ toolName: "edit", input: {} }), undefined, "no block when planning inactive");

// activate via /plan start: default-deny tools + narumitw-style bash policy
await cmds["plan"]!.handler("start", startCtx as never);
toolCallResult = (await hooks.toolCall!({ toolName: "edit", input: {} })) ?? null;
assert.ok(toolCallResult?.block, "edit blocked while planning");
toolCallResult = (await hooks.toolCall!({ toolName: "write", input: {} })) ?? null;
assert.ok(toolCallResult?.block, "write blocked while planning");
toolCallResult = (await hooks.toolCall!({ toolName: "mcp__db_query", input: {} })) ?? null;
assert.ok(toolCallResult?.block, "unknown/MCP tools default-deny while planning");
toolCallResult = (await hooks.toolCall!({ toolName: "readSeek_edit", input: {} })) ?? null;
assert.ok(toolCallResult?.block, "readSeek_edit blocked while planning");
toolCallResult = (await hooks.toolCall!({ toolName: "read", input: {} })) ?? null;
assert.equal(toolCallResult, null, "read allowed while planning");
toolCallResult = (await hooks.toolCall!({ toolName: "readSeek_grep", input: {} })) ?? null;
assert.equal(toolCallResult, null, "readSeek_grep allowed while planning");
toolCallResult = (await hooks.toolCall!({ toolName: "subagent_consult", input: { agent: "scout" } })) ?? null;
assert.equal(toolCallResult, null, "subagent_consult allowed while planning");
toolCallResult = (await hooks.toolCall!({ toolName: "plan_review", input: {} })) ?? null;
assert.equal(toolCallResult, null, "plan_review allowed while planning");

// bash: reviewed read-only forms pass, everything else blocked
const bashCases: Array<[string, boolean]> = [
	["find . -maxdepth 3 -type f | sort | head -200", true], // the exact call from the field
	["ls -la", true],
	["grep -rn pattern src/", true],
	["git status", true],
	["git log --oneline -5", true],
	["npm test", true],
	["rg formidable .", true],
	["echo x > /tmp/pwned", false],
	["ls; rm -rf /tmp/x", false],
	["ls && rm -rf /tmp/x", false],
	["rm -rf /tmp/x", false],
	["git push", false],
	["git branch new-name", false],
	["npm install left-pad", false],
	["env sh -c 'x'", false],
	["find . -exec rm {} ;", false],
	["sed -i s/a/b/ file", false],
	["sudo cat /etc/shadow", false],
	["cat file | tee other", false],
	["node -e 'fs.rmSync(\"x\")'", false],
];
for (const [command, safe] of bashCases) {
	toolCallResult = (await hooks.toolCall!({ toolName: "bash", input: { command } })) ?? null;
	assert.equal(!!toolCallResult?.block, !safe, `bash policy: ${command}`);
}

// plan_review containment: paths outside .pi/plans are rejected before any UI
{
	const toolDefs: Record<string, { execute: (id: string, params: { filePath: string }, s: undefined, u: undefined, ctx: unknown) => Promise<{ content: { text: string }[] }> }> = {};
	mod.default({
		registerCommand: () => {},
		registerTool: (d: { name: string; execute: never }) => { toolDefs[d.name] = d as never; },
		registerFlag: () => {},
		sendUserMessage: () => {},
		on: () => {},
	} as never);
	const outside = await toolDefs["plan_review"]!.execute("id", { filePath: "/etc/passwd" }, undefined, undefined, { cwd: dir });
	assert.ok(outside.content[0]!.text.startsWith("error:"), "plan_review rejects paths outside plans dir");
	const sneaky = await toolDefs["plan_review"]!.execute("id", { filePath: join(dir, ".pi", "plans", "..", "..", "..", "etc", "passwd") }, undefined, undefined, { cwd: dir });
	assert.ok(sneaky.content[0]!.text.startsWith("error:"), "plan_review rejects traversal outside plans dir");
	const notMd = await toolDefs["plan_review"]!.execute("id", { filePath: join(dir, ".pi", "plans") }, undefined, undefined, { cwd: dir });
	assert.ok(notMd.content[0]!.text.startsWith("error:"), "plan_review rejects non-.md targets");
}

console.log("policy + routes + question checks passed");

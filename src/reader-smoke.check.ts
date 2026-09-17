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

await rm(dir, { recursive: true, force: true });
console.log(`reader-smoke: renders=${renders} — all checks passed`);

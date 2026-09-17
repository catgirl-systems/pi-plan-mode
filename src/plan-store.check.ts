// Runnable check: node --experimental-strip-types src/plan-store.check.ts
import assert from "node:assert";
import { mkdtemp, readFile, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  derivePlanTitle,
  writePlanContent,
  readPlanContent,
  listPlans,
  resolvePlanContent,
  snapshotPlanVersion,
  readPlanVersionSnapshot,
  setPlanAnnotations,
  recordPlanOutcome,
  readComments,
  writeComments,
  clearComments,
} from "./plan-store.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-plan-store-"));
let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => async () => { await fn(); n++; };

await ok("title from heading, label stripped", async () => {
  assert.equal(derivePlanTitle({ content: "# plan: Add Auth\nbody", fileName: "x.md" }), "Add Auth");
  assert.equal(derivePlanTitle({ content: "no heading here", fileName: "x.md" }), "X"); // cmdc: falls through to filename
  assert.equal(derivePlanTitle({ fileName: "auth-design.md" }), "Auth design");
})();

await ok("write + read + list roundtrip", async () => {
  await writePlanContent({ filePath: join(dir, "auth.md"), content: "# Add Auth\nUse OAuth.", dir });
  assert.equal(await readPlanContent(join(dir, "auth.md")), "# Add Auth\nUse OAuth.");
  const plans = await listPlans({ dir });
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.title, "Add Auth");
  assert.equal(plans[0]!.status, "pending");
  assert.equal(plans[0]!.version, undefined);
})();

await ok("session filter: index sessionId wins, mtime fallback", async () => {
  await writePlanContent({ filePath: join(dir, "other.md"), content: "# Other", dir, sessionId: "s1" });
  const all = await listPlans({ dir, sessionId: "s1", sessionStartMs: 0 });
  assert.equal(all.length, 2); // auth.md falls back to mtime >= 0
  const s2 = await listPlans({ dir, sessionId: "s1", sessionStartMs: Date.now() + 1e6 });
  assert.deepEqual(s2.map((p) => p.fileName), ["other.md"]); // indexed sessionId wins; mtime fallback excludes auth.md
})();

await ok("annotations persist to index", async () => {
  await setPlanAnnotations({
    filePath: join(dir, "auth.md"), dir,
    annotations: [{ line: 1, text: "why?", createdAt: new Date().toISOString() }],
  });
  const [plan] = await listPlans({ dir, sessionId: "s1", sessionStartMs: 0 });
  assert.equal(plan!.annotations.length, 1);
  assert.equal(plan!.annotations[0]!.text, "why?");
})();

await ok("snapshot bumps version, old content readable", async () => {
  await writePlanContent({ filePath: join(dir, "auth.md"), content: "# Add Auth v2", dir });
  const v = await snapshotPlanVersion({ filePath: join(dir, "auth.md"), dir });
  assert.equal(v, 2); // was version 1 (implicit), snapshot saved as v1, bumped to 2
  assert.equal(await readPlanVersionSnapshot({ filePath: join(dir, "auth.md"), dir, version: 1 }), "# Add Auth v2");
  const [plan] = await listPlans({ dir, sessionId: "s1", sessionStartMs: 0 });
  assert.equal(plan!.version, 2);
})();

await ok("outcome records approval", async () => {
  await recordPlanOutcome({ filePath: join(dir, "auth.md"), dir, status: "approved", content: "# Add Auth v2" });
  const [plan] = await listPlans({ dir, sessionId: "s1", sessionStartMs: 0 });
  assert.equal(plan!.status, "approved");
})();

await ok("resolvePlanContent picks freshest sinceMs", async () => {
  const found = await resolvePlanContent({ dir, sinceMs: 0 });
  assert.equal(found!.filePath, join(dir, "auth.md")); // updated most recently (outcome bump)
  assert.equal(await resolvePlanContent({ dir, sinceMs: Date.now() + 1e6 }), null);
})();

await ok("comments sidecar roundtrip + clear", async () => {
  const filePath = join(dir, "auth.md");
  await writeComments(filePath, [{ line: 3, text: "cut this", createdAt: "t" }]);
  assert.deepEqual(await readComments(filePath), [{ line: 3, text: "cut this", createdAt: "t" }]);
  // sidecar is a separate file the agent can read
  const raw = JSON.parse(await readFile(join(dir, "auth.comments.json"), "utf8"));
  assert.equal(raw[0].text, "cut this");
  await clearComments(filePath);
  await assert.rejects(access(join(dir, "auth.comments.json")));
  assert.deepEqual(await readComments(filePath), []);
})();

await ok("corrupt index treated as fresh", async () => {
  const { writeFile } = await import("node:fs/promises");
  const bad = await mkdtemp(join(tmpdir(), "pi-plan-bad-"));
  await writeFile(join(bad, "plans-index.json"), "{not json");
  assert.deepEqual(await listPlans({ dir: bad }), []);
  await writePlanContent({ filePath: join(bad, "x.md"), content: "# X", dir: bad }); // still writable
  assert.equal((await listPlans({ dir: bad })).length, 1);
})();

await ok("concurrent index writes serialize", async () => {
  const { default: fs } = await import("node:fs/promises") as never as { default: typeof import("node:fs/promises") };
  void fs;
  const cdir = await mkdtemp(join(tmpdir(), "pi-plan-conc-"));
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      writePlanContent({ filePath: join(cdir, `p${i}.md`), content: `# P${i}`, dir: cdir })),
  );
  const plans = await listPlans({ dir: cdir });
  assert.equal(plans.length, 10); // no lost updates
  const raw = JSON.parse(await readFile(join(cdir, "plans-index.json"), "utf8"));
  assert.equal(Object.keys(raw.plans).length, 10);
})();

await ok("versions dir not listed as a plan", async () => {
  const files = await listPlans({ dir });
  assert.ok(!files.some((p) => p.fileName.startsWith("versions")));
  await stat(join(dir, "versions", "auth-v1.md")); // snapshot exists on disk
})();

console.log(`plan-store: ${n} checks passed`);

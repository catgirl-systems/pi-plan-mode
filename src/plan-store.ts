// Plan storage: index JSON + version snapshots + comments sidecar.
// Semantics ported from command-code v1.54.0 (notes/01-plan-storage.md);
// sidecar is the Pi-native addition (agent-readable comment data).

import { join, dirname, basename } from "node:path";
import { readFile, writeFile, readdir, stat, mkdir, unlink } from "node:fs/promises";
import type { Annotation } from "./reader-core.ts";

export type PlanStatus = "pending" | "approved" | "not-implemented";

export type PlanMeta = {
  title: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  annotations: Annotation[];
  version?: number;
  sessionId?: string;
  cwd?: string;
};

export type PlanEntry = PlanMeta & { fileName: string; filePath: string };

export type PlansIndex = { version: 1; plans: Record<string, PlanMeta> };

const INDEX_FILE = "plans-index.json";
const VERSIONS_DIR = "versions";
const MAX_PLAN_BYTES = 262144; // 256 KB, like cmdc

const emptyIndex = (): PlansIndex => ({ version: 1, plans: {} });

export function defaultPlansDir(input: { cwd: string; home: string }): string {
  // Project-local first (plans belong to the repo); global as fallback location for
  // home-dir sessions. Caller decides which to use; this just builds both paths.
  return join(input.cwd, ".pi", "plans");
}

export function globalPlansDir(home: string): string {
  return join(home, ".pi", "agent", "plans");
}

// ---------- title ----------

export function stripPlanLabelPrefix(title: string): string {
  return title.replace(/^plan:\s*/i, "");
}

export function derivePlanTitle(input: { content?: string | null; fileName: string }): string {
  if (input.content) {
    for (const line of input.content.split("\n")) {
      const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
      if (m?.[1]) return stripPlanLabelPrefix(m[1]);
    }
  }
  const words = input.fileName.replace(/\.md$/, "").replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : input.fileName;
}

// ---------- index ----------

async function readIndex(dir: string): Promise<PlansIndex> {
  try {
    const raw = JSON.parse(await readFile(join(dir, INDEX_FILE), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.plans === "object") {
      return raw as PlansIndex;
    }
  } catch {
    // missing or corrupt -> fresh
  }
  return emptyIndex();
}

// Serialized read-modify-write, like cmdc's promise-chain lock: each write is queued
// on the chain BEFORE it reads, so concurrent writers never share a stale snapshot.
const indexChains = new Map<string, Promise<unknown>>();
function updateIndex<T>(dir: string, mutate: (plans: Record<string, PlanMeta>) => T): Promise<T> {
  const prev = indexChains.get(dir) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    await mkdir(dir, { recursive: true });
    const index = await readIndex(dir);
    const plans = mutate({ ...index.plans });
    await writeFile(join(dir, INDEX_FILE), `${JSON.stringify({ version: 1, plans }, null, 2)}\n`);
    return plans;
  });
  indexChains.set(dir, run);
  return run;
}

// ---------- plan files ----------

export async function readPlanContent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function writePlanContent(input: {
  filePath: string;
  content: string;
  dir: string;
  sessionId?: string;
  cwd?: string;
}): Promise<void> {
  await mkdir(dirname(input.filePath), { recursive: true });
  await writeFile(input.filePath, input.content);
  const fileName = basename(input.filePath);
  const now = new Date().toISOString();
  await updateIndex(input.dir, (plans) => {
    const prev = plans[fileName];
    plans[fileName] = {
      title: prev?.title ?? derivePlanTitle({ content: input.content, fileName }),
      status: prev?.status ?? "pending",
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      annotations: prev?.annotations ?? [],
      ...(prev?.version ? { version: prev.version } : {}),
      ...(prev?.sessionId !== undefined ? { sessionId: prev.sessionId } : input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(prev?.cwd !== undefined ? { cwd: prev.cwd } : input.cwd ? { cwd: input.cwd } : {}),
    };
    return plans;
  });
}

export async function listPlans(input: {
  dir: string;
  sessionId?: string;
  sessionStartMs?: number;
}): Promise<PlanEntry[]> {
  let names: string[];
  try {
    names = await readdir(input.dir);
  } catch {
    return [];
  }
  const index = await readIndex(input.dir);
  const out: PlanEntry[] = [];
  for (const fileName of names) {
    if (!fileName.endsWith(".md")) continue;
    const filePath = join(input.dir, fileName);
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_PLAN_BYTES) continue;
    const meta = index.plans[fileName];
    // Session filter: index sessionId wins; else mtime-since-session-start fallback.
    if (input.sessionId !== undefined) {
      const inSession =
        meta?.sessionId !== undefined
          ? meta.sessionId === input.sessionId
          : input.sessionStartMs !== undefined && st.mtimeMs >= input.sessionStartMs;
      if (!inSession) continue;
    }
    if (meta) {
      out.push({ ...meta, title: stripPlanLabelPrefix(meta.title), fileName, filePath });
      continue;
    }
    let content: string | null = null;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      /* fallback title */
    }
    const iso = new Date(st.mtimeMs).toISOString();
    out.push({
      fileName,
      filePath,
      title: derivePlanTitle({ content, fileName }),
      status: "pending",
      createdAt: iso,
      updatedAt: iso,
      annotations: [],
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Freshest plan file modified since `sinceMs` (exit_plan_mode content resolution). */
export async function resolvePlanContent(input: {
  dir: string;
  sinceMs: number;
}): Promise<{ content: string; filePath: string } | null> {
  let names: string[];
  try {
    names = await readdir(input.dir);
  } catch {
    return null;
  }
  let newest: { filePath: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const filePath = join(input.dir, name);
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_PLAN_BYTES) continue;
    if (st.mtimeMs < input.sinceMs) continue;
    if (newest && st.mtimeMs <= newest.mtimeMs) continue;
    newest = { filePath, mtimeMs: st.mtimeMs };
  }
  if (!newest) return null;
  const content = await readPlanContent(newest.filePath);
  return content?.trim() ? { content, filePath: newest.filePath } : null;
}

// ---------- versions ----------

function versionPath(dir: string, fileName: string, version: number): string {
  const base = fileName.replace(/\.md$/, "");
  return join(dir, VERSIONS_DIR, `${base}-v${version}.md`);
}

export async function snapshotPlanVersion(input: { filePath: string; dir: string }): Promise<number> {
  const fileName = basename(input.filePath);
  let content: string;
  try {
    content = await readFile(input.filePath, "utf8");
  } catch {
    return 1;
  }
  const index = await readIndex(input.dir);
  const current = index.plans[fileName]?.version ?? 1;
  await mkdir(join(input.dir, VERSIONS_DIR), { recursive: true });
  try {
    await writeFile(versionPath(input.dir, fileName, current), content);
  } catch {
    // snapshot is best-effort; still bump so rounds progress
  }
  const next = current + 1;
  const now = new Date().toISOString();
  await updateIndex(input.dir, (plans) => {
    const prev = plans[fileName];
    plans[fileName] = {
      title: prev?.title ?? derivePlanTitle({ content, fileName }),
      status: prev?.status ?? "pending",
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      annotations: prev?.annotations ?? [],
      version: next,
      ...(prev?.sessionId ? { sessionId: prev.sessionId } : {}),
      ...(prev?.cwd ? { cwd: prev.cwd } : {}),
    };
    return plans;
  });
  return next;
}

export async function readPlanVersionSnapshot(input: {
  filePath: string;
  dir: string;
  version: number;
}): Promise<string | null> {
  return readPlanContent(versionPath(input.dir, basename(input.filePath), input.version));
}

// ---------- status + annotations ----------

export async function recordPlanOutcome(input: {
  filePath: string;
  dir: string;
  status: PlanStatus;
  content?: string;
  sessionId?: string;
  cwd?: string;
}): Promise<void> {
  const fileName = basename(input.filePath);
  const now = new Date().toISOString();
  await updateIndex(input.dir, (plans) => {
    const prev = plans[fileName];
    plans[fileName] = {
      title: prev?.title ?? derivePlanTitle({ content: input.content, fileName }),
      status: input.status,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      annotations: prev?.annotations ?? [],
      ...(prev?.version ? { version: prev.version } : {}),
      ...(prev?.sessionId !== undefined ? { sessionId: prev.sessionId } : input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(prev?.cwd !== undefined ? { cwd: prev.cwd } : input.cwd ? { cwd: input.cwd } : {}),
    };
    return plans;
  });
}

export async function setPlanAnnotations(input: {
  filePath: string;
  dir: string;
  annotations: Annotation[];
}): Promise<void> {
  const fileName = basename(input.filePath);
  const now = new Date().toISOString();
  let content: string | null = null;
  try {
    content = await readFile(input.filePath, "utf8");
  } catch {
    /* title fallback */
  }
  await updateIndex(input.dir, (plans) => {
    const prev = plans[fileName];
    plans[fileName] = {
      title: prev?.title ?? derivePlanTitle({ content, fileName }),
      status: prev?.status ?? "pending",
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      annotations: [...input.annotations],
      ...(prev?.version ? { version: prev.version } : {}),
      ...(prev?.sessionId ? { sessionId: prev.sessionId } : {}),
      ...(prev?.cwd ? { cwd: prev.cwd } : {}),
    };
    return plans;
  });
}

// ---------- comments sidecar (Pi-native: agent-readable comment data) ----------

export function commentsPathFor(filePath: string): string {
  const base = basename(filePath).replace(/\.md$/, "");
  return join(dirname(filePath), `${base}.comments.json`);
}

export async function readComments(filePath: string): Promise<Annotation[]> {
  try {
    const raw = JSON.parse(await readFile(commentsPathFor(filePath), "utf8"));
    return Array.isArray(raw) ? (raw as Annotation[]) : [];
  } catch {
    return [];
  }
}

export async function writeComments(filePath: string, annotations: Annotation[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(commentsPathFor(filePath), `${JSON.stringify(annotations, null, 2)}\n`);
}

/** Remove the sidecar — "no comments" must be unambiguous. */
export async function clearComments(filePath: string): Promise<void> {
  try {
    await unlink(commentsPathFor(filePath));
  } catch {
    // already gone
  }
}

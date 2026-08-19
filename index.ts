/**
 * gh-review — submit hunk notes as a GitHub PR review.
 *
 * Press `S` (or rebind `gh-review.submit` in [keybindings]) to post every
 * note in the current review as inline comments on the PR under review,
 * then submit the review as Comment / Approve / Request changes.
 *
 * The target PR is never typed by hand — it is the PR of the diff being
 * reviewed: launchers that pipe a PR diff in (`gh pr diff 42 | hunk patch -`)
 * set GH_PR_NUMBER, and working-tree reviews fall back to the checked-out
 * branch's open PR. If neither yields a PR there is nowhere to post notes
 * (GitHub reviews attach to PRs, not branches), so the command fails with a
 * clear message instead of guessing.
 *
 * Notes are read from the live session via `hunk session comment list`
 * (authoritative — includes deletions); the note_created/note_edited events
 * are kept as a fallback when the session daemon is unreachable. GitHub
 * calls go through `gh`, so auth is whatever `gh auth status` says.
 */
import type { HunkExtensionAPI, ExtensionCommandContext } from "hunkdiff/extension";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Note = {
  filePath: string;
  side: "old" | "new";
  line: number;
  body: string;
};

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

async function mustRun(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error((r.stderr || r.stdout).trim() || `${cmd} exited ${r.code}`);
  }
  return r.stdout;
}

/** Authoritative note list from the live session daemon. Throws if unreachable. */
async function fetchSessionNotes(cwd: string): Promise<Note[]> {
  const out = await mustRun("hunk", ["session", "comment", "list", "--repo", cwd, "--type", "user", "--json"], { cwd });
  const parsed = JSON.parse(out);
  const items: any[] = Array.isArray(parsed) ? parsed : (parsed.comments ?? []);
  const notes: Note[] = [];
  for (const it of items) {
    const filePath = it.filePath ?? it.path;
    const body = it.body ?? [it.summary, it.rationale].filter(Boolean).join("\n\n");
    let side: "old" | "new";
    let line: number | undefined;
    if (typeof it.newLine === "number") {
      side = "new";
      line = it.newLine;
    } else if (typeof it.oldLine === "number") {
      side = "old";
      line = it.oldLine;
    } else {
      side = it.side === "old" ? "old" : "new";
      line = typeof it.line === "number" ? it.line : undefined;
    }
    if (filePath && typeof line === "number" && body) notes.push({ filePath, side, line, body });
  }
  return notes;
}

type TargetPr = { number: string; title: string };

async function ghPrJson(args: string[], cwd: string): Promise<TargetPr> {
  const out = await mustRun("gh", [...args, "--json", "number,title", "--jq", '"\\(.number)\\t\\(.title)"'], { cwd });
  const [number, ...rest] = out.trim().split("\t");
  return { number, title: rest.join("\t") };
}

/**
 * Which PR this review belongs to. GH_PR_NUMBER (set by launchers that pipe a
 * PR diff into hunk) wins; otherwise the checked-out branch's open PR. Returns
 * null — after notifying — when there is no PR to attach notes to, since
 * GitHub reviews cannot be left on a bare branch.
 */
async function resolveTargetPr(ctx: ExtensionCommandContext): Promise<TargetPr | null> {
  const envPr = process.env.GH_PR_NUMBER?.trim();
  if (envPr) {
    if (!/^\d+$/.test(envPr)) {
      ctx.notify(`gh-review: GH_PR_NUMBER="${envPr}" is not a PR number`, "error");
      return null;
    }
    try {
      return await ghPrJson(["pr", "view", envPr], ctx.cwd);
    } catch (e) {
      ctx.notify(`gh-review: PR #${envPr} not found: ${(e as Error).message.split("\n")[0]}`, "error");
      return null;
    }
  }
  try {
    return await ghPrJson(["pr", "view"], ctx.cwd);
  } catch {
    ctx.notify(
      "gh-review: no open PR for the checked-out branch — notes can only be submitted to a PR. Open one first (gh pr create).",
      "warning",
    );
    return null;
  }
}

export default function (hunk: HunkExtensionAPI) {
  // Fallback note collection, live from lifecycle events.
  const collected = new Map<string, Note>();
  const track = (note: { id: string; draft: boolean; filePath: string; side: "old" | "new"; line: number; body: string }) => {
    if (!note.draft && note.body) {
      collected.set(note.id, { filePath: note.filePath, side: note.side, line: note.line, body: note.body });
    }
  };
  hunk.on("note_created", ({ note }) => track(note));
  hunk.on("note_edited", ({ note }) => track(note));

  hunk.registerCommand({ id: "submit", title: "Submit notes as GitHub PR review", key: "S" }, (ctx) =>
    submitReview(ctx, collected),
  );
}

async function submitReview(ctx: ExtensionCommandContext, collected: Map<string, Note>): Promise<void> {
  // 1. Gather notes: session CLI first (sees deletions), event cache as fallback.
  let notes: Note[];
  try {
    notes = await fetchSessionNotes(ctx.cwd);
  } catch {
    notes = [...collected.values()];
  }
  if (notes.length === 0) {
    ctx.notify("No notes to submit — press `c` on a hunk to add one first", "warning");
    return;
  }

  // 2. Resolve repo + the PR this review belongs to. The number is never
  // typed by hand: notes can only sensibly land on the PR whose diff is
  // loaded (comment line positions must match that PR's head diff).
  let nameWithOwner: string;
  try {
    nameWithOwner = (await mustRun("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: ctx.cwd })).trim();
  } catch (e) {
    ctx.notify(`gh-review: not a GitHub repo or gh failed: ${(e as Error).message}`, "error");
    return;
  }

  const pr = await resolveTargetPr(ctx);
  if (!pr) return; // resolveTargetPr already explained why

  const ok = await ctx.dialogs.confirm({
    title: `Submit ${notes.length} note${notes.length === 1 ? "" : "s"} to PR #${pr.number}?`,
    body: pr.title,
    confirmLabel: "submit",
  });
  if (!ok) return;
  const prNumber = pr.number;

  const choice = await ctx.dialogs.select({
    title: `Review type for PR #${prNumber}`,
    options: ["Comment", "Approve", "Request changes"],
  });
  if (choice === null) return;
  const event = { Comment: "COMMENT", Approve: "APPROVE", "Request changes": "REQUEST_CHANGES" }[choice]!;

  const body = (await ctx.dialogs.input({
    title: "Review body (optional — escape to skip)",
    placeholder: "Top-level review comment",
  })) ?? "";

  // 3. Post one atomic review: comments + event in a single call.
  const payload = {
    event,
    ...(body.trim() ? { body: body.trim() } : {}),
    comments: notes.map((n) => ({
      path: n.filePath,
      line: n.line,
      side: n.side === "old" ? "LEFT" : "RIGHT",
      body: n.body,
    })),
  };
  const tmp = join(tmpdir(), `hunk-gh-review-${Date.now()}.json`);
  try {
    writeFileSync(tmp, JSON.stringify(payload));
    await mustRun("gh", ["api", `repos/${nameWithOwner}/pulls/${prNumber}/reviews`, "--method", "POST", "--input", tmp], {
      cwd: ctx.cwd,
    });
  } catch (e) {
    ctx.notify(
      `gh-review: GitHub rejected the review: ${(e as Error).message.split("\n")[0]}`,
      "error",
    );
    return;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }

  // 4. Clear the submitted notes so a second press doesn't double-post.
  try {
    await run("hunk", ["session", "comment", "clear", "--repo", ctx.cwd, "--include-user", "--yes"], { cwd: ctx.cwd });
  } catch {
    // Session daemon unreachable — notes stay, harmless.
  }
  collected.clear();

  ctx.notify(`Submitted ${choice} review with ${notes.length} comment${notes.length === 1 ? "" : "s"} on PR #${prNumber}`);
}

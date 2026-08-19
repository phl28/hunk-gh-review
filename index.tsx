/**
 * gh-review — GitHub PR reviews from inside hunk.
 *
 * Two features:
 *
 * 1. Submit (`S`, command `gh-review.submit`): post every note in the current
 *    review as inline comments on the PR under review, then submit as
 *    Comment / Approve / Request changes. Notes are optional — matching the
 *    GitHub UI, Approve and Request changes submit with no content at all;
 *    a Comment review without notes requires a top-level body.
 *
 * 2. PR threads pane (`T`, command `gh-review.threads`): fetches the PR's
 *    review threads and docks them in a right-hand pane — click a thread to
 *    jump the review stream to its line. `R` (`gh-review.reply`) replies to
 *    the clicked thread; threads refetch after replies and submits.
 *
 * The target PR is never typed by hand — it is the PR of the diff being
 * reviewed: launchers that pipe a PR diff in (`gh pr diff 42 | hunk patch -`)
 * set GH_PR_NUMBER (and GH_PR_REPO, since gh's upstream>origin remote
 * priority can otherwise resolve the wrong repo in fork-style clones), and
 * working-tree reviews fall back to the checked-out branch's open PR. A
 * set-but-empty GH_PR_NUMBER means the launcher already determined there is
 * no open PR. If there is nowhere to post notes (GitHub reviews attach to
 * PRs, not branches), submit fails with a clear message instead of guessing.
 *
 * Notes are read from the live session via `hunk session comment list`
 * (authoritative — includes deletions); the note_created/note_edited events
 * are kept as a fallback when the session daemon is unreachable. GitHub
 * calls go through `gh`, so auth is whatever `gh auth status` says.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type {
  ExtensionCommandContext,
  ExtensionPaneProps,
  HunkExtensionAPI,
} from "hunkdiff/extension";
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

/* ------------------------------------------------------------------ */
/* PR target resolution                                                */
/* ------------------------------------------------------------------ */

type TargetPr = { number: string; title: string };

/** gh's default repo (respecting its remote priority); null when unresolvable. */
async function ghDefaultRepo(cwd: string): Promise<string | null> {
  try {
    return (await mustRun("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd })).trim();
  } catch {
    return null;
  }
}

/** Interactive variant for the submit flow — notifies on failure. */
async function resolveRepo(ctx: ExtensionCommandContext): Promise<string | null> {
  const envRepo = process.env.GH_PR_REPO?.trim();
  if (envRepo) return envRepo;
  const repo = await ghDefaultRepo(ctx.cwd);
  if (!repo) {
    ctx.notify("gh-review: not a GitHub repo or gh failed", "error");
  }
  return repo;
}

async function ghPrJson(args: string[], cwd: string, repo?: string): Promise<TargetPr> {
  const rflag = repo ? ["-R", repo] : [];
  const out = await mustRun("gh", [...args, "--json", "number,title", "--jq", '"\\(.number)\\t\\(.title)"', ...rflag], { cwd });
  const [number, ...rest] = out.trim().split("\t");
  return { number, title: rest.join("\t") };
}

/**
 * Non-interactive target for the threads pane: env first, then the
 * checked-out branch's open PR; null when there is no sensible target.
 */
async function resolveTargetQuiet(cwd: string): Promise<{ repo: string; pr: string } | null> {
  const envPr = process.env.GH_PR_NUMBER?.trim();
  const envRepo = process.env.GH_PR_REPO?.trim();
  const repo = envRepo || (await ghDefaultRepo(cwd));
  if (!repo) return null;
  if (envPr !== undefined) {
    return /^\d+$/.test(envPr) ? { repo, pr: envPr } : null;
  }
  try {
    const pr = (await mustRun("gh", ["pr", "view", "--json", "number", "--jq", ".number", "-R", repo], { cwd })).trim();
    return { repo, pr };
  } catch {
    return null;
  }
}

/**
 * Interactive target for submit. GH_PR_NUMBER (set by launchers that pipe a
 * PR diff into hunk) wins; set-but-empty means the launcher already determined
 * there is no open PR for this review, so we must NOT fall back to the
 * checked-out branch's PR (that would target the wrong PR). Unset means a
 * plain hunk session, where the checked-out branch's open PR is the sensible
 * target. Returns null — after notifying — when there is no PR to attach
 * notes to, since GitHub reviews cannot be left on a bare branch.
 */
async function resolveTargetPr(ctx: ExtensionCommandContext, repo: string): Promise<TargetPr | null> {
  const raw = process.env.GH_PR_NUMBER;
  if (raw !== undefined) {
    const envPr = raw.trim();
    if (/^\d+$/.test(envPr)) {
      try {
        return await ghPrJson(["pr", "view", envPr], ctx.cwd, repo);
      } catch (e) {
        ctx.notify(`gh-review: PR #${envPr} not found in ${repo}: ${(e as Error).message.split("\n")[0]}`, "error");
        return null;
      }
    }
    if (envPr === "") {
      ctx.notify(
        "gh-review: no open PR for this review — notes can't be submitted to a bare branch. Open a PR first (gh pr create).",
        "warning",
      );
      return null;
    }
    ctx.notify(`gh-review: GH_PR_NUMBER="${raw}" is not a PR number`, "error");
    return null;
  }
  try {
    return await ghPrJson(["pr", "view"], ctx.cwd, repo);
  } catch {
    ctx.notify(
      "gh-review: no open PR for the checked-out branch — notes can only be submitted to a PR. Open one first (gh pr create).",
      "warning",
    );
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* PR threads store                                                    */
/* ------------------------------------------------------------------ */

type GhComment = {
  id: number;
  in_reply_to_id?: number;
  path: string;
  line: number | null;
  original_line: number | null;
  side: "RIGHT" | "LEFT";
  body: string;
  user: { login: string } | null;
  created_at: string;
};

type Thread = { root: GhComment; replies: GhComment[] };

type ThreadsState = {
  phase: "idle" | "loading" | "no-pr" | "error" | "ready";
  message?: string;
  repo?: string;
  pr?: TargetPr;
  threads: Thread[];
  /** Comments dropped because they sit on outdated diff positions. */
  skippedOutdated: number;
  /** Thread root id last clicked or key-navigated to; the reply command targets it. */
  activeThreadId: number | null;
  /** True while the `threads` keyboard mode owns j/k navigation. */
  modeActive: boolean;
};

let snapshot: ThreadsState = { phase: "idle", threads: [], skippedOutdated: 0, activeThreadId: null, modeActive: false };
const listeners = new Set<() => void>();

function setThreadsState(update: Partial<ThreadsState>) {
  snapshot = { ...snapshot, ...update };
  for (const listener of listeners) listener();
}

function useThreadsSnapshot(): ThreadsState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

function groupThreads(comments: GhComment[]): { threads: Thread[]; skippedOutdated: number } {
  const usable = comments.filter((c) => typeof c.line === "number");
  const byId = new Map(usable.map((c) => [c.id, c]));
  const roots = usable.filter((c) => !c.in_reply_to_id || !byId.has(c.in_reply_to_id));
  const threads: Thread[] = roots.map((root) => ({ root, replies: [] }));
  const threadOf = new Map<number, Thread>();
  for (const t of threads) threadOf.set(t.root.id, t);
  const byTime = (a: GhComment, b: GhComment) => a.created_at.localeCompare(b.created_at);
  for (const c of usable.filter((c) => c.in_reply_to_id && byId.has(c.in_reply_to_id)).sort(byTime)) {
    // Walk up: a reply's in_reply_to_id may point at another reply.
    let cur: GhComment = c;
    while (cur.in_reply_to_id && byId.get(cur.in_reply_to_id)) {
      const parent: GhComment = byId.get(cur.in_reply_to_id)!;
      const t = threadOf.get(parent.id);
      if (t) {
        t.replies.push(c);
        break;
      }
      cur = parent;
    }
  }
  threads.sort((a, b) => a.root.created_at.localeCompare(b.root.created_at));
  return { threads, skippedOutdated: comments.length - usable.length };
}

/** Move the active thread. No-op unless threads are loaded; clamps at the ends. */
function moveActiveThread(delta: 1 | -1 | "first" | "last") {
  if (snapshot.phase !== "ready" || snapshot.threads.length === 0) return;
  const ids = snapshot.threads.map((t) => t.root.id);
  const cur = snapshot.activeThreadId == null ? -1 : ids.indexOf(snapshot.activeThreadId);
  let next: number;
  if (delta === "first") next = 0;
  else if (delta === "last") next = ids.length - 1;
  else next = Math.min(ids.length - 1, Math.max(0, (cur < 0 ? (delta === 1 ? -1 : ids.length) : cur) + delta));
  setThreadsState({ activeThreadId: ids[next] });
}

async function fetchThreads(cwd: string, notify?: (message: string) => void): Promise<void> {
  setThreadsState({ phase: "loading", activeThreadId: null });
  const target = await resolveTargetQuiet(cwd);
  if (!target) {
    setThreadsState({ phase: "no-pr", threads: [], skippedOutdated: 0 });
    return;
  }
  try {
    const [commentsOut, pr] = await Promise.all([
      mustRun("gh", ["api", `repos/${target.repo}/pulls/${target.pr}/comments?per_page=100`, "--paginate", "--slurp"], { cwd }),
      ghPrJson(["pr", "view", target.pr], cwd, target.repo).catch(() => ({ number: target.pr, title: "" })),
    ]);
    // gh api --paginate --slurp yields one array PER PAGE ([[...],[...]]),
    // not a flat list — flatten before grouping or every comment is dropped.
    const parsed = JSON.parse(commentsOut);
    const comments = (Array.isArray(parsed) && parsed.every(Array.isArray) ? parsed.flat() : parsed) as GhComment[];
    const { threads, skippedOutdated } = groupThreads(comments);
    setThreadsState({ phase: "ready", repo: target.repo, pr, threads, skippedOutdated });
    if (threads.length > 0) {
      notify?.(`PR #${pr.number}: ${threads.length} review thread${threads.length === 1 ? "" : "s"} — press T`);
    }
  } catch (e) {
    setThreadsState({ phase: "error", message: (e as Error).message.split("\n")[0], threads: [] });
  }
}

/* ------------------------------------------------------------------ */
/* Threads pane component                                              */
/* ------------------------------------------------------------------ */

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    let cur = "";
    for (const w of words) {
      if (!cur) cur = w;
      else if (`${cur} ${w}`.length <= width) cur += ` ${w}`;
      else {
        out.push(cur);
        cur = w;
      }
    }
    out.push(cur);
  }
  return out.length > 0 ? out : [""];
}

function CommentRows({
  comment,
  indent,
  width,
  theme,
  maxLines,
}: {
  comment: GhComment;
  indent: string;
  width: number;
  theme: ExtensionPaneProps["theme"];
  maxLines: number;
}): ReactNode {
  const author = `@${comment.user?.login ?? "ghost"}`;
  const bodyWidth = Math.max(width - indent.length - 1, 10);
  const lines = wrapText(comment.body, bodyWidth);
  const clipped = lines.length > maxLines;
  return (
    <>
      <text content={`${indent}${author}`} style={{ fg: theme.accent, bg: theme.panel }} />
      {(clipped ? [...lines.slice(0, maxLines), "…"] : lines).map((line, i) => (
        <text key={i} content={`${indent}${line}`} style={{ fg: theme.muted, bg: theme.panel }} />
      ))}
    </>
  );
}

function PrThreadsPane({ files, width, theme, actions }: ExtensionPaneProps): ReactNode {
  const state = useThreadsSnapshot();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  const reveal = (thread: Thread) => {
    const file = files.find((f) => f.path === thread.root.path);
    if (file && typeof thread.root.line === "number") {
      actions.revealLine(file.id, thread.root.side === "LEFT" ? "old" : "new", thread.root.line);
    }
  };
  const navigateTo = (thread: Thread) => {
    setThreadsState({ activeThreadId: thread.root.id });
    reveal(thread);
  };

  // Keep the active thread visible, and while the threads keyboard mode owns
  // input, follow it in the review stream too (that is the mode's whole job:
  // modes cannot navigate directly, they only receive keys).
  useEffect(() => {
    if (state.phase !== "ready" || state.activeThreadId == null) return;
    scrollRef.current?.scrollChildIntoView(`thread-${state.activeThreadId}`);
    if (!state.modeActive) return;
    const thread = state.threads.find((t) => t.root.id === state.activeThreadId);
    if (thread) reveal(thread);
  }, [state.activeThreadId, state.modeActive, state.phase]);

  let body: ReactNode;
  switch (state.phase) {
    case "idle":
    case "loading":
      body = <text content=" Loading PR threads…" style={{ fg: theme.muted, bg: theme.panel }} />;
      break;
    case "no-pr":
      body = (
        <text
          content=" No open PR for this review — threads unavailable"
          style={{ fg: theme.muted, bg: theme.panel }}
        />
      );
      break;
    case "error":
      body = (
        <text content={` Error loading threads: ${state.message}`} style={{ fg: theme.badgeRemoved, bg: theme.panel }} />
      );
      break;
    case "ready":
      body = (
        <>
          <text
            content={` PR #${state.pr!.number} · ${state.threads.length} thread${state.threads.length === 1 ? "" : "s"}${
              state.skippedOutdated > 0 ? ` (${state.skippedOutdated} outdated hidden)` : ""
            }`}
            style={{ fg: theme.muted, bg: theme.panel }}
          />
          {state.threads.map((thread) => {
            const active = thread.root.id === state.activeThreadId;
            const rowBg = active ? theme.selectedHunk : theme.panel;
            return (
              <box key={thread.root.id} id={`thread-${thread.root.id}`} style={{ flexDirection: "column", backgroundColor: rowBg }}>
                <text
                  content={` ${thread.root.path}:${thread.root.line}`}
                  style={{ fg: theme.text, bg: rowBg }}
                  onMouseDown={() => navigateTo(thread)}
                />
                <box onMouseDown={() => navigateTo(thread)}>
                  <CommentRows comment={thread.root} indent="  " width={width} theme={theme} maxLines={4} />
                </box>
                {thread.replies.map((reply) => (
                  <box key={reply.id} onMouseDown={() => navigateTo(thread)}>
                    <CommentRows comment={reply} indent="   ↳ " width={width} theme={theme} maxLines={2} />
                  </box>
                ))}
                <text content="" style={{ bg: rowBg }} />
              </box>
            );
          })}
          {state.threads.length === 0 ? (
            <text content=" No review threads yet" style={{ fg: theme.muted, bg: theme.panel }} />
          ) : null}
        </>
      );
      break;
  }

  return (
    <scrollbox
      ref={scrollRef}
      width="100%"
      height="100%"
      focused={false}
      scrollY={true}
      rootOptions={{ backgroundColor: theme.panel }}
      wrapperOptions={{ backgroundColor: theme.panel }}
      viewportOptions={{ backgroundColor: theme.panel }}
      contentOptions={{ backgroundColor: theme.panel }}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
        <text content=" PR threads" style={{ fg: theme.accent, bg: theme.panel }} />
        {state.modeActive ? (
          <text content=" j/k move · enter/esc back to diff" style={{ fg: theme.accentMuted, bg: theme.panel }} />
        ) : null}
        {body}
      </box>
    </scrollbox>
  );
}

/* ------------------------------------------------------------------ */
/* Submit flow                                                         */
/* ------------------------------------------------------------------ */

async function submitReview(ctx: ExtensionCommandContext, collected: Map<string, Note>): Promise<void> {
  // 1. Gather notes: session CLI first (sees deletions), event cache as fallback.
  // Notes are optional: approvals and body-only reviews need none.
  let notes: Note[];
  try {
    notes = await fetchSessionNotes(ctx.cwd);
  } catch {
    notes = [...collected.values()];
  }

  // 2. Resolve repo + the PR this review belongs to. The number is never
  // typed by hand: notes can only sensibly land on the PR whose diff is
  // loaded (comment line positions must match that PR's head diff).
  const nameWithOwner = await resolveRepo(ctx);
  if (!nameWithOwner) return; // resolveRepo already explained why

  const pr = await resolveTargetPr(ctx, nameWithOwner);
  if (!pr) return; // resolveTargetPr already explained why

  const noteCount = notes.length;
  const ok = await ctx.dialogs.confirm({
    title:
      noteCount > 0
        ? `Submit ${noteCount} note${noteCount === 1 ? "" : "s"} to PR #${pr.number}?`
        : `Submit a review with no inline notes to PR #${pr.number}?`,
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

  // Matching the GitHub UI: only Comment requires content. Approve and
  // Request changes submit fine with no notes and no body. (The REST docs
  // nominally require a body field for REQUEST_CHANGES, so an empty string
  // is sent rather than omitting it.)
  const needsBody = noteCount === 0 && event === "COMMENT";
  const bodyInput = await ctx.dialogs.input({
    title: needsBody ? "Review body (required — no inline notes)" : "Review body (optional — escape to skip)",
    placeholder: "Top-level review comment",
  });
  if (bodyInput === null && needsBody) return; // escape cancels a required field
  const body = (bodyInput ?? "").trim();
  if (needsBody && !body) {
    ctx.notify("gh-review: a top-level body is required when a Comment review has no inline notes", "warning");
    return;
  }

  // 3. Post one atomic review: comments + event in a single call.
  const payload = {
    event,
    ...(body ? { body } : event === "REQUEST_CHANGES" ? { body: "" } : {}),
    ...(noteCount > 0
      ? {
          comments: notes.map((n) => ({
            path: n.filePath,
            line: n.line,
            side: n.side === "old" ? "LEFT" : "RIGHT",
            body: n.body,
          })),
        }
      : {}),
  };
  const tmp = join(tmpdir(), `hunk-gh-review-${Date.now()}.json`);
  try {
    writeFileSync(tmp, JSON.stringify(payload));
    await mustRun("gh", ["api", `repos/${nameWithOwner}/pulls/${prNumber}/reviews`, "--method", "POST", "--input", tmp], {
      cwd: ctx.cwd,
    });
  } catch (e) {
    ctx.notify(`gh-review: GitHub rejected the review: ${(e as Error).message.split("\n")[0]}`, "error");
    return;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }

  // 4. Clear the submitted notes so a second press doesn't double-post.
  if (noteCount > 0) {
    try {
      await run("hunk", ["session", "comment", "clear", "--repo", ctx.cwd, "--include-user", "--yes"], { cwd: ctx.cwd });
    } catch {
      // Session daemon unreachable — notes stay, harmless.
    }
    collected.clear();
  }

  ctx.notify(
    noteCount > 0
      ? `Submitted ${choice} review with ${noteCount} comment${noteCount === 1 ? "" : "s"} on PR #${prNumber}`
      : `Submitted ${choice} review on PR #${prNumber}`,
  );
  void fetchThreads(ctx.cwd); // the new review's comments belong in the pane
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

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

  // Fetch threads once the review content is known (and on reloads).
  hunk.on("changeset_loaded", (_payload, ctx) => void fetchThreads(ctx.cwd, (m) => ctx.notify(m)));
  hunk.on("session_reload", (_payload, ctx) => void fetchThreads(ctx.cwd, (m) => ctx.notify(m)));

  hunk.registerPane({
    id: "threads",
    title: "PR threads",
    placement: "right",
    width: { preferred: 44, min: 28 },
    component: PrThreadsPane,
  });

  hunk.registerCommand({ id: "submit", title: "Submit notes as GitHub PR review", key: "S" }, (ctx) =>
    submitReview(ctx, collected),
  );

  // Keyboard mode: while active, j/k walk the thread list and the review
  // stream follows (the pane's follow effect calls revealLine — modes receive
  // keys but deliberately cannot navigate). Unhandled keys pass through, so
  // R (reply), c (note), etc. keep working; esc exits host-side.
  hunk.registerKeyboardMode({
    id: "threads",
    title: "PR threads",
    onKey: (key) => {
      switch (key.name) {
        case "j":
        case "down":
          moveActiveThread(1);
          return "handled";
        case "k":
        case "up":
          moveActiveThread(-1);
          return "handled";
        case "g":
          moveActiveThread("first");
          return "handled";
        case "G":
          moveActiveThread("last");
          return "handled";
        case "q":
        case "T":
        case "return":
        case "enter":
          return "exit";
        default:
          return "pass";
      }
    },
    onEnter: () => setThreadsState({ modeActive: true }),
    onExit: () => setThreadsState({ modeActive: false }),
  });

  hunk.registerCommand({ id: "threads", title: "PR threads pane + keyboard mode", key: "T" }, (ctx) => {
    const willOpen = !ctx.panes.isOpen("threads");
    ctx.panes.toggle("threads");
    if (!willOpen) {
      if (ctx.keyboardModes.isActive("threads")) ctx.keyboardModes.exitMode();
      return;
    }
    if (snapshot.phase === "ready" && snapshot.threads.length > 0) {
      if (snapshot.activeThreadId == null) setThreadsState({ activeThreadId: snapshot.threads[0].root.id });
      ctx.keyboardModes.enterMode("threads");
    } else if (snapshot.phase === "ready") {
      ctx.notify("gh-review: no review threads on this PR");
    } else {
      ctx.notify("gh-review: threads unavailable for this review", "warning");
    }
  });

  hunk.registerCommand({ id: "refresh-threads", title: "Refresh PR threads" }, async (ctx) => {
    await fetchThreads(ctx.cwd);
    ctx.notify(snapshot.phase === "ready" ? "PR threads refreshed" : "PR threads unavailable for this review", snapshot.phase === "ready" ? "info" : "warning");
  });

  hunk.registerCommand({ id: "reply", title: "Reply to selected PR thread", key: "R" }, async (ctx) => {
    const state = snapshot;
    if (state.phase !== "ready") {
      ctx.notify("gh-review: no PR threads loaded for this review", "warning");
      return;
    }
    const thread = state.activeThreadId ? state.threads.find((t) => t.root.id === state.activeThreadId) : undefined;
    if (!thread) {
      ctx.panes.open("threads");
      ctx.notify("gh-review: click a thread in the PR threads pane first", "warning");
      return;
    }
    const author = thread.root.user?.login ?? "thread";
    const body = await ctx.dialogs.input({
      title: `Reply to @${author} (${thread.root.path}:${thread.root.line})`,
      placeholder: "Reply…",
    });
    if (body === null || !body.trim()) return;
    try {
      await mustRun(
        "gh",
        ["api", `repos/${state.repo}/pulls/${state.pr!.number}/comments/${thread.root.id}/replies`, "--method", "POST", "-f", `body=${body.trim()}`],
        { cwd: ctx.cwd },
      );
    } catch (e) {
      ctx.notify(`gh-review: reply failed: ${(e as Error).message.split("\n")[0]}`, "error");
      return;
    }
    ctx.notify(`Replied to @${author}'s thread`);
    await fetchThreads(ctx.cwd);
  });
}

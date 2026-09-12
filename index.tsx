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
 *
 * Bonus: hunk's built-in `e` key (open file in editor) hard-errors with
 * "$EDITOR is not set." when the variable is missing, so this extension sets
 * $EDITOR for the session — config `editor` first, else $EDITOR/$VISUAL,
 * git's editor, then a PATH default.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { SyntaxStyle, TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { renderCommentMarkdown } from "./comment-markdown";
import type {
  ExtensionCommandContext,
  ExtensionPaneProps,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* Editor resolution for the built-in `e` key                          */
/* ------------------------------------------------------------------ */

/**
 * Fallback editors, checked in order on PATH when nothing was configured.
 * Terminal editors come first — they run anywhere, including over SSH and
 * in headless sessions; GUI editors follow since they need a desktop.
 * Within each group the most common names lead. This is a last resort for
 * users who configured nothing — anyone with $EDITOR/$VISUAL/git's editor
 * or the `editor` config key is never affected. Ordering is best-effort,
 * not a recommendation: users who care set one of the options above and
 * skip this list entirely.
 */
const DEFAULT_EDITOR_CANDIDATES = [
  "editor", // platform convention (Debian alternatives, macOS /usr/bin/editor)
  "vim", "nvim", "vi", // near-universal terminal editors
  "nano", "micro", "emacs", // other common terminal editors
  "hx", // helix
  "code", // VS Code — the near-universal GUI editor
  "zed", "subl", "idea", // common GUI editors (Zed, Sublime, IntelliJ)
  "cursor", "devin-desktop", // agent-focused IDEs (Cursor IDE CLI, Devin Desktop IDE)
];

/** Resolve an editor command string ("/usr/bin/editor -w" keeps its args). */
async function resolveEditor(cwd: string): Promise<string | null> {
  // 1. An explicit $EDITOR is never overridden.
  const explicit = process.env.EDITOR?.trim();
  if (explicit) return explicit;
  // 2. Honour $VISUAL, then git's editor (env var, then config).
  const visual = process.env.VISUAL?.trim();
  if (visual) return visual;
  const gitEditor = process.env.GIT_EDITOR?.trim();
  if (gitEditor) return gitEditor;
  try {
    const configured = (await mustRun("git", ["config", "--get", "core.editor"], { cwd })).trim();
    if (configured) return configured;
  } catch {
    // No git config / not a repo — fall through to the defaults.
  }
  // 3. First editor on PATH — terminal editors first (they run anywhere,
  //    including over SSH), then common GUI editors. See the list's docs.
  for (const candidate of DEFAULT_EDITOR_CANDIDATES) {
    if (await hasOnPath(candidate)) return candidate;
  }
  return null;
}

function hasOnPath(program: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", program]);
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/**
 * Hunk's built-in `e` key opens the selected file via $EDITOR and hard-errors
 * with "$EDITOR is not set." when the variable is absent. Set it once here so
 * the key keeps working in shells that never exported it. Order: config
 * `editor`, then $EDITOR, $VISUAL, git's editor, then a PATH default.
 */
async function ensureEditorEnv(cwd: string, configured: string | null, log: (message: string) => void): Promise<void> {
  if (process.env.EDITOR?.trim()) return; // explicit $EDITOR wins, always
  const editor: Promise<string | null> = configured ? Promise.resolve(configured) : resolveEditor(cwd);
  const resolved = await editor;
  if (resolved) {
    process.env.EDITOR = resolved;
    log(`resolved EDITOR="${resolved}" for the e key (set one explicitly to override)`);
  } else if (configured === null) {
    log("could not resolve an editor for the e key — set $EDITOR or [extension.gh-review] editor");
  }
}

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

/** Resolve an open PR without assuming the local branch has the remote name. */
async function resolveCheckoutPr(cwd: string, repo: string): Promise<string | null> {
  const branchResult = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
  if (branch) {
    const upstream = (await mustRun("git", [
      "for-each-ref", "--format=%(upstream:remoteref)", `refs/heads/${branch}`,
    ], { cwd })).trim().replace(/^refs\/heads\//, "");
    // The tracking branch remains useful while local commits are not pushed yet.
    for (const candidate of new Set([upstream, branch].filter(Boolean))) {
      const matches: { number: number }[] = JSON.parse(await mustRun("gh", [
        "pr", "list", "--head", candidate, "--state", "open", "--limit", "2",
        "--json", "number", "-R", repo,
      ], { cwd }));
      if (matches.length > 1) return null;
      if (matches.length === 1) return String(matches[0].number);
    }
  }

  // A push such as HEAD:existing-pr may leave no tracking branch. GitHub's
  // commit association also includes ancestor commits and closed PRs, so only
  // accept one open PR whose current head is exactly this checkout's HEAD.
  const head = (await mustRun("git", ["rev-parse", "HEAD"], { cwd })).trim();
  const pages = JSON.parse(await mustRun("gh", [
    "api", `repos/${repo}/commits/${head}/pulls`, "--paginate", "--slurp",
  ], { cwd }));
  const matches: { number: number; state: string; head: { sha: string }; base: { repo: { full_name: string } } }[] = pages.flat();
  const numbers = new Set(matches.filter(pr =>
    pr.state === "open" && pr.head.sha === head
    && pr.base.repo.full_name.toLowerCase() === repo.toLowerCase(),
  ).map(pr => String(pr.number)));
  return numbers.size === 1 ? [...numbers][0] : null;
}

/**
 * Non-interactive target for the threads pane: env first, then the
 * checkout's open PR; null when there is no unique target.
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
    const pr = await resolveCheckoutPr(cwd, repo);
    return pr ? { repo, pr } : null;
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
    const pr = await resolveCheckoutPr(ctx.cwd, repo);
    if (pr) return await ghPrJson(["pr", "view", pr], ctx.cwd, repo);
  } catch {
    ctx.notify("gh-review: PR lookup failed; check gh authentication and repository access", "error");
    return null;
  }
  ctx.notify("gh-review: no unique open PR for this checkout; set GH_PR_NUMBER and GH_PR_REPO explicitly", "warning");
  return null;
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
  /** Discussions retained for reading after their diff positions become outdated. */
  outdatedThreads: number;
  /** Thread root id last clicked or key-navigated to; the reply command targets it. */
  activeThreadId: number | null;
  /** True while the `threads` keyboard mode owns j/k navigation. */
  modeActive: boolean;
  /** Display preference only; fetched comment bodies always retain their source. */
  renderMarkdown: boolean;
};

let snapshot: ThreadsState = { phase: "idle", threads: [], outdatedThreads: 0, activeThreadId: null, modeActive: false, renderMarkdown: true };
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

function groupThreads(comments: GhComment[]): { threads: Thread[]; outdatedThreads: number } {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const roots = comments.filter((c) => !c.in_reply_to_id || !byId.has(c.in_reply_to_id));
  const threads: Thread[] = roots.map((root) => ({ root, replies: [] }));
  const threadOf = new Map<number, Thread>();
  for (const t of threads) threadOf.set(t.root.id, t);
  const byTime = (a: GhComment, b: GhComment) => a.created_at.localeCompare(b.created_at);
  for (const c of comments.filter((c) => c.in_reply_to_id && byId.has(c.in_reply_to_id)).sort(byTime)) {
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
  return { threads, outdatedThreads: roots.filter(c => typeof c.line !== "number").length };
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
    setThreadsState({ phase: "no-pr", threads: [], outdatedThreads: 0 });
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
    const { threads, outdatedThreads } = groupThreads(comments);
    setThreadsState({ phase: "ready", repo: target.repo, pr, threads, outdatedThreads });
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

function CommentRows({
  comment,
  width,
  theme,
  background,
  maxLines,
  renderMarkdown,
  syntaxStyle,
}: {
  comment: GhComment;
  width: number;
  theme: ExtensionPaneProps["theme"];
  background: string;
  maxLines: number;
  renderMarkdown: boolean;
  syntaxStyle: SyntaxStyle;
}): ReactNode {
  const author = `@${comment.user?.login ?? "ghost"}`;
  const bodyWidth = Math.max(width, 10);
  const markdown = useMemo(() => renderMarkdown ? renderCommentMarkdown(comment.body) : "", [comment.body, renderMarkdown]);
  return (
    <>
      <text content={author} attributes={TextAttributes.BOLD} style={{ fg: theme.text, bg: background }} />
      <box marginTop={1} width={bodyWidth} maxHeight={Number.isFinite(maxLines) ? maxLines : undefined} overflow="hidden" flexShrink={0}>
        {renderMarkdown ? (
          <markdown content={markdown} syntaxStyle={syntaxStyle} fg={theme.text} bg={background}
            conceal={true} concealCode={true} streaming={false} width="100%"
            tableOptions={{ style: "columns", widthMode: "full", wrapMode: "word" }} />
        ) : (
          <text content={comment.body} wrapMode="word" width="100%" style={{ fg: theme.text, bg: background }} />
        )}
      </box>
    </>
  );
}

function PrThreadsPane({ files, width, theme, actions }: ExtensionPaneProps): ReactNode {
  const state = useThreadsSnapshot();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const syntaxStyle = useMemo(() => SyntaxStyle.fromStyles({
    default: { fg: theme.text },
    "markup.heading": { fg: theme.accent, bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.strikethrough": { dim: true },
    "markup.link": { fg: theme.accent, underline: true },
    "markup.raw": { fg: theme.text },
  }), [theme.text, theme.accent]);
  useEffect(() => () => syntaxStyle.destroy(), [syntaxStyle]);

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
              state.outdatedThreads > 0 ? ` (${state.outdatedThreads} outdated)` : ""
            }`}
            style={{ fg: theme.muted, bg: theme.panel }}
          />
          {state.threads.map((thread) => {
            const active = thread.root.id === state.activeThreadId;
            const rowBg = active ? theme.selectedHunk : theme.panel;
            return (
              <box key={thread.root.id} id={`thread-${thread.root.id}`} marginTop={1} paddingBottom={1}
                border={["top"]} borderColor={active ? theme.accent : theme.border}
                style={{ flexDirection: "column", backgroundColor: theme.panel }}>
                <text
                  content={` ${thread.root.path}:${thread.root.line ?? thread.root.original_line ?? "?"}${
                    typeof thread.root.line !== "number" ? " (outdated)" : ""
                  }`}
                  attributes={active ? TextAttributes.BOLD : undefined}
                  style={{ fg: active ? theme.accent : theme.muted, bg: rowBg }}
                  onMouseDown={() => navigateTo(thread)}
                />
                <box marginTop={1} marginLeft={2} marginRight={1} onMouseDown={() => navigateTo(thread)}>
                  <CommentRows comment={thread.root} width={width - 3} theme={theme} background={theme.panel}
                    maxLines={active ? Infinity : 4} renderMarkdown={state.renderMarkdown} syntaxStyle={syntaxStyle} />
                </box>
                {thread.replies.length > 0 ? (
                  <box marginTop={1} marginLeft={2} marginRight={1} paddingLeft={1}
                    border={["left"]} borderColor={active ? theme.accentMuted : theme.border}
                    style={{ flexDirection: "column", backgroundColor: theme.panelAlt }}>
                    <text content={`${thread.replies.length} ${thread.replies.length === 1 ? "reply" : "replies"}`}
                      style={{ fg: theme.muted, bg: theme.panelAlt }} />
                    {thread.replies.map((reply, index) => (
                      <box key={reply.id} marginTop={1} onMouseDown={() => navigateTo(thread)}>
                        {index > 0 ? <box border={["top"]} borderColor={theme.border} height={1} marginBottom={1} /> : null}
                        <CommentRows comment={reply} width={width - 5} theme={theme} background={theme.panelAlt}
                          maxLines={active ? Infinity : 2} renderMarkdown={state.renderMarkdown} syntaxStyle={syntaxStyle} />
                      </box>
                    ))}
                  </box>
                ) : null}
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
        <text content={` PR threads · ${state.renderMarkdown ? "Markdown" : "Raw"}`} style={{ fg: theme.accent, bg: theme.panel }} />
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
  setThreadsState({ renderMarkdown: hunk.config.render_markdown !== false });
  // The e key needs $EDITOR; resolve it once, before any review starts.
  const configuredEditor =
    typeof hunk.config.editor === "string" && hunk.config.editor.trim() ? hunk.config.editor.trim() : null;
  void ensureEditorEnv(process.cwd(), configuredEditor, (m) => hunk.log(m));

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

  // Placement is configurable because Hunk omits panes that don't fit:
  // a side pane needs (terminal width - minReviewWidth - divider) >= its min
  // columns, which fails on narrow terminals; a bottom pane only needs rows.
  const placementRaw = typeof hunk.config.placement === "string" ? hunk.config.placement : "right";
  const placement = (["left", "right", "top", "bottom"] as const).includes(placementRaw as "left")
    ? (placementRaw as "left" | "right" | "top" | "bottom")
    : "right";
  hunk.registerPane(
    placement === "top" || placement === "bottom"
      ? {
          id: "threads",
          title: "PR threads",
          placement,
          height: { preferred: 12, min: 5 },
          component: PrThreadsPane,
        }
      : {
          id: "threads",
          title: "PR threads",
          placement,
          width: { preferred: 44, min: 22 },
          component: PrThreadsPane,
        },
  );

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

  hunk.registerCommand({ id: "threads", title: "PR threads pane + keyboard mode", key: "T" }, async (ctx) => {
    const willOpen = !ctx.panes.isOpen("threads");
    ctx.panes.toggle("threads");
    if (!willOpen) {
      if (ctx.keyboardModes.isActive("threads")) ctx.keyboardModes.exitMode();
      return;
    }
    // A push can create the PR association without changing the watched diff.
    await fetchThreads(ctx.cwd);
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

  hunk.registerCommand({ id: "toggle-markdown", title: "Toggle PR comment Markdown rendering", key: "alt+m" }, (ctx) => {
    setThreadsState({ renderMarkdown: !snapshot.renderMarkdown });
    ctx.notify(`PR comments: ${snapshot.renderMarkdown ? "Markdown" : "raw text"}`);
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

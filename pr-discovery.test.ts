import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn as originalSpawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";

// Git runs against disposable real repositories. GitHub responses are synthetic;
// reject the real CLI's invalid argument shape and every publishing command.
const spawnGit = originalSpawn;
const repo = "fixture/repository";
let cwd: string;
let head: string;
let branchPrs: Record<string, number[]>;
let commitPrs: any[];
let calls: string[][];
let comments: any[];
let pane: any;
let registeredCommands: Map<string, Function>;
const originalEnv = { GH_PR_NUMBER: process.env.GH_PR_NUMBER, GH_PR_REPO: process.env.GH_PR_REPO, EDITOR: process.env.EDITOR };

const react = { ...React };
mock.module("react", () => ({
  ...react, useEffect() {}, useRef: () => ({ current: null }), useMemo: (factory: Function) => factory(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: Function) => getSnapshot(),
}));

mock.module("node:child_process", () => ({
  spawn(cmd: string, args: string[], opts: any) {
    if (cmd === "git") return spawnGit(cmd, args, opts);
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {
      queueMicrotask(() => {
        calls.push([cmd, ...args]);
        try {
          if (cmd !== "gh" || args.includes("POST")) throw new Error("Unexpected publishing command");
          let out: unknown;
          if (args[0] === "repo") out = `${repo}\n`;
          else if (args[0] === "pr" && args[1] === "view") {
            if (!args[2] || args[2].startsWith("-")) throw new Error("argument required when using the --repo flag");
            out = `${args[2]}\tSynthetic PR\n`;
          } else if (args[0] === "pr" && args[1] === "list") {
            const branch = args[args.indexOf("--head") + 1];
            out = JSON.stringify((branchPrs[branch] ?? []).map(number => ({ number })));
          } else if (args[0] === "api" && args[1] === `repos/${repo}/commits/${head}/pulls`) {
            out = JSON.stringify([commitPrs]);
          } else if (args[0] === "api" && /\/pulls\/\d+\/comments\?/.test(args[1])) {
            out = JSON.stringify([comments]);
          } else throw new Error(`Unexpected read: ${args.join(" ")}`);
          child.stdout.emit("data", out);
          child.emit("close", 0);
        } catch (error) {
          child.stderr.emit("data", String(error));
          child.emit("close", 1);
        }
      });
    } };
    return child;
  },
}));

const { default: extension } = await import("./dist/index.js");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function pr(number: number, sha = head, state = "open", baseRepo = repo) {
  return { number, state, head: { sha }, base: { repo: { full_name: baseRepo } } };
}

async function refresh(config: Record<string, unknown> = {}): Promise<string[]> {
  const commands = new Map<string, Function>();
  registeredCommands = commands;
  const messages: string[] = [];
  extension({
    config: { editor: "synthetic-editor", ...config }, log() {}, on() {},
    registerCommand(command: { id: string }, handler: Function) { commands.set(command.id, handler); },
    registerPane(config: any) { pane = config.component; }, registerKeyboardMode() {},
  } as any);
  await commands.get("refresh-threads")!({ cwd, notify(message: string) { messages.push(message); } });
  return messages;
}

async function expectThreads(number: number) {
  expect(await refresh()).toContain("PR threads refreshed");
  expect(calls.some(call => call[0] === "gh" && call[1] === "api"
    && call[2] === `repos/${repo}/pulls/${number}/comments?per_page=100`)).toBe(true);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hunk-pr-discovery-"));
  git("init", "-b", "feature");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  git("remote", "add", "origin", `https://github.com/${repo}`);
  head = git("rev-parse", "HEAD");
  branchPrs = {};
  commitPrs = [];
  calls = [];
  comments = [{
    id: 1, path: "file.ts", line: 10, original_line: 10,
    side: "RIGHT", body: "Synthetic review thread", user: { login: "reviewer" },
    created_at: "2026-01-01T00:00:00Z",
  }];
  delete process.env.GH_PR_NUMBER;
  delete process.env.GH_PR_REPO;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("loads threads for the current branch without an invalid gh pr view invocation", async () => {
  branchPrs.feature = [218];
  await expectThreads(218);
});

test("renamed worktree branch resolves its tracking branch even before the next push", async () => {
  git("update-ref", "refs/remotes/origin/existing-pr", head);
  git("branch", "--set-upstream-to=origin/existing-pr");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "local follow-up");
  head = git("rev-parse", "HEAD");
  branchPrs["existing-pr"] = [218];
  await expectThreads(218);
});

test("renamed branch without tracking resolves a unique open PR at HEAD", async () => {
  commitPrs = [pr(218)];
  await expectThreads(218);
});

test("detached HEAD resolves a unique open PR at that commit", async () => {
  git("checkout", "--detach");
  commitPrs = [pr(218)];
  await expectThreads(218);
});

test("commit discovery ignores closed PRs, ancestor associations, and other repositories", async () => {
  commitPrs = [pr(1, head, "closed"), pr(2, "a".repeat(40)), pr(3, head, "open", "other/repo"), pr(218)];
  await expectThreads(218);
});

test("ambiguous branch matches do not choose a PR or fall back to HEAD", async () => {
  branchPrs.feature = [218, 219];
  commitPrs = [pr(218)];
  expect(await refresh()).toContain("PR threads unavailable for this review");
  expect(calls.some(call => call.some(arg => arg.includes("/comments?")))).toBe(false);
});

test("ambiguous commit matches do not choose a PR", async () => {
  commitPrs = [pr(218), pr(219)];
  expect(await refresh()).toContain("PR threads unavailable for this review");
  expect(calls.some(call => call.some(arg => arg.includes("/comments?")))).toBe(false);
});

test("explicit PR identity wins over checkout discovery", async () => {
  process.env.GH_PR_NUMBER = "42";
  process.env.GH_PR_REPO = repo;
  branchPrs.feature = [218];
  await expectThreads(42);
});

test("explicitly empty PR identity never falls back to the checkout", async () => {
  process.env.GH_PR_NUMBER = "";
  process.env.GH_PR_REPO = repo;
  commitPrs = [pr(218)];
  expect(await refresh()).toContain("PR threads unavailable for this review");
  expect(calls).toEqual([]);
});

test("outdated discussions and replies stay readable without jumping to obsolete lines", async () => {
  process.env.GH_PR_NUMBER = "218";
  const root = { ...comments[0], line: null, body: "Synthetic review thread\nSecond line\nThird line\nFourth line\nLast line of the finding" };
  comments = [root, { ...root, id: 2, in_reply_to_id: 1, body: "Synthetic reply\nSecond reply line\nLast line of the reply" },
    { ...comments[0], id: 3, line: 20, body: "Current thread" }];
  await expectThreads(218);
  const revealed: unknown[][] = [];
  const props = { files: [{ id: "file-1", path: "file.ts" }], width: 80, theme: {},
    actions: { revealLine(...args: unknown[]) { revealed.push(args); } },
  };
  const tree = pane(props);
  function elements(node: any): any[] {
    if (node == null || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(elements);
    if (typeof node.type === "function") return elements(node.type(node.props));
    return [node, ...elements(node.props?.children)];
  }
  const rows = elements(tree);
  const text = rows.map(row => row.props?.content ?? "").join("\n");
  expect(text).toContain("PR #218 · 2 threads (1 outdated)");
  expect(text).toContain("Synthetic review thread");
  expect(text).toContain("Synthetic reply");
  rows.find(row => row.props?.content === " file.ts:10 (outdated)").props.onMouseDown();
  expect(revealed).toEqual([]);
  const expanded = elements(pane(props)).map(row => row.props?.content ?? "").join("\n");
  expect(expanded).toContain("Last line of the finding");
  expect(expanded).toContain("Last line of the reply");
  rows.find(row => row.props?.content === " file.ts:20").props.onMouseDown();
  expect(revealed).toEqual([["file-1", "new", 20]]);
});

test("opening threads retries discovery after a push creates the PR association", async () => {
  expect(await refresh()).toContain("PR threads unavailable for this review");
  commitPrs = [pr(218)];
  let entered = false;
  await registeredCommands.get("threads")!({ cwd, notify() {},
    panes: { isOpen: () => false, toggle() {} },
    keyboardModes: { enterMode() { entered = true; } },
  });
  expect(entered).toBe(true);
  expect(calls.some(call => call[2] === `repos/${repo}/pulls/218/comments?per_page=100`)).toBe(true);
});

function renderedElements(node: any): any[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(renderedElements);
  if (typeof node.type === "function") return renderedElements(node.type(node.props));
  return [node, ...renderedElements(node.props?.children)];
}

test("Markdown defaults on and toggles to the exact source without fetching again", async () => {
  process.env.GH_PR_NUMBER = "218";
  const body = '<a href="#"><img alt="P1" src="https://example.test/badge.svg"></a> **Finding**\n\n```ts\n  <literal> &amp;\n```';
  comments[0].body = body;
  await refresh();
  const props = { files: [], width: 80, theme: {}, actions: {} };
  const rows = () => renderedElements(pane(props));
  expect(rows().find(row => row.type === "markdown").props.content).toContain("P1 **Finding**");
  const fetches = calls.length;
  registeredCommands.get("toggle-markdown")!({ notify() {} });
  expect(rows().some(row => row.type === "markdown")).toBe(false);
  expect(rows().find(row => row.props?.content === body)?.type).toBe("text");
  expect(rows().some(row => row.props?.content?.includes?.("PR threads · Raw"))).toBe(true);
  registeredCommands.get("toggle-markdown")!({ notify() {} });
  expect(rows().some(row => row.type === "markdown")).toBe(true);
  expect(comments[0].body).toBe(body);
  expect(calls.length).toBe(fetches);
});

test("render_markdown=false starts in raw mode and can still be toggled", async () => {
  process.env.GH_PR_NUMBER = "218";
  await refresh({ render_markdown: false });
  const props = { files: [], width: 80, theme: {}, actions: {} };
  expect(renderedElements(pane(props)).some(row => row.type === "markdown")).toBe(false);
  registeredCommands.get("toggle-markdown")!({ notify() {} });
  expect(renderedElements(pane(props)).some(row => row.type === "markdown")).toBe(true);
});

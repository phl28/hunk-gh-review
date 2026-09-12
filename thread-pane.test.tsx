import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

// Run separately from pr-discovery.test.ts so React and the terminal renderer
// stay real. Only GitHub responses are synthetic; no requests leave this test.
const originalSpawn = childProcess.spawn;
const source = '<a href="#"><img alt="P1" src="https://example.test/badge.svg"></a> **Review heading**\n\n'
  + '<p>See <a href="https://example.test/docs">the docs</a>.</p>\n\n'
  + '- [x] checked\n- [ ] pending\n\n```ts\n  <literal> &amp;\n```\n\nLast line of the finding';
const comments = [
  { id: 1, path: "file.ts", line: null, original_line: 10, side: "RIGHT", body: source,
    user: { login: "review-bot" }, created_at: "2026-01-01T00:00:00Z" },
  { id: 2, in_reply_to_id: 1, path: "file.ts", line: null, original_line: 10, side: "RIGHT",
    body: "**Reply heading**\n\nLast line of the reply", user: { login: "author" }, created_at: "2026-01-02T00:00:00Z" },
  { id: 3, in_reply_to_id: 1, path: "file.ts", line: null, original_line: 10, side: "RIGHT",
    body: "Follow-up confirmed", user: { login: "review-bot" }, created_at: "2026-01-03T00:00:00Z" },
];
mock.module("node:child_process", () => ({
  ...childProcess,
  spawn(cmd: string, args: string[], opts: any) {
    if (cmd !== "gh") return originalSpawn(cmd, args, opts);
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() { queueMicrotask(() => {
      if (args[0] === "pr" && args[1] === "view") child.stdout.emit("data", "42\tFixture PR\n");
      else if (args[0] === "api" && args[1] === "repos/fixture/repository/pulls/42/comments?per_page=100") {
        child.stdout.emit("data", JSON.stringify([comments]));
      } else throw new Error(`Unexpected GitHub request: ${args.join(" ")}`);
      child.emit("close", 0);
    }); } };
    return child;
  },
}));
const { default: extension } = await import("./dist/index.js");
const env = { GH_PR_NUMBER: process.env.GH_PR_NUMBER, GH_PR_REPO: process.env.GH_PR_REPO, EDITOR: process.env.EDITOR };
let screen: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  act(() => screen?.renderer.destroy());
  screen = undefined;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function frameWith(text: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await screen!.renderOnce(); });
    const frame = screen!.captureCharFrame();
    if (frame.includes(text)) return frame;
    // Markdown highlighting happens in a worker after the initial layout.
    await Bun.sleep(20);
  }
  throw new Error(`Terminal never displayed ${JSON.stringify(text)}:\n${screen!.captureCharFrame()}`);
}

async function openPane(config = {}, width = 64, activate = true) {
  process.env.GH_PR_NUMBER = "42";
  process.env.GH_PR_REPO = "fixture/repository";
  const commands = new Map<string, Function>();
  let Pane: any;
  extension({
    config: { editor: "synthetic-editor", ...config }, log() {}, on() {},
    registerCommand(command: { id: string }, handler: Function) { commands.set(command.id, handler); },
    registerPane(pane: any) { Pane = pane.component; }, registerKeyboardMode() {},
  } as any);
  const context = { cwd: process.cwd(), notify() {},
    panes: { isOpen: () => false, toggle() {} }, keyboardModes: { enterMode() {} },
  };
  await commands.get(activate ? "threads" : "refresh-threads")!(context);
  const theme = { text: "#dddddd", muted: "#999999", accent: "#88bbff", accentMuted: "#6699bb",
    panel: "#111111", panelAlt: "#181818", border: "#444444", selectedHunk: "#222222" };
  screen = await testRender(<Pane files={[]} width={width} theme={theme} actions={{}} />, { width, height: 60 });
  await frameWith("PR threads");
  return { screen, commands, context };
}

test("native pane renders HTML badges and Markdown, then shows original source on toggle", async () => {
  const { screen, commands } = await openPane();
  const rendered = await frameWith("Follow-up confirmed");
  expect(rendered).toContain("PR threads · Markdown");
  expect(rendered).toContain("P1 Review heading");
  expect(rendered).toContain("See the docs");
  expect(rendered).toContain("https://example.test/docs");
  expect(rendered).not.toContain("<img");
  expect(rendered).not.toContain("**Review heading**");
  expect(rendered).toContain("<literal> &amp;");
  expect(rendered).toContain("Last line of the finding");
  expect(rendered).toContain("Last line of the reply");
  expect(rendered).toContain("│ 2 replies");
  expect(rendered).toContain("│ @author");

  await act(async () => commands.get("toggle-markdown")!({ notify() {} }));
  const raw = await frameWith("**Review heading**");
  expect(raw).toContain("PR threads · Raw");
  expect(raw).toContain('<a href="#"><img alt="P1"');
  expect(raw).toContain("**Review heading**");
  expect(raw).toContain("│ 2 replies");
  expect(raw).toContain("│ @author");
  expect(raw).toContain("Follow-up confirmed");
  expect(raw).toContain("    <literal> &amp;"); // Two columns of indent plus two source spaces.

  await act(async () => commands.get("toggle-markdown")!({ notify() {} }));
  expect(await frameWith("P1 Review heading")).toContain("PR threads · Markdown");
});

test("configured raw mode renders in a narrow pane and switches to Markdown", async () => {
  const { screen, commands } = await openPane({ render_markdown: false }, 30);
  expect(screen.captureCharFrame()).toContain("PR threads · Raw");
  expect(screen.captureCharFrame()).toContain('<a href="#"><img');
  await act(async () => commands.get("toggle-markdown")!({ notify() {} }));
  expect(await frameWith("P1 Review heading")).toContain("Last line of the finding");
});

test("inactive previews stay short, and selecting a thread expands its finding and replies", async () => {
  const { commands, context } = await openPane({}, 64, false);
  const preview = await frameWith("P1 Review heading");
  expect(preview).not.toContain("Last line of the finding");
  expect(preview).not.toContain("Last line of the reply");
  await act(async () => { await commands.get("threads")!(context); });
  const expanded = await frameWith("Last line of the reply");
  expect(expanded).toContain("Last line of the finding");
});

# hunk-gh-review

A [hunk](https://hunk.dev) extension that submits your review notes as a real GitHub PR review — Comment, Approve, or Request changes — without leaving the terminal.

## Usage

1. Review a PR in hunk, telling hunk which PR the diff belongs to: `gh pr diff 123 | GH_PR_NUMBER=123 GH_PR_REPO=owner/repo hunk patch -` — or use a launcher that does this for you (`hpr` script, or the lazygit `v` custom command).
2. Press `c` on hunks/lines to leave notes as you go.
3. Press **`S`** to submit:
   - resolves the target PR itself — `GH_PR_NUMBER`/`GH_PR_REPO` if the launcher set them, otherwise the checked-out branch's open PR — and asks you to **confirm** it (number + title). The number is never typed by hand: comments can only land on the PR whose diff is under review, since their line positions must match that PR's head diff. A set-but-empty `GH_PR_NUMBER` means the launcher already determined this review has no open PR, so the checked-out branch's PR is *not* used as a fallback (that would target the wrong PR)
   - asks for the review type (Comment / Approve / Request changes) and an optional top-level body
   - posts one atomic GitHub review containing every note as an inline comment (`new`-side notes → `RIGHT`, `old`-side → `LEFT`)
   - clears the submitted notes from the session so a second press doesn't double-post

If there is no PR to attach notes to (e.g. reviewing uncommitted changes on a branch with no open PR), `S` fails with a clear message — GitHub reviews attach to PRs, not branches.

Inline notes are optional, matching the GitHub UI: **Approve** and **Request changes** submit fine with no notes and no body; a **Comment** review with no inline notes requires a top-level body (the body prompt tells you when it's required).

**Fork-style clones:** gh resolves its base repo from remotes with the priority `upstream` > `github` > `origin`, so in clones with an `upstream` remote, bare `gh pr view`/`gh repo view` can silently query the wrong repo. Pass `GH_PR_REPO` (the `hpr` launcher derives it from the branch's tracking remote), or fix the clone once with `gh repo set-default owner/repo`.

The whole review is a single GitHub API call: if GitHub rejects any comment position, nothing is posted and the error is shown as a notification.

## Install

Requires hunk ≥ 0.18 and the [`gh`](https://cli.github.com) CLI, authenticated.

```bash
hunk extension install phl28/hunk-gh-review          # hunk ≥ 0.19
```

On hunk 0.18 (no `extension install`), or for local development on this repo, point your user config at the checkout (`~/.config/hunk/config.toml`):

```toml
[extensions]
paths = ["/path/to/hunk-gh-review"]
```

Do **not** symlink the folder into `~/.config/hunk/extensions/` — the auto-scanner silently skips symlinked directories (the `readdir` dirent for a symlink fails `isDirectory()`).

Use one install source or the other — two sources providing the same extension id collide, and the second is skipped with a startup notice.

## Notes

- GitHub calls go through `gh`, so auth/scopes are whatever `gh auth status` says.
- Notes are read from the live session via `hunk session comment list` (authoritative, sees deletions); the `note_created`/`note_edited` event stream is a fallback for when the session daemon is unreachable.
- Rebind the key in hunk's config: `[keybindings]` with `"gh-review.submit" = "<key>"`.
- Extension config table (`[extension.gh-review]`) is currently unused.

## Develop

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit against the shipped hunkdiff extension types
```

(`hunkdiff` is a types-only devDependency — the hunk binary that runs the extension is your system install — so its bundled `bun` binary build script is disabled in `pnpm-workspace.yaml`.)

Test a change live: `hunk diff --extension ~/Code/hunk-gh-review` in any dirty repo.

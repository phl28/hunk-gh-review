# hunk-gh-review

A [hunk](https://hunk.dev) extension that submits your review notes as a real GitHub PR review — Comment, Approve, or Request changes — without leaving the terminal.

## Usage

1. Review a PR in hunk, e.g. `gh pr diff 123 | hunk patch -` (or via the lazygit `v` custom command).
2. Press `c` on hunks/lines to leave notes as you go.
3. Press **`S`** to submit:
   - prompts for the PR number (pre-filled with the checked-out branch's PR when there is one)
   - asks for the review type (Comment / Approve / Request changes) and an optional top-level body
   - posts one atomic GitHub review containing every note as an inline comment (`new`-side notes → `RIGHT`, `old`-side → `LEFT`)
   - clears the submitted notes from the session so a second press doesn't double-post

The whole review is a single GitHub API call: if GitHub rejects any comment position, nothing is posted and the error is shown as a notification.

## Install

Requires hunk ≥ 0.18 and the [`gh`](https://cli.github.com) CLI, authenticated.

```bash
hunk extension install phl28/hunk-gh-review          # hunk ≥ 0.19
```

On hunk 0.18 (no `extension install`), or for local development on this repo, symlink a checkout into hunk's extension dir instead:

```bash
git clone git@github.com:phl28/hunk-gh-review.git ~/Code/hunk-gh-review
ln -s ~/Code/hunk-gh-review ~/.config/hunk/extensions/hunk-gh-review
```

Use one or the other — two sources providing the same extension id collide, and the second is skipped with a startup notice.

## Notes

- GitHub calls go through `gh`, so auth/scopes are whatever `gh auth status` says.
- Notes are read from the live session via `hunk session comment list` (authoritative, sees deletions); the `note_created`/`note_edited` event stream is a fallback for when the session daemon is unreachable.
- Rebind the key in hunk's config: `[keybindings]` with `"gh-review.submit" = "<key>"`.
- Extension config table (`[extension.gh-review]`) is currently unused.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit against the shipped hunkdiff extension types
```

Test a change live: `hunk diff --extension ~/Code/hunk-gh-review` in any dirty repo.

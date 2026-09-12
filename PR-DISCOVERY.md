# Finding an existing PR from a worktree

PR discovery checks the tracking branch first, then the local branch. If neither has an open PR, it asks GitHub for PRs associated with the checkout's current commit. That fallback accepts exactly one open PR in the selected repository whose head SHA matches `HEAD`. Closed PRs and PRs that merely contain the commit don't qualify. Ambiguous matches remain unassociated.

This covers pushes such as `git push origin HEAD:existing-pr`, where the local branch can have a different name and no upstream. Setting the upstream remains useful: it lets Hunk find the PR while the checkout has additional unpushed commits. Discovery uses the checkout's head, so the older comparison base passed to `hunk diff` doesn't prevent a match.

`GH_PR_NUMBER` and `GH_PR_REPO` still take priority. An explicitly empty `GH_PR_NUMBER` disables discovery, as it does for a launcher that has already determined there's no PR. Piped patches still need explicit PR identity because the patch itself doesn't identify a repository or PR.

The original automatic lookup used `gh pr view -R owner/repo` without a PR or branch argument. GitHub CLI 2.100.0 rejects that command with `argument required when using the --repo flag`; the extension caught the error and displayed no PR. Branch discovery now uses `gh pr list --head ... --state open`, and subsequent `gh pr view` calls receive the resolved PR number. Threads and review submission share the resolver.

Opening the threads pane refreshes discovery, so a PR that became available after a push can appear without restarting Hunk. Outdated discussions and their replies remain visible with an `outdated` label. Selecting a discussion expands its full text and replies; selecting an outdated one doesn't navigate to its obsolete line number. Current threads retain line navigation.

Run `pnpm test` for regression tests and `pnpm run typecheck` for the TypeScript check. The tests use real disposable Git repositories, synthetic GitHub responses, and the extension's registered refresh command and thread pane. They cover ordinary and renamed branches, unpushed commits with tracking, detached HEAD, ambiguous and stale commit associations, explicit identity, and outdated discussions. Publishing commands are rejected by the test harness.

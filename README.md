# claude-mods

My Claude Code mods.

## Mods

- `git-pane`: live git status pane (`/git-pane`)

## git-pane

- Branch line above the prompt, with ahead/behind, dirty count and a worktree badge.
- Changes list with line counts and a 15-file limit.
- Open PRs or MRs with checks and a checkout button. Uses `gh` for GitHub and `glab` for GitLab.
- Linear issue (`ABC-123` in the branch name) or Teamwork task (7 to 9 digit id in the branch name). Each needs its MCP server connected.

Setting: `blockWorktrees` (off by default) denies `EnterWorktree` and new git worktrees. Change it in `/config`, then run `/reload-plugins`.

## Install

```
/plugin install git-pane --marketplace xavortm/claude-mods
```

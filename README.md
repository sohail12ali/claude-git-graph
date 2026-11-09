# Git Graph for Claude Code

A mod that shows the **commit graph of the folder your Claude Code chat is working in**, with branches, tags, commit details, diffs and common git actions. It is inspired by the Git Graph extension for VS Code (by mhutchie) and is not affiliated with it.

- **Terminal Claude Code:** the graph opens as a pane beside the chat.
- **Claude desktop app** (which has no mod panes): `/git-graph` starts a small local viewer and prints a link. Open it in the app's Browser pane, or in any browser on the same computer.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install git-graph --marketplace sohail12ali/claude-git-graph
```

Or from a shell:

```
claude plugin install git-graph --marketplace sohail12ali/claude-git-graph
```

Then run `/git-graph` in any chat that is working in a git folder.

**Requirements:** Node.js 18 or newer (for the desktop viewer) and `git` on your PATH. No other dependencies.

## Features

- Colored graph across local and remote branches, with branch, tag and HEAD labels
- Click a commit for details: hash, parents, author, date, full message and changed files with +/- counts
- Diffs: side-by-side or unified, word-level highlights, full-screen review, extra context, collapsible hunks
- Uncommitted changes row; stash list with view, apply, pop and drop
- Multi-select branches and tags, remotes toggle, search the whole history, author and date filters, hide merge commits
- Compare any two branches, tags or commits; file history; view a file at any commit; copy a commit as a patch
- Right-click menus: checkout, create branch or tag, cherry-pick, revert, merge, rebase, reset (soft, mixed, hard), push, pull, fetch, delete branch or tag. Risky actions ask for a second click.
- Banner with Continue / Skip / Abort when a merge, rebase, cherry-pick or revert stops on conflicts
- Keyboard navigation, history (back and forward), resizable columns, light and dark themes

## Privacy and safety

- The viewer only listens on `127.0.0.1` (your own computer) and rejects requests from other hosts and other websites. Every request needs a random token that exists only in the page it serves.
- It runs `git` on folders you open. Nothing is sent over the network except what git itself does when you press Fetch, Pull or Push.
- The git actions change your repository exactly as the same git commands would. Review before you confirm a reset, rebase or delete.

## Development

```
node viewer/server.js          # serves http://127.0.0.1:47770/ ; open it with ?repo=<folder>
claude plugin validate .
```

The viewer is two files (`viewer/server.js`, `viewer/index.html`) with no build step.

## License

MIT

# Git Graph for Claude Code

A mod that adds a **Git Graph** pane beside the chat, in the spirit of the VS Code extension by mhutchie. It shows the commit graph of the folder the session is working in, with branch and tag labels, and updates after Bash tool calls.

## Features

- Colored commit graph across local and remote branches, with tags and HEAD labels
- Click a commit to expand its details: hash, parents, author, date, full message and changed files with +/- counts
- Click a file to see its diff; an "Uncommitted changes" row shows working-tree changes
- Branch dropdown, remotes toggle and search by message, author, hash or ref
- Mark a commit and compare it with another
- Actions: copy hash, checkout, cherry-pick, revert, merge, create branch, add tag, fetch, and confirmed soft/mixed/hard reset

The desktop viewer also has:

- Stash list with view, apply, pop and drop; push and pull with ahead/behind counts
- A banner with Continue / Abort when a merge, rebase, cherry-pick or revert stops on conflicts
- Search the whole history (Enter in the search box), author and date filters, hide merge commits
- File history, view a file at any commit, copy a commit or the working changes as a patch
- Compare any two branches, tags or commits from the branch picker
- Annotated tags, branches with or without checkout, delete remote branches

Open it with `/git-graph`.

- **Terminal Claude Code:** the graph opens as a pane beside the chat (`r` refreshes, `f` fetches).
- **Claude desktop app** (no mod panes): `/git-graph` starts a small local viewer (`viewer/`, plain Node.js, no dependencies, bound to 127.0.0.1) and prints a link for the folder the chat is working in. Open it in the app's Browser pane. It has the same features, with a drawn graph.

## Install

At the prompt of a terminal session:

```
/plugin install git-graph --marketplace sohail12ali/claude-git-graph
```

From a shell:

```
claude plugin install git-graph --marketplace sohail12ali/claude-git-graph
```

The repository is private: each computer needs GitHub access (for example `gh auth login`).

## License

MIT

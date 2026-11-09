# Git Graph for Claude Code

A mod that adds a **Git Graph** pane beside the chat, in the spirit of the VS Code extension by mhutchie. It shows the commit graph of the folder the session is working in, with branch and tag labels, and updates after Bash tool calls.

## Features

- Colored commit graph across local and remote branches, with tags and HEAD labels
- Click a commit to expand its details: hash, parents, author, date, full message and changed files with +/- counts
- Click a file to see its diff; an "Uncommitted changes" row shows working-tree changes
- Branch dropdown, remotes toggle and search by message, author, hash or ref
- Mark a commit and compare it with another
- Actions: copy hash, checkout, cherry-pick, revert, merge, create branch, add tag, fetch, and confirmed soft/mixed/hard reset

Open it with `/git-graph`; it also opens at session start. Press `r` to refresh and `f` to fetch.

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

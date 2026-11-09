import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Branches, Detail, FileChange, GraphCommit, Patch, View } from '../types'

const PANE = 'git-graph'
const LIMIT = 400
const WORKING = 'WORKING'
const PALETTE = ['#4ec9b0', '#569cd6', '#c586c0', '#dcdcaa', '#ce9178', '#9cdcfe', '#d7ba7d', '#b5cea8']

const commits = atom({ plugin: 'git-graph', key: 'commits' } as const, [] as GraphCommit[], { shape: 'commits-2' })
const branches = atom({ plugin: 'git-graph', key: 'branches' } as const, { local: [], remote: [], current: '' } as Branches, { shape: 'branches-2' })
const view = atom({ plugin: 'git-graph', key: 'view' } as const, { branch: '', query: '', showRemotes: true } as View, { shape: 'view-2' })
const selected = atom({ plugin: 'git-graph', key: 'selected' } as const, '' as string, { shape: 'selected-2' })
const detail = atom({ plugin: 'git-graph', key: 'detail' } as const, { hash: '', base: '', title: '', meta: [], message: '', files: [] } as Detail, { shape: 'detail-2' })
const patch = atom({ plugin: 'git-graph', key: 'patch' } as const, { path: '', diff: '' } as Patch, { shape: 'patch-2' })
const mark = atom({ plugin: 'git-graph', key: 'mark' } as const, '' as string, { shape: 'mark-2' })
const pending = atom({ plugin: 'git-graph', key: 'pending' } as const, '' as string, { shape: 'pending-2' })
const note = atom({ plugin: 'git-graph', key: 'note' } as const, '' as string, { shape: 'note-2' })
const dirty = atom({ plugin: 'git-graph', key: 'dirty' } as const, 0 as number, { shape: 'dirty-2' })
const error = atom({ plugin: 'git-graph', key: 'error' } as const, '' as string, { shape: 'error-2' })
const folder = atom({ plugin: 'git-graph', key: 'folder' } as const, '' as string, { shape: 'folder-2' })
let asked = false

const short = (h: string) => h.slice(0, 7)
const first = (s: string) => s.trim().split('\n')[0] ?? ''

// Lane layout: one column per branch line still waiting for its commit.
function layout(rows: { hash: string; parents: string[] }[]): string[] {
  const lanes: (string | null)[] = []
  return rows.map(({ hash, parents }) => {
    const hits: number[] = []
    lanes.forEach((l, i) => l === hash && hits.push(i))
    let col = hits[0]
    if (col === undefined) {
      col = lanes.indexOf(null)
      if (col < 0) col = lanes.length
      lanes[col] = hash
    }
    const cells = lanes.map(l => (l ? '│' : ' '))
    cells[col] = '●'
    for (const i of hits.slice(1)) {
      cells[i] = '╯'
      lanes[i] = null
    }
    lanes[col] = parents[0] ?? null
    for (const p of parents.slice(1)) {
      if (lanes.includes(p)) continue
      let slot = lanes.indexOf(null)
      if (slot < 0) slot = lanes.length
      lanes[slot] = p
      while (cells.length <= slot) cells.push(' ')
      cells[slot] = '╮'
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    return cells.join('')
  })
}

async function git($: any, args: string[], timeoutMs = 20000) {
  const cwd: string = await $.session.cwd()
  return $.process.run(['git', ...args], { cwd, timeoutMs })
}

async function refresh($: any) {
  asked = true
  const cwd: string = await $.session.cwd()
  await update($, folder, () => cwd)
  const v = await read($, view)

  const refs = await git($, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  if (refs.exitCode !== 0) {
    const msg = first(refs.stderr)
    await update($, error, () => (/not a git repository/i.test(msg) ? 'This folder is not a git repository.' : msg || 'git failed'))
    await update($, commits, () => [])
    return
  }
  const names = refs.stdout.split('\n').filter(Boolean)
  const cur = first((await git($, ['branch', '--show-current'])).stdout)
  await update($, branches, () => ({
    local: names.filter(n => n.startsWith('refs/heads/')).map(n => n.slice(11)),
    remote: names.filter(n => n.startsWith('refs/remotes/') && !n.endsWith('/HEAD')).map(n => n.slice(13)),
    current: cur,
  }))

  const scope = v.branch ? [v.branch] : v.showRemotes ? ['--all'] : ['--branches', '--tags', 'HEAD']
  const r = await git($, ['log', '--topo-order', '-n', String(LIMIT), '--date=short',
    '--format=%H%x1f%P%x1f%an%x1f%ar%x1f%ad%x1f%D%x1f%s', ...scope, '--'], 30000)
  if (r.exitCode !== 0) {
    await update($, error, () => first(r.stderr) || 'git log failed')
    await update($, commits, () => [])
    return
  }
  const parsed = r.stdout.split('\n').filter(Boolean).map((line: string) => {
    const [hash, parents, author, when, date, rf, subject] = line.split('\x1f')
    return {
      hash, parents: parents ? parents.split(' ') : [], author, when, date, subject,
      refs: rf ? rf.split(', ').filter(Boolean).map(x => x.replace(/^HEAD -> /, '')) : [],
    }
  })
  const graphs = layout(parsed)
  const list: GraphCommit[] = parsed.map((c: any, i: number) => ({ ...c, graph: graphs[i] }))
  const st = await git($, ['status', '--porcelain'])
  await update($, dirty, () => st.stdout.split('\n').filter(Boolean).length)
  await update($, error, () => '')
  await update($, commits, () => list)
}

function parseStatus(nameStatus: string, numstat: string): FileChange[] {
  const nums = new Map<string, [number, number]>()
  for (const l of numstat.split('\n').filter(Boolean)) {
    const [ad, de, ...p] = l.split('\t')
    nums.set(p.join('\t'), [ad === '-' ? -1 : +ad, de === '-' ? -1 : +de])
  }
  return nameStatus.split('\n').filter(Boolean).map(l => {
    const [s, ...p] = l.split('\t')
    const path = p[p.length - 1]
    const [add, del] = nums.get(path) ?? [0, 0]
    return { status: s[0], path, add, del }
  })
}

async function openCommit($: any, hash: string, base = '') {
  await update($, selected, () => hash)
  await update($, patch, () => ({ path: '', diff: '' }))
  await update($, pending, () => '')
  if (hash === WORKING) {
    const st = await git($, ['status', '--porcelain', '-uall'])
    const ns = await git($, ['diff', 'HEAD', '--numstat'])
    const nums = parseStatus('', '')
    void nums
    const numMap = new Map<string, [number, number]>()
    for (const l of ns.stdout.split('\n').filter(Boolean)) {
      const [ad, de, ...p] = l.split('\t')
      numMap.set(p.join('\t'), [ad === '-' ? -1 : +ad, de === '-' ? -1 : +de])
    }
    const files = st.stdout.split('\n').filter(Boolean).map((l: string) => {
      const xy = l.slice(0, 2)
      const path = l.slice(3)
      const s = xy === '??' ? 'U' : xy[0] !== ' ' ? xy[0] : xy[1]
      const [add, del] = numMap.get(path) ?? [0, 0]
      return { status: s, path, add, del }
    })
    await update($, detail, () => ({ hash, base: '', title: 'Uncommitted changes', meta: [], message: '', files }))
    return
  }
  if (base) {
    const ns = await git($, ['diff', '--name-status', base, hash])
    const nm = await git($, ['diff', '--numstat', base, hash])
    await update($, detail, () => ({
      hash, base, title: `Compare ${short(base)} → ${short(hash)}`, meta: [], message: '',
      files: parseStatus(ns.stdout, nm.stdout),
    }))
    return
  }
  const meta = await git($, ['show', '-s', '--format=%H%x1f%P%x1f%an <%ae>%x1f%ad%x1f%cn%x1f%B', '--date=format:%a %d %b %Y %H:%M', hash])
  const [full, parents, author, date, committer, ...body] = meta.stdout.split('\x1f')
  const msg = body.join('\x1f').trim()
  const ns = await git($, ['diff-tree', '-r', '-m', '--first-parent', '--root', '--no-commit-id', '--name-status', hash])
  const nm = await git($, ['diff-tree', '-r', '-m', '--first-parent', '--root', '--no-commit-id', '--numstat', hash])
  await update($, detail, () => ({
    hash, base: '', title: msg.split('\n')[0] ?? '',
    meta: [
      `Commit:    ${full}`,
      `Parents:   ${parents ? parents.split(' ').map(short).join(' ') : '(root)'}`,
      `Author:    ${author}`,
      `Date:      ${date}${committer && !author.startsWith(committer) ? `   (committed by ${committer})` : ''}`,
    ],
    message: msg.split('\n').slice(1).join('\n').trim(),
    files: parseStatus(ns.stdout, nm.stdout),
  }))
}

async function openFile($: any, d: Detail, path: string) {
  let args: string[]
  if (d.hash === WORKING) args = ['diff', 'HEAD', '--', path]
  else if (d.base) args = ['diff', d.base, d.hash, '--', path]
  else args = ['show', '--format=', '-m', '--first-parent', d.hash, '--', path]
  let r = await git($, args)
  if (d.hash === WORKING && !r.stdout) {
    const cwd: string = await $.session.cwd()
    r = await $.process.run(['git', 'diff', '--no-index', '--', '/dev/null', path], { cwd })
  }
  const lines = r.stdout.split('\n')
  const diff = lines.slice(0, 120).join('\n') + (lines.length > 120 ? `\n… ${lines.length - 120} more lines` : '')
  await update($, patch, () => ({ path, diff: diff || '(no textual changes)' }))
}

async function act($: any, label: string, args: string[]) {
  const r = await git($, args, 60000)
  const msg = r.exitCode === 0 ? `${label}: done` : `${label} failed: ${first(r.stderr) || first(r.stdout)}`
  await update($, note, () => msg)
  await update($, pending, () => '')
  await refresh($)
}

const safe = ($: any, p: Promise<unknown>) =>
  p.catch(err => void update($, note, () => `Error: ${String(err?.message ?? err).slice(0, 200)}`))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'git-graph', description: 'Show the git commit graph in a pane' })
    void $.ui.open({ id: PANE, title: 'Git Graph' })
    void refresh($).catch(() => {})
    return next(e)
  })

  let viewerStarted = false
  on('command.run', { command: 'git-graph' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Git Graph' })
    void refresh($).catch(() => {})
    if (opened?.isPlaced) return { text: 'Git Graph pane opened.' }
    // This surface seats no mod panes: serve the same graph as a local web page.
    const cwd: string = await $.session.cwd()
    if (!viewerStarted) {
      viewerStarted = true
      void (async () => {
        try {
          for await (const _ of $.process.spawn({ argv: ['node', `${$.plugin.root}/viewer/server.js`], cwd })) void _
        } catch {}
        viewerStarted = false
      })()
    }
    const url = `http://127.0.0.1:47770/?repo=${encodeURIComponent(cwd)}`
    return { text: `Git Graph viewer for ${cwd}:
${url}

Open it in the Browser pane (or any browser on this computer). It needs Node.js.` }
  })

  // Commits, checkouts and merges usually run through Bash: redraw afterwards.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    void refresh($).catch(() => {})
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select, Code } = $.ui.resolve(e)
    const list = await read($, commits)
    const br = await read($, branches)
    const v = await read($, view)
    const sel = await read($, selected)
    const d = await read($, detail)
    const p = await read($, patch)
    const mk = await read($, mark)
    const pend = await read($, pending)
    const msg = await read($, note)
    const nDirty = await read($, dirty)
    const err = await read($, error)
    const dir = await read($, folder)
    if (!asked) void refresh($).catch(() => {})

    const q = v.query.trim().toLowerCase()
    const shown = q
      ? list.filter(c => `${c.subject} ${c.author} ${c.hash} ${c.refs.join(' ')}`.toLowerCase().includes(q))
      : list
    const options = [
      { value: '', label: 'All branches' },
      ...br.local.map(n => ({ value: n, label: n })),
      ...(v.showRemotes ? br.remote.map(n => ({ value: n, label: n })) : []),
    ]
    const cur = list.find(c => c.hash === sel)

    const detailBox = (c: GraphCommit | undefined) => (
      <Box flexDirection="column" borderStyle="round">
        <Text bold>{d.title || '(no message)'}</Text>
        {d.meta.map(l => (
          <Text dimColor>{l}</Text>
        ))}
        {d.message !== '' && <Text>{d.message.split('\n').slice(0, 12).join('\n')}</Text>}
        <Text bold>
          {d.files.length} file{d.files.length === 1 ? '' : 's'} changed
          {d.files.length > 0 && ` (+${d.files.reduce((s, f) => s + Math.max(f.add, 0), 0)} −${d.files.reduce((s, f) => s + Math.max(f.del, 0), 0)})`}
        </Text>
        {d.files.slice(0, 40).map(f => (
          <Button key={'file:' + f.path} onPress={() => void safe($, openFile($, d, f.path))}>
            <Text color={f.status === 'A' || f.status === 'U' ? 'success' : f.status === 'D' ? 'error' : 'warning'}>{f.status} </Text>
            <Text bold={p.path === f.path}>{f.path}</Text>
            <Text dimColor> {f.add < 0 ? 'binary' : `+${f.add} −${f.del}`}</Text>
          </Button>
        ))}
        {d.files.length > 40 && <Text dimColor>… {d.files.length - 40} more files</Text>}
        {p.path !== '' && <Text bold>{p.path}</Text>}
        {p.path !== '' && <Code source={p.diff} format="diff" wrap="truncate-end" />}
        {d.hash !== WORKING && c && (
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Button key="a:copy" onPress={press => void $.ui.copy({ text: d.hash, surface: press.surface })}>Copy hash</Button>
              <Button key="a:co" onPress={() => void safe($, act($, 'Checkout', ['checkout', '--detach', d.hash]))}>Checkout (detached)</Button>
              {br.local.filter(b => c.refs.includes(b)).map(b => (
                <Button key={'a:cob:' + b} onPress={() => void safe($, act($, `Checkout ${b}`, ['checkout', b]))}>Checkout {b}</Button>
              ))}
              <Button key="a:cp" onPress={() => void safe($, act($, 'Cherry-pick', ['cherry-pick', d.hash]))}>Cherry-pick</Button>
              <Button key="a:rv" onPress={() => void safe($, act($, 'Revert', ['revert', '--no-edit', d.hash]))}>Revert</Button>
              <Button key="a:mg" onPress={() => void safe($, act($, 'Merge', ['merge', d.hash]))}>Merge into current</Button>
              <Button key="a:mark" onPress={() => void update($, mark, () => d.hash)}>{mk === d.hash ? 'Marked ✓' : 'Mark for compare'}</Button>
              {mk !== '' && mk !== d.hash && (
                <Button key="a:cmp" onPress={() => void safe($, openCommit($, d.hash, mk))}>Compare with {short(mk)}</Button>
              )}
            </Box>
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Button key="r:soft" onPress={() => void update($, pending, () => 'reset:--soft')}>Reset soft…</Button>
              <Button key="r:mixed" onPress={() => void update($, pending, () => 'reset:--mixed')}>Reset mixed…</Button>
              <Button key="r:hard" onPress={() => void update($, pending, () => 'reset:--hard')}>Reset hard…</Button>
            </Box>
            {pend.startsWith('reset:') && (
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                <Text color="warning">
                  {pend === 'reset:--hard'
                    ? `Hard reset to ${short(d.hash)} discards ALL uncommitted changes. Sure?`
                    : `Move the current branch to ${short(d.hash)} (${pend.slice(6)})?`}
                </Text>
                <Button key="r:yes" onPress={() => void safe($, act($, 'Reset', ['reset', pend.slice(6), d.hash]))}>Confirm reset</Button>
                <Button key="r:no" onPress={() => void update($, pending, () => '')}>Cancel</Button>
              </Box>
            )}
            <Input key="in:branch" label="New branch here (Enter to create and check out)" placeholder="branch-name"
              onSubmit={val => { if (val.trim()) void safe($, act($, 'Create branch', ['checkout', '-b', val.trim(), d.hash])) }} />
            <Input key="in:tag" label="Add tag here (Enter)" placeholder="v1.0.0"
              onSubmit={val => { if (val.trim()) void safe($, act($, 'Tag', ['tag', val.trim(), d.hash])) }} />
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="refresh" hotkey="r" onPress={() => void safe($, refresh($))}>Refresh (r)</Button>
          <Button key="fetch" hotkey="f" onPress={() => void safe($, act($, 'Fetch', ['fetch', '--all', '--prune']))}>Fetch (f)</Button>
          <Button key="remotes" onPress={() => void safe($, update($, view, x => ({ ...x, showRemotes: !x.showRemotes, branch: '' }) as View).then(() => refresh($)))}>
            {v.showRemotes ? '☑' : '☐'} Remotes
          </Button>
        </Box>
        <Select key="branch" label="Branch" options={options} value={v.branch}
          onSelect={val => void safe($, update($, view, x => ({ ...x, branch: val }) as View).then(() => refresh($)))} />
        <Input key="search" label="Search message, author, hash or ref (Enter; empty clears)" placeholder="search…" value={v.query}
          onSubmit={val => void safe($, update($, view, x => ({ ...x, query: val }) as View))} />
        {dir !== '' && <Text dimColor>{dir} · {br.current ? `on ${br.current}` : 'detached HEAD'} · {shown.length}{q ? `/${list.length}` : ''} commits</Text>}
        {msg !== '' && <Text color={msg.includes('failed') || msg.startsWith('Error') ? 'error' : 'success'}>{msg}</Text>}
        {err !== '' && <Text color="error">{err}</Text>}
        {!err && list.length === 0 && <Text dimColor>{asked ? 'No commits found.' : 'Loading…'}</Text>}
        {nDirty > 0 && !q && (
          <Button key="row:working" onPress={() => void safe($, openCommit($, WORKING))}>
            <Text color="warning">○ </Text>
            <Text bold={sel === WORKING}>Uncommitted changes</Text>
            <Text dimColor> ({nDirty} files)</Text>
          </Button>
        )}
        {sel === WORKING && detailBox(undefined)}
        {shown.map(c => (
          <Box flexDirection="column">
            <Button key={'row:' + c.hash} onPress={() => void safe($, openCommit($, c.hash))}>
              {!q && [...c.graph].map((ch, i) => <Text color={PALETTE[i % PALETTE.length]}>{ch} </Text>)}
              <Text bold={c.hash === sel}>{c.subject}</Text>
              {c.refs.map(r => (
                <Text color={r.startsWith('tag:') ? 'warning' : r === 'HEAD' ? 'success' : r.includes('/') && br.remote.includes(r) ? 'subtle' : 'suggestion'}> [{r}]</Text>
              ))}
              <Text dimColor> {c.author} · {c.date} ({c.when}) · {short(c.hash)}</Text>
            </Button>
            {c.hash === sel && detailBox(c)}
          </Box>
        ))}
        {list.length >= LIMIT && <Text dimColor>Showing the latest {LIMIT} commits.</Text>}
      </Box>
    )
  })
}

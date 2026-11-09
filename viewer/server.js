#!/usr/bin/env node
// Git Graph viewer: a zero-dependency local server. Usage: node server.js [port]
// Serves index.html and a small JSON API over `git`, bound to 127.0.0.1 only.
const http = require('http')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT = +(process.env.GIT_GRAPH_PORT || process.argv[2] || 47770)
const TOKEN = crypto.randomBytes(16).toString('hex')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

const git = (repo, args, timeout = 30000) =>
  new Promise(resolve => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: repo, maxBuffer: 64 * 1024 * 1024, timeout,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    }, (err, out, errOut) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out, err: errOut }))
  })

const HASH = /^[0-9a-f]{4,40}$/
const NAME = /^[\w][\w./@+-]*$/
const first = s => (s || '').trim().split('\n')[0] || ''

async function resolveRepo(p) {
  if (!p || typeof p !== 'string') throw new Error('No folder given')
  const dir = path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME || '~'))
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Folder not found: ' + dir)
  const r = await git(dir, ['rev-parse', '--show-toplevel'])
  if (r.code !== 0) throw new Error('Not a git repository: ' + dir)
  return r.out.trim()
}

function parseFiles(nameStatus, numstat) {
  const nums = new Map()
  for (const l of numstat.split('\n').filter(Boolean)) {
    const [a, d, ...p] = l.split('\t')
    nums.set(p.join('\t'), [a === '-' ? -1 : +a, d === '-' ? -1 : +d])
  }
  return nameStatus.split('\n').filter(Boolean).map(l => {
    const [s, ...p] = l.split('\t')
    const file = p[p.length - 1]
    const [add, del] = nums.get(file) || [0, 0]
    return { status: s[0], path: file, add, del }
  })
}

async function fingerprint(repo) {
  const [refs, st] = await Promise.all([
    git(repo, ['for-each-ref', '--format=%(objectname) %(refname)']),
    git(repo, ['status', '--porcelain', '-uall']),
  ])
  const head = await git(repo, ['rev-parse', 'HEAD'])
  return crypto.createHash('sha1').update(refs.out + '|' + st.out + '|' + head.out).digest('hex')
}

const api = {
  async info({ repo }) {
    const root = await resolveRepo(repo)
    const [refs, cur, st, fp] = await Promise.all([
      git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
      git(root, ['branch', '--show-current']),
      git(root, ['status', '--porcelain', '-uall']),
      fingerprint(root),
    ])
    const names = refs.out.split('\n').filter(Boolean)
    return {
      root, fp, current: first(cur.out), dirty: st.out.split('\n').filter(Boolean).length,
      local: names.filter(n => n.startsWith('refs/heads/')).map(n => n.slice(11)),
      remote: names.filter(n => n.startsWith('refs/remotes/') && !n.endsWith('/HEAD')).map(n => n.slice(13)),
    }
  },
  async log({ repo, branch, remotes, n }) {
    const root = await resolveRepo(repo)
    const scope = branch ? [branch] : remotes === '0' ? ['--branches', '--tags', 'HEAD'] : ['--all']
    const r = await git(root, ['log', '--topo-order', '-n', String(Math.min(+n || 300, 5000)), '--date=short',
      '--format=%H%x1f%P%x1f%an%x1f%ar%x1f%ad%x1f%D%x1f%s', ...scope, '--'], 60000)
    if (r.code !== 0 && !/does not have any commits/.test(r.err)) throw new Error(first(r.err) || 'git log failed')
    return r.out.split('\n').filter(Boolean).map(line => {
      const [hash, parents, author, when, date, refs, subject] = line.split('\x1f')
      return { hash, parents: parents ? parents.split(' ') : [], author, when, date, subject, refs: refs ? refs.split(', ').filter(Boolean) : [] }
    })
  },
  async commit({ repo, hash, base }) {
    const root = await resolveRepo(repo)
    if (hash === 'WORKING') {
      const [st, ns] = await Promise.all([git(root, ['status', '--porcelain', '-uall']), git(root, ['diff', 'HEAD', '--numstat'])])
      const nums = new Map()
      for (const l of ns.out.split('\n').filter(Boolean)) {
        const [a, d, ...p] = l.split('\t')
        nums.set(p.join('\t'), [a === '-' ? -1 : +a, d === '-' ? -1 : +d])
      }
      const files = st.out.split('\n').filter(Boolean).map(l => {
        const xy = l.slice(0, 2), file = l.slice(3)
        const [add, del] = nums.get(file) || [0, 0]
        return { status: xy === '??' ? 'U' : xy[0] !== ' ' ? xy[0] : xy[1], path: file, add, del }
      })
      return { hash, title: 'Uncommitted changes', meta: {}, message: '', files }
    }
    if (!HASH.test(hash)) throw new Error('bad hash')
    if (base) {
      if (!HASH.test(base)) throw new Error('bad base')
      const [a, b] = await Promise.all([git(root, ['diff', '--name-status', base, hash]), git(root, ['diff', '--numstat', base, hash])])
      return { hash, base, title: `Compare ${base.slice(0, 7)} → ${hash.slice(0, 7)}`, meta: {}, message: '', files: parseFiles(a.out, b.out) }
    }
    const [m, a, b] = await Promise.all([
      git(root, ['show', '-s', '--date=format:%a %d %b %Y %H:%M', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%cn%x1f%B', hash]),
      git(root, ['diff-tree', '-r', '-m', '--first-parent', '--root', '--no-commit-id', '--name-status', hash]),
      git(root, ['diff-tree', '-r', '-m', '--first-parent', '--root', '--no-commit-id', '--numstat', hash]),
    ])
    const [full, parents, author, email, date, committer, ...body] = m.out.split('\x1f')
    const msg = body.join('\x1f').trim()
    return {
      hash, title: msg.split('\n')[0], message: msg.split('\n').slice(1).join('\n').trim(),
      meta: { full, parents: parents ? parents.split(' ') : [], author, email, date, committer },
      files: parseFiles(a.out, b.out),
    }
  },
  async diff({ repo, hash, base, path: file }) {
    const root = await resolveRepo(repo)
    if (!file) throw new Error('no path')
    let r
    if (hash === 'WORKING') {
      r = await git(root, ['diff', 'HEAD', '--', file])
      if (!r.out) r = await git(root, ['diff', '--no-index', '--', '/dev/null', file])
    } else if (!HASH.test(hash)) throw new Error('bad hash')
    else if (base) r = await git(root, ['diff', base, hash, '--', file])
    else r = await git(root, ['show', '--format=', '-m', '--first-parent', hash, '--', file])
    const lines = r.out.split('\n')
    return { diff: lines.slice(0, 2000).join('\n') + (lines.length > 2000 ? `\n… ${lines.length - 2000} more lines` : '') }
  },
  async act({ repo, op, hash, name, newName, mode }) {
    const root = await resolveRepo(repo)
    const okName = n => typeof n === 'string' && NAME.test(n)
    const okHash = h => typeof h === 'string' && HASH.test(h)
    let args, label
    switch (op) {
      case 'checkout': if (!okHash(hash) && !okName(name)) throw new Error('bad target'); args = ['checkout', name || hash]; label = 'Checkout'; break
      case 'branch': if (!okHash(hash) || !okName(name)) throw new Error('bad branch name'); args = ['checkout', '-b', name, hash]; label = 'Create branch'; break
      case 'tag': if (!okHash(hash) || !okName(name)) throw new Error('bad tag name'); args = ['tag', name, hash]; label = 'Tag'; break
      case 'cherry-pick': if (!okHash(hash)) throw new Error('bad hash'); args = ['cherry-pick', hash]; label = 'Cherry-pick'; break
      case 'revert': if (!okHash(hash)) throw new Error('bad hash'); args = ['revert', '--no-edit', hash]; label = 'Revert'; break
      case 'merge': if (!okHash(hash)) throw new Error('bad hash'); args = ['merge', hash]; label = 'Merge'; break
      case 'reset': if (!okHash(hash) || !['--soft', '--mixed', '--hard'].includes(mode)) throw new Error('bad reset'); args = ['reset', mode, hash]; label = 'Reset ' + mode.slice(2); break
      case 'delete-branch': if (!okName(name)) throw new Error('bad name'); args = ['branch', '-d', name]; label = 'Delete branch'; break
      case 'delete-tag': if (!okName(name)) throw new Error('bad name'); args = ['tag', '-d', name]; label = 'Delete tag'; break
      case 'rebase': if (!okHash(hash)) throw new Error('bad hash'); args = ['rebase', hash]; label = 'Rebase'; break
      case 'push-branch': if (!okName(name)) throw new Error('bad name'); args = ['push', '--set-upstream', 'origin', name]; label = 'Push ' + name; break
      case 'push-tag': if (!okName(name)) throw new Error('bad name'); args = ['push', 'origin', 'refs/tags/' + name]; label = 'Push tag ' + name; break
      case 'rename-branch': if (!okName(name) || !okName(newName)) throw new Error('bad name'); args = ['branch', '-m', name, newName]; label = 'Rename branch'; break
      case 'checkout-remote': if (!okName(name)) throw new Error('bad name'); args = ['checkout', '--track', name]; label = 'Checkout ' + name; break
      case 'stash': args = ['stash', 'push', '-u', '-m', 'Git Graph stash']; label = 'Stash'; break
      case 'reset-head': args = ['reset', '--hard', 'HEAD']; label = 'Discard changes'; break
      case 'pull': args = ['pull', '--ff-only']; label = 'Pull'; break
      case 'fetch': args = ['fetch', '--all', '--prune']; label = 'Fetch'; break
      default: throw new Error('unknown action')
    }
    const r = await git(root, args, 120000)
    return { ok: r.code === 0, message: r.code === 0 ? `${label}: done` : `${label} failed: ${first(r.err) || first(r.out)}` }
  },
  async fp({ repo }) { return { fp: await fingerprint(await resolveRepo(repo)) } },
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

http.createServer(async (req, res) => {
  const host = (req.headers.host || '').toLowerCase()
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'bad host' })
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/') return send(res, 200, HTML.replace('__TOKEN__', TOKEN), 'text/html')
  if (req.headers['x-token'] !== TOKEN) return send(res, 403, { error: 'bad token' })
  const name = url.pathname.replace(/^\/api\//, '')
  if (!url.pathname.startsWith('/api/') || !Object.hasOwn(api, name)) return send(res, 404, { error: 'not found' })
  try {
    let params = Object.fromEntries(url.searchParams)
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 1e5) throw new Error('too large') }
      params = { ...params, ...JSON.parse(body || '{}') }
    } else if (name === 'act') return send(res, 405, { error: 'POST only' })
    send(res, 200, await api[name](params))
  } catch (e) {
    send(res, 200, { error: String(e.message || e) })
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Git Graph viewer: http://127.0.0.1:${PORT}/`))
  .on('error', e => { console.error(e.message); process.exit(1) })

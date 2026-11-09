#!/usr/bin/env node
// Git Graph viewer: a zero-dependency local server. Usage: node server.js [port]
// Serves index.html and a small JSON API over `git`, bound to 127.0.0.1 only.
// Every git call goes through execFile with an argv array; user input is validated
// and never starts with "-", so it can't be read as an option.
const http = require('http')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT = +(process.env.GIT_GRAPH_PORT || process.argv[2] || 47770)
const TOKEN = crypto.randomBytes(16).toString('hex')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

const ENV = {
  ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',     // polling `status` must not take index.lock away from the user's own git commands
  GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_PAGER: 'cat', GIT_MERGE_AUTOEDIT: 'no',
}
// Neutralise user config that would change machine-readable output.
const BASE = ['-c', 'core.quotepath=off', '-c', 'color.ui=never', '-c', 'log.showSignature=false', '-c', 'diff.noprefix=false']

// literal: file names given by the client are paths, never pathspec magic or globs. Not set
// globally because it breaks `git stash -u`.
const git = (repo, args, { timeout = 30000, buffer = false, literal = false } = {}) =>
  new Promise(resolve => {
    execFile('git', [...(literal ? ['--literal-pathspecs'] : []), ...BASE, ...args], {
      cwd: repo, maxBuffer: 64 * 1024 * 1024, timeout, env: ENV, encoding: buffer ? 'buffer' : 'utf8',
    }, (err, out, errOut) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out,
      err: err && err.code === 'ENOENT' ? 'git is not installed or not on PATH' : String(errOut || (err && !errOut ? err.message : '')),
    }))
  })

const HASH = /^[0-9a-f]{4,64}$/
const NAME = /^[\w][\w./@+-]*$/                 // branch / tag / remote-ref names
const REF = /^[\w][\w./@{}~^+-]*$/               // any revision expression (read-only use)
const STASH = /^stash@\{\d{1,5}\}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const first = s => (s || '').trim().split('\n')[0] || ''
const errText = r => (r.err || '').split('\n').concat((r.out || '').split('\n'))
  .map(l => l.trim()).filter(l => l && !/^hint:/.test(l)).slice(0, 6).join('\n')
const str = (v, max = 500) => typeof v === 'string' && v.length <= max ? v : ''

const repoCache = new Map()
async function resolveRepo(p) {
  if (!p || typeof p !== 'string') throw new Error('No folder given')
  const dir = path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME || '~'))
  const hit = repoCache.get(dir)
  if (hit && Date.now() - hit.t < 5000) return hit.v
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Folder not found: ' + dir)
  const r = await git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'])
  if (r.code !== 0) throw new Error(/safe\.directory|dubious ownership/.test(r.err) ? first(r.err) : 'Not a git repository (or a bare one): ' + dir)
  const [root, gitDir, common] = r.out.trim().split('\n')
  const v = { root, gitDir, commonDir: path.resolve(dir, common || gitDir) }
  repoCache.set(dir, { t: Date.now(), v })
  return v
}
const rootOf = async p => (await resolveRepo(p)).root

// --name-status -z and --numstat -z, renames included.
function parseFiles(ns, num) {
  const t = ns.split('\0'), files = []
  for (let i = 0; i < t.length;) {
    const s = t[i++]; if (!s) continue
    if (s[0] === 'R' || s[0] === 'C') { files.push({ status: s[0], old: t[i], path: t[i + 1] }); i += 2 }
    else files.push({ status: s[0], path: t[i++] })
  }
  const nums = parseNumstat(num)
  for (const f of files) { const n = nums.get(f.path) || [0, 0]; f.add = n[0]; f.del = n[1] }
  return files
}
// --numstat -z: "add\tdel\tpath\0", or "add\tdel\t\0old\0new\0" for a rename. Binary counts are "-" (-> -1).
function parseNumstat(num) {
  const nums = new Map(), u = num.split('\0')
  for (let i = 0; i < u.length;) {
    const rec = u[i++]; if (!rec) continue
    const a = rec.indexOf('\t'), b = rec.indexOf('\t', a + 1); if (a < 0 || b < 0) continue
    const add = rec.slice(0, a), del = rec.slice(a + 1, b); let file = rec.slice(b + 1)
    if (file === '') { i++; file = u[i++] }
    nums.set(file, [add === '-' ? -1 : +add, del === '-' ? -1 : +del])
  }
  return nums
}

function opState(gitDir) {
  const has = f => fs.existsSync(path.join(gitDir, f))
  if (has('rebase-merge') || (has('rebase-apply') && !has('rebase-apply/applying'))) return 'rebase'
  if (has('rebase-apply')) return 'am'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  return ''
}
const readHead = gitDir => { try { return fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim() } catch { return '' } }

async function fingerprint(repo) {
  const [refs, st] = await Promise.all([
    git(repo.root, ['for-each-ref', '--format=%(objectname) %(refname)']),
    git(repo.root, ['status', '--porcelain', '-uall', '-z']),
  ])
  return crypto.createHash('sha1').update([refs.out, st.out, readHead(repo.gitDir), opState(repo.gitDir)].join('|')).digest('hex')
}

function parseStatus(out) {
  const t = out.split('\0'), files = []
  for (let i = 0; i < t.length;) {
    const e = t[i++]; if (!e || e.length < 4) continue
    const xy = e.slice(0, 2), file = e.slice(3)
    const conflict = /^(DD|AU|UD|UA|DU|AA|UU)$/.test(xy)
    const f = { status: conflict ? 'X' : xy === '??' ? 'U' : xy[0] !== ' ' ? xy[0] : xy[1], path: file, add: 0, del: 0 }
    if (xy[0] === 'R' || xy[0] === 'C') { f.status = xy[0]; f.old = t[i++] }
    files.push(f)
  }
  return files
}

const api = {
  async info({ repo }) {
    const R = await resolveRepo(repo), root = R.root
    const [refs, cur, st, fp, head, remotes, stash] = await Promise.all([
      git(root, ['for-each-ref', '--format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)', 'refs/heads', 'refs/remotes', 'refs/tags']),
      git(root, ['branch', '--show-current']),
      git(root, ['status', '--porcelain', '-uall', '-z']),
      fingerprint(R),
      git(root, ['rev-parse', '--verify', '-q', 'HEAD']),
      git(root, ['remote']),
      git(root, ['stash', 'list', '--format=%gd%x1f%H%x1f%ar%x1f%gs']),
    ])
    const local = [], remote = [], tags = [], upstream = {}
    for (const l of refs.out.split('\n').filter(Boolean)) {
      const [n, up, track] = l.split('\0')
      if (n.startsWith('refs/heads/')) {
        const b = n.slice(11); local.push(b)
        if (up) upstream[b] = { up, gone: track === 'gone', ahead: +(/ahead (\d+)/.exec(track) || [0, 0])[1], behind: +(/behind (\d+)/.exec(track) || [0, 0])[1] }
      } else if (n.startsWith('refs/remotes/')) { if (!n.endsWith('/HEAD')) remote.push(n.slice(13)) }
      else if (n.startsWith('refs/tags/')) tags.push(n.slice(10))
    }
    const files = parseStatus(st.out)
    return {
      root, fp, current: first(cur.out), head: first(head.out), dirty: files.length,
      conflicts: files.filter(f => f.status === 'X').length, state: opState(R.gitDir),
      shallow: fs.existsSync(path.join(R.commonDir, 'shallow')),
      local, remote, tags, upstream, remotes: remotes.out.split('\n').filter(Boolean),
      stashes: stash.out.split('\n').filter(Boolean).map(l => { const [name, hash, when, msg] = l.split('\x1f'); return { name, hash, when, msg } }),
    }
  },
  async log({ repo, branches, remotes, n, grep, author, since, until, nomerge, file }) {
    const root = await rootOf(repo)
    let picked = []
    try { picked = JSON.parse(branches || '[]') } catch {}
    picked = (Array.isArray(picked) ? picked : []).filter(b => typeof b === 'string' && /^refs\/(heads|remotes|tags)\//.test(b) && NAME.test(b)).slice(0, 100)
    // refs/stash is excluded: stashes are listed separately, not drawn as branches.
    const scope = picked.length ? picked : remotes === '0' ? ['--branches', '--tags', 'HEAD'] : ['--exclude=refs/stash', '--all']
    const N = Math.max(1, Math.min(parseInt(n, 10) || 300, 10000))
    const args = ['log', '--topo-order', '--no-color', '-n', String(N), '--date=short', '--format=%H%x1f%P%x1f%an%x1f%ar%x1f%ad%x1f%D%x1f%s']
    if (grep = str(grep, 300)) args.push('--regexp-ignore-case', '--fixed-strings', '--grep=' + grep)
    if (author = str(author, 200)) args.push('--regexp-ignore-case', '--fixed-strings', '--author=' + author)
    if (DATE.test(since || '')) args.push('--since=' + since + ' 00:00')
    if (DATE.test(until || '')) args.push('--until=' + until + ' 23:59:59')
    if (nomerge === '1') args.push('--no-merges')
    file = str(file, 4096)
    if (file) args.push('--follow')
    args.push(...scope, '--')
    if (file) args.push(file)
    const r = await git(root, args, { timeout: 60000, literal: true })
    if (r.code !== 0) {
      if (/does not have any commits|bad default revision 'HEAD'|ambiguous argument 'HEAD'/.test(r.err)) return [] // no commits yet
      throw new Error(first(r.err) || 'git log failed')
    }
    return r.out.split('\n').filter(Boolean).map(line => {
      const [hash, parents, author, when, date, refs, subject] = line.split('\x1f')
      return { hash, parents: parents ? parents.split(' ') : [], author, when, date, subject, refs: refs ? refs.split(', ').filter(Boolean) : [] }
    })
  },
  async resolve({ repo, ref }) {
    const root = await rootOf(repo)
    if (!REF.test(ref || '') || ref.length > 300) throw new Error('Not a valid ref: ' + String(ref).slice(0, 80))
    const r = await git(root, ['rev-parse', '--verify', '-q', ref + '^{commit}'])
    if (r.code !== 0) throw new Error('Unknown ref: ' + ref)
    return { hash: first(r.out) }
  },
  async commit({ repo, hash, base }) {
    const root = await rootOf(repo)
    if (hash === 'WORKING') {
      const [st, ns] = await Promise.all([git(root, ['status', '--porcelain', '-uall', '-z']), git(root, ['diff', '--no-ext-diff', '-M', 'HEAD', '--numstat', '-z'])])
      const files = parseStatus(st.out)
      const counts = parseNumstat(ns.code === 0 ? ns.out : '')
      for (const f of files) { const c = counts.get(f.path); if (c) [f.add, f.del] = c; else if (f.status === 'U') f.add = f.del = null }
      return { hash, title: 'Uncommitted changes', meta: {}, message: '', files }
    }
    if (!HASH.test(hash || '')) throw new Error('bad hash')
    if (base) {
      if (!HASH.test(base)) throw new Error('bad base')
      const [a, b] = await Promise.all([
        git(root, ['diff', '--no-ext-diff', '-M', '--name-status', '-z', base, hash]),
        git(root, ['diff', '--no-ext-diff', '-M', '--numstat', '-z', base, hash]),
      ])
      if (a.code !== 0) throw new Error(first(a.err) || 'diff failed')
      return { hash, base, title: `Compare ${base.slice(0, 7)} → ${hash.slice(0, 7)}`, meta: {}, message: '', files: parseFiles(a.out, b.out) }
    }
    const dt = ['diff-tree', '-r', '-m', '--first-parent', '--root', '--no-commit-id', '-M', '-z']
    const [m, a, b] = await Promise.all([
      git(root, ['show', '-s', '--date=format:%a %d %b %Y %H:%M', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%cn%x1f%B', hash, '--']),
      git(root, [...dt, '--name-status', hash]),
      git(root, [...dt, '--numstat', hash]),
    ])
    if (m.code !== 0) throw new Error(first(m.err) || 'Unknown commit ' + hash)
    const [full, parents, author, email, date, committer, ...body] = m.out.split('\x1f')
    const msg = body.join('\x1f').trim()
    return {
      hash, title: msg.split('\n')[0], message: msg.split('\n').slice(1).join('\n').trim(),
      meta: { full, parents: parents ? parents.split(' ') : [], author, email, date, committer },
      files: parseFiles(a.out, b.out),
    }
  },
  async diff({ repo, hash, base, path: file, old, ctx }) {
    const root = await rootOf(repo)
    file = str(file, 4096); old = str(old, 4096)
    if (!file) throw new Error('no path')
    const paths = old && old !== file ? [old, file] : [file]
    const U = '-U' + Math.min(Math.max(parseInt(ctx, 10) || 3, 0), 100000)
    let r
    if (hash === 'WORKING') {
      r = await git(root, ['diff', '--no-ext-diff', '-M', U, 'HEAD', '--', ...paths], { literal: true })
      if (r.code !== 0 || !r.out) {
        // Untracked file (or a repo with no commits): diff against /dev/null, but only for a
        // path git itself lists as untracked or staged, so this can't read files outside the repo.
        const ls = await git(root, ['ls-files', '-z', '--others', '--cached', '--exclude-standard', '--', file], { literal: true })
        if (!ls.out.split('\0').includes(file)) return { diff: r.out || '', truncated: 0 }
        r = await git(root, ['diff', '--no-ext-diff', '--no-index', U, '--', '/dev/null', file])
      }
    } else if (!HASH.test(hash || '')) throw new Error('bad hash')
    else if (base) { if (!HASH.test(base)) throw new Error('bad base'); r = await git(root, ['diff', '--no-ext-diff', '-M', U, base, hash, '--', ...paths], { literal: true }) }
    else r = await git(root, ['show', '--no-ext-diff', '--format=', '-m', '--first-parent', '-M', U, hash, '--', ...paths], { literal: true })
    const lines = r.out.split('\n')
    const MAX = 8000
    return { diff: lines.slice(0, MAX).join('\n'), truncated: Math.max(0, lines.length - MAX) }
  },
  // The file's content at a commit (or in the working tree), for the raw viewer.
  async raw({ repo, hash, path: file }) {
    const R = await resolveRepo(repo), root = R.root
    file = str(file, 4096); if (!file) throw new Error('no path')
    const LIMIT = 2 * 1024 * 1024
    let buf
    if (hash === 'WORKING') {
      let real
      try { real = fs.realpathSync(path.resolve(root, file)) } catch { throw new Error('File not found (deleted?)') }
      const rootReal = fs.realpathSync(root)
      if (!real.startsWith(rootReal + path.sep) || real.startsWith(fs.realpathSync(R.gitDir) + path.sep)) throw new Error('Path is outside the repository')
      const stat = fs.statSync(real); if (!stat.isFile()) throw new Error('Not a file')
      if (stat.size > LIMIT) return { size: stat.size, tooBig: true }
      buf = fs.readFileSync(real)
    } else {
      if (!HASH.test(hash || '')) throw new Error('bad hash')
      const spec = hash + ':' + file
      const s = await git(root, ['cat-file', '-s', spec])
      if (s.code !== 0) throw new Error('File does not exist at ' + hash.slice(0, 7))
      if (+s.out > LIMIT) return { size: +s.out, tooBig: true }
      buf = (await git(root, ['cat-file', 'blob', spec], { buffer: true })).out
    }
    if (buf.subarray(0, 8000).includes(0)) return { size: buf.length, binary: true }
    return { size: buf.length, text: buf.toString('utf8') }
  },
  async patch({ repo, hash, base }) {
    const root = await rootOf(repo)
    let r
    if (hash === 'WORKING') r = await git(root, ['diff', '--no-ext-diff', '--binary', 'HEAD'])
    else if (!HASH.test(hash || '')) throw new Error('bad hash')
    else if (base) { if (!HASH.test(base)) throw new Error('bad base'); r = await git(root, ['diff', '--no-ext-diff', '--binary', base, hash]) }
    else {
      r = await git(root, ['format-patch', '-1', '--stdout', '--binary', '--no-signature', hash])
      if (r.code === 0 && !r.out.trim()) r = await git(root, ['show', '--no-ext-diff', '--binary', '--format=email', '-m', '--first-parent', hash]) // merge commit
    }
    if (r.code !== 0) throw new Error(first(r.err) || 'Could not build the patch')
    return { patch: r.out }
  },
  async act(p) {
    const R = await resolveRepo(p.repo)
    // One write at a time per repository, so a double click can't race on index.lock.
    const prev = locks.get(R.root) || Promise.resolve()
    const run = prev.then(() => doAct(R, p), () => doAct(R, p))
    locks.set(R.root, run.catch(() => {}))
    return run
  },
  async fp({ repo }) { return { fp: await fingerprint(await resolveRepo(repo)) } },
}
const locks = new Map()

async function doAct(R, { op, hash, name, newName, mode, message, checkout, remote, force, noff, kind }) {
  const root = R.root
  const okName = n => typeof n === 'string' && n.length <= 250 && NAME.test(n)
  const okHash = h => typeof h === 'string' && HASH.test(h)
  const need = (c, m) => { if (!c) throw new Error(m) }
  const validRef = async (prefix, n, what) => {
    need(okName(n), `Not a valid ${what} name: ${String(n).slice(0, 80)}`)
    const r = await git(root, ['check-ref-format', prefix + n])
    need(r.code === 0, `Not a valid ${what} name: ${n}`)
  }
  const remotes = (await git(root, ['remote'])).out.split('\n').filter(Boolean)
  const pickRemote = r => { if (r) { need(remotes.includes(r), 'Unknown remote: ' + r); return r } need(remotes.length, 'This repository has no remotes'); return remotes.includes('origin') ? 'origin' : remotes[0] }
  const parentsOf = async h => (await git(root, ['rev-list', '--parents', '-n', '1', h])).out.trim().split(' ').length - 1
  const msg = typeof message === 'string' ? message.slice(0, 20000).trim() : ''
  let args, label
  switch (op) {
    case 'checkout':
      if (name) { need(okName(name), 'bad branch'); args = ['checkout', name, '--']; label = 'Checkout ' + name }
      else { need(okHash(hash), 'bad target'); args = ['checkout', '--detach', hash]; label = 'Checkout ' + hash.slice(0, 7) }
      break
    case 'branch': need(okHash(hash), 'bad hash'); await validRef('refs/heads/', name, 'branch')
      args = checkout === false ? ['branch', name, hash] : ['checkout', '-b', name, hash]; label = 'Create branch ' + name; break
    case 'tag': need(okHash(hash), 'bad hash'); await validRef('refs/tags/', name, 'tag')
      args = msg ? ['tag', '-a', '--message=' + msg, name, hash] : ['tag', name, hash]; label = 'Tag ' + name; break
    case 'cherry-pick': need(okHash(hash), 'bad hash')
      args = (await parentsOf(hash)) > 1 ? ['cherry-pick', '-m', '1', hash] : ['cherry-pick', hash]; label = 'Cherry-pick'; break
    case 'revert': need(okHash(hash), 'bad hash')
      args = (await parentsOf(hash)) > 1 ? ['revert', '--no-edit', '-m', '1', hash] : ['revert', '--no-edit', hash]; label = 'Revert'; break
    case 'merge': need(okHash(hash) || okName(name), 'bad target')
      args = ['merge', ...(noff ? ['--no-ff'] : []), '--no-edit', name || hash]; label = 'Merge ' + (name || hash.slice(0, 7)); break
    case 'rebase': need(okHash(hash) || okName(name), 'bad target'); args = ['rebase', name || hash]; label = 'Rebase'; break
    case 'reset': need(okHash(hash) && ['--soft', '--mixed', '--hard'].includes(mode), 'bad reset'); args = ['reset', mode, hash]; label = 'Reset ' + mode.slice(2); break
    case 'delete-branch': need(okName(name), 'bad name'); args = ['branch', force ? '-D' : '-d', name]; label = 'Delete branch ' + name; break
    case 'delete-remote-branch': {
      need(okName(name), 'bad name')
      const rm = remotes.filter(r => name.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0]
      need(rm, 'No remote matches ' + name)
      args = ['push', rm, '--delete', name.slice(rm.length + 1)]; label = 'Delete ' + name; break
    }
    case 'delete-tag': need(okName(name), 'bad name'); args = ['tag', '-d', name]; label = 'Delete tag ' + name; break
    case 'rename-branch': need(okName(name), 'bad name'); await validRef('refs/heads/', newName, 'branch'); args = ['branch', '-m', name, newName]; label = 'Rename branch'; break
    case 'checkout-remote': need(okName(name), 'bad name'); args = ['checkout', '--track', name]; label = 'Checkout ' + name; break
    case 'push-branch': need(okName(name), 'bad name'); { const rm = pickRemote(remote); args = ['push', '--set-upstream', rm, 'refs/heads/' + name]; label = `Push ${name} to ${rm}` } break
    case 'push-tag': need(okName(name), 'bad name'); { const rm = pickRemote(remote); args = ['push', rm, 'refs/tags/' + name]; label = `Push tag ${name} to ${rm}` } break
    case 'push': {
      const cur = first((await git(root, ['branch', '--show-current'])).out)
      need(cur, 'Not on a branch (detached HEAD): nothing to push')
      const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      args = up.code === 0 ? ['push'] : ['push', '--set-upstream', pickRemote(remote), 'HEAD']; label = 'Push ' + cur; break
    }
    case 'pull': args = ['pull', '--ff-only']; label = 'Pull'; break
    case 'fetch': args = ['fetch', '--all', '--prune']; label = 'Fetch'; break
    case 'stash': args = ['stash', 'push', '--include-untracked', '--message=' + (msg || 'Git Graph stash')]; label = 'Stash'; break
    case 'stash-apply': case 'stash-pop': case 'stash-drop':
      need(STASH.test(name || ''), 'bad stash'); args = ['stash', op.slice(6), name]; label = { apply: 'Apply ', pop: 'Pop ', drop: 'Drop ' }[op.slice(6)] + name; break
    case 'reset-head': args = ['reset', '--hard', 'HEAD']; label = 'Discard changes'; break
    case 'clean': args = ['clean', '-fd']; label = 'Delete untracked files'; break
    case 'abort': case 'continue': case 'skip': {
      need(['merge', 'rebase', 'cherry-pick', 'revert', 'am'].includes(kind), 'bad operation')
      need(!(op === 'skip' && kind === 'merge'), 'A merge cannot be skipped')
      need(opState(R.gitDir) === kind, 'No ' + kind + ' is in progress')
      args = [kind, '--' + op]; label = kind[0].toUpperCase() + kind.slice(1) + ' ' + op; break
    }
    default: throw new Error('unknown action')
  }
  const r = await git(root, args, { timeout: 180000 })
  repoCache.clear()
  const out = first(r.out)
  return { ok: r.code === 0, message: r.code === 0 ? `${label}: done${out && /up to date|Fast-forward|Successfully/i.test(out) ? ' (' + out + ')' : ''}` : `${label} failed:\n${errText(r) || 'git exited with code ' + r.code}` }
}

const SEC = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }
const send = (res, code, body, type = 'application/json', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', ...SEC, ...extra })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
const tokenOk = t => typeof t === 'string' && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN))

http.createServer(async (req, res) => {
  const host = (req.headers.host || '').toLowerCase()
  const origins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]
  // Host check stops DNS rebinding; Origin / Sec-Fetch-Site stop other sites driving the API.
  if (!origins.includes('http://' + host)) return send(res, 403, { error: 'bad host' })
  if (req.headers.origin && !origins.includes(req.headers.origin)) return send(res, 403, { error: 'bad origin' })
  if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'cross-site request' })
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/') {
    const nonce = crypto.randomBytes(16).toString('base64')
    return send(res, 200, HTML.replace('__TOKEN__', TOKEN).replace('<script>', `<script nonce="${nonce}">`), 'text/html', {
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    })
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204, SEC); return res.end() }
  if (!tokenOk(req.headers['x-token'])) return send(res, 403, { error: 'bad token' })
  const name = url.pathname.replace(/^\/api\//, '')
  if (!url.pathname.startsWith('/api/') || !Object.hasOwn(api, name)) return send(res, 404, { error: 'not found' })
  try {
    let params = Object.fromEntries(url.searchParams)
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 1e5) throw new Error('too large') }
      const j = JSON.parse(body || '{}')
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('bad body')
      params = { ...params, ...j }
    } else if (name === 'act') return send(res, 405, { error: 'POST only' })
    send(res, 200, await api[name](params))
  } catch (e) {
    send(res, 200, { error: String(e.message || e) })
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Git Graph viewer: http://127.0.0.1:${PORT}/`))
  .on('error', e => { console.error(e.message); process.exit(1) })

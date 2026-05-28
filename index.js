#!/usr/bin/env node
'use strict'
// gitlet — git implementation from scratch.
// Commands: init add status commit log diff show branch checkout merge reset stash tag

const fs   = require('fs')
const path = require('path')
const {
  sha256, writeBlob, buildTree, flattenTree,
  writeCommit, readCommit, readObject, commitHistory, isAncestor,
} = require('./objects')
const {
  currentBranch, readHead, writeHead, readRef, writeRef, deleteRef, listBranches,
  writeTag, readTag, deleteTag, listTags, readStash, writeStash,
} = require('./refs')

const GITLET     = '.gitlet'
const INDEX_FILE = path.join(GITLET, 'index.json')

const C = {
  reset:  '\x1b[0m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
}

// ── Index ─────────────────────────────────────────────────────────────────────

function readIndex() {
  return fs.existsSync(INDEX_FILE) ? JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) : {}
}

function writeIndex(idx) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2))
}

// ── Working tree ──────────────────────────────────────────────────────────────

function loadIgnorePatterns() {
  const p = '.gitletignore'
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
}

function isIgnored(relPath, patterns) {
  const basename = path.basename(relPath)
  for (const pat of patterns) {
    if (relPath === pat)                              return true
    if (basename === pat)                             return true
    if (relPath.startsWith(pat + '/'))                return true
    if (pat.startsWith('*.') && relPath.endsWith(pat.slice(1))) return true
  }
  return false
}

function listFiles(dir = '.', hardIgnore = [GITLET, '.git', 'node_modules', '.DS_Store']) {
  const patterns = loadIgnorePatterns()
  const results  = []
  function walk(cur) {
    for (const entry of fs.readdirSync(cur)) {
      if (hardIgnore.includes(entry)) continue
      const full = path.join(cur, entry)
      const rel  = path.relative('.', full)
      if (isIgnored(rel, patterns)) continue
      if (fs.statSync(full).isDirectory()) walk(full)
      else results.push(rel)
    }
  }
  walk(dir)
  return results
}

// ── Unified diff ──────────────────────────────────────────────────────────────

function lcsEdits(oldLines, newLines) {
  const m = oldLines.length, n = newLines.length
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i+1][j+1] + 1
        : Math.max(dp[i+1][j], dp[i][j+1])

  const ops = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) { ops.push({ op: ' ',  line: oldLines[i] }); i++; j++ }
    else if (j < n && (i >= m || dp[i+1] && dp[i+1][j] >= (dp[i] ? dp[i][j+1] : 0))) {
      ops.push({ op: '+', line: newLines[j] }); j++
    } else { ops.push({ op: '-', line: oldLines[i] }); i++ }
  }
  return ops
}

function unifiedDiff(oldLines, newLines, fromFile, toFile, context = 3) {
  const ops = lcsEdits(oldLines, newLines)
  if (!ops.some(o => o.op !== ' ')) return []

  const out = [
    `${C.bold}--- a/${fromFile}${C.reset}`,
    `${C.bold}+++ b/${toFile}${C.reset}`,
  ]

  // Group changed regions with context
  const n = ops.length
  let pos = 0
  while (pos < n) {
    if (ops[pos].op === ' ') { pos++; continue }
    const start = Math.max(0, pos - context)
    let   end   = pos + 1
    while (end < n && (ops[end].op !== ' ' || end - pos < context)) end++
    end = Math.min(n, end + context)

    const hunk = ops.slice(start, end)
    const oldC = hunk.filter(o => o.op !== '+').length
    const newC = hunk.filter(o => o.op !== '-').length
    out.push(`${C.cyan}@@ -${start+1},${oldC} +${start+1},${newC} @@${C.reset}`)

    for (const o of hunk) {
      if      (o.op === '+') out.push(`${C.green}+${o.line}${C.reset}`)
      else if (o.op === '-') out.push(`${C.red}-${o.line}${C.reset}`)
      else                   out.push(` ${o.line}`)
    }
    pos = end
  }
  return out
}

// ── Tree helpers ──────────────────────────────────────────────────────────────

function restoreTree(treeHash) {
  const files = flattenTree(treeHash)
  for (const [relPath, blobHash] of Object.entries(files)) {
    const abs = path.join('.', relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const { rawData } = readObject(blobHash)
    fs.writeFileSync(abs, rawData)
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmd_init() {
  if (fs.existsSync(GITLET)) return console.log('Already a gitlet repository.')
  fs.mkdirSync(path.join(GITLET, 'objects'),        { recursive: true })
  fs.mkdirSync(path.join(GITLET, 'refs', 'heads'), { recursive: true })
  fs.mkdirSync(path.join(GITLET, 'refs', 'tags'),  { recursive: true })
  fs.writeFileSync(path.join(GITLET, 'HEAD'), 'ref: refs/heads/main\n')
  writeIndex({})
  console.log('Initialized empty gitlet repository in .gitlet/')
}

function cmd_add(files) {
  const idx   = readIndex()
  const toAdd = files.length ? files : listFiles()
  let   count = 0
  for (const f of toAdd) {
    if (!fs.existsSync(f)) { console.log(`error: '${f}' not found`); continue }
    if (fs.statSync(f).isDirectory()) {
      for (const sub of listFiles(f)) { idx[sub] = writeBlob(sub); count++ }
    } else {
      idx[f] = writeBlob(f); count++
    }
  }
  writeIndex(idx)
  console.log(`staged ${count} file(s)`)
}

function cmd_status() {
  const idx     = readIndex()
  const working = new Set(listFiles())
  const staged  = new Set(Object.keys(idx))
  const branch  = currentBranch() || 'HEAD (detached)'
  console.log(`On branch ${branch}\n`)

  const untracked = [...working].filter(f => !staged.has(f))
  const deleted   = [...staged].filter(f  => !working.has(f))
  const modified  = [...working].filter(f => {
    if (!staged.has(f)) return false
    const content = fs.readFileSync(f)
    const full    = Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])
    return sha256(full) !== idx[f]
  })

  if (staged.size)      console.log(`  ${C.green}Staged:${C.reset}\n${[...staged].map(f => `    + ${f}`).join('\n')}\n`)
  if (modified.length)  console.log(`  ${C.yellow}Modified (not staged):${C.reset}\n${modified.map(f => `    M ${f}`).join('\n')}\n`)
  if (deleted.length)   console.log(`  ${C.red}Deleted (not staged):${C.reset}\n${deleted.map(f => `    D ${f}`).join('\n')}\n`)
  if (untracked.length) console.log(`  ${C.dim}Untracked:${C.reset}\n${untracked.map(f => `    ? ${f}`).join('\n')}\n`)
  if (!staged.size && !modified.length && !deleted.length)
    console.log('  nothing to commit, working tree clean')
}

function cmd_commit(message) {
  if (!message) return console.log('error: commit message required (-m "...")')
  const idx    = readIndex()
  if (!Object.keys(idx).length) return console.log('nothing to commit')
  const tree   = buildTree(idx)
  const parent = readHead()
  const hash   = writeCommit({ tree, parent, message, author: process.env.USER || 'dev' })
  const branch = currentBranch()
  if (branch) writeRef(branch, hash)
  else fs.writeFileSync(path.join(GITLET, 'HEAD'), hash + '\n')
  writeIndex({})
  console.log(`[${(branch || 'HEAD').padEnd(10)} ${hash.slice(0, 7)}] ${message}`)
}

function cmd_log(args) {
  const oneline = args.includes('--oneline')
  let hash = readHead()
  if (!hash) return console.log('No commits yet.')
  const headHash = hash
  while (hash) {
    const c   = readCommit(hash)
    const br  = currentBranch()
    const ref = hash === headHash ? ` (HEAD -> ${br || 'HEAD'})` : ''
    const tagLabels = listTags().filter(t => readTag(t) === hash).map(t => ` tag: ${t}`).join('')
    if (oneline) {
      console.log(`${C.yellow}${hash.slice(0, 7)}${C.reset}${ref}${tagLabels} ${c.message}`)
    } else {
      console.log(`${C.yellow}commit ${hash}${ref}${tagLabels}${C.reset}`)
      console.log(`Author: ${c.author}`)
      console.log(`Date:   ${c.date}`)
      console.log(`\n    ${c.message}\n`)
    }
    hash = c.parent
  }
}

function cmd_diff() {
  const idx   = readIndex()
  const files = listFiles()
  let   any   = false
  for (const f of files) {
    if (!idx[f]) continue
    const current  = fs.readFileSync(f, 'utf8').split('\n')
    const { data } = readObject(idx[f])
    const oldLines = data.split('\n')
    const hunks    = unifiedDiff(oldLines, current, f, f)
    if (!hunks.length) continue
    any = true
    console.log(`${C.bold}diff --gitlet a/${f} b/${f}${C.reset}`)
    for (const line of hunks) console.log(line)
  }
  if (!any) console.log('No changes.')
}

function cmd_show(ref) {
  const hash = ref ? (readRef(ref) || readTag(ref) || ref) : readHead()
  if (!hash) return console.log('No commits yet.')
  const c = readCommit(hash)
  console.log(`${C.yellow}commit ${hash}${C.reset}`)
  console.log(`Author: ${c.author}`)
  console.log(`Date:   ${c.date}`)
  console.log(`\n    ${c.message}\n`)
  if (c.tree && c.parent) {
    const newFiles = flattenTree(c.tree)
    const oldFiles = flattenTree(readCommit(c.parent).tree)
    const all      = new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])
    for (const f of all) {
      if (oldFiles[f] === newFiles[f]) continue
      const oldLines = oldFiles[f] ? readObject(oldFiles[f]).data.split('\n') : []
      const newLines = newFiles[f] ? readObject(newFiles[f]).data.split('\n') : []
      console.log(`${C.bold}diff --gitlet a/${f} b/${f}${C.reset}`)
      for (const line of unifiedDiff(oldLines, newLines, f, f)) console.log(line)
    }
  }
}

function cmd_branch(args) {
  const del  = args.includes('-d') || args.includes('--delete')
  const name = args.find(a => a !== '-d' && a !== '--delete')

  if (del && name) {
    if (currentBranch() === name) return console.log(`error: cannot delete branch '${name}' (currently checked out)`)
    if (!readRef(name)) return console.log(`error: branch '${name}' not found`)
    deleteRef(name)
    return console.log(`Deleted branch '${name}'.`)
  }

  if (!name) {
    const cur = currentBranch()
    for (const b of listBranches()) console.log(b === cur ? `${C.green}* ${b}${C.reset}` : `  ${b}`)
    return
  }

  const head = readHead()
  if (!head) return console.log('error: no commits yet')
  writeRef(name, head)
  console.log(`Branch '${name}' created at ${head.slice(0, 7)}`)
}

function cmd_checkout(args) {
  const create = args.includes('-b')
  const name   = args.find(a => a !== '-b')
  if (!name) return console.log('error: branch name required')

  if (create) {
    const head = readHead()
    if (!head) return console.log('error: no commits yet')
    if (readRef(name)) return console.log(`error: branch '${name}' already exists`)
    writeRef(name, head)
    writeHead(name)
    return console.log(`Switched to a new branch '${name}'`)
  }

  const hash = readRef(name)
  if (!hash) return console.log(`error: branch '${name}' not found`)
  writeHead(name)
  const c = readCommit(hash)
  restoreTree(c.tree)
  writeIndex(flattenTree(c.tree))
  console.log(`Switched to branch '${name}'`)
}

function cmd_merge(branchName) {
  if (!branchName) return console.log('error: branch name required')
  const ourHash   = readHead()
  const theirHash = readRef(branchName)
  if (!ourHash)   return console.log('error: no commits yet')
  if (!theirHash) return console.log(`error: branch '${branchName}' not found`)
  if (ourHash === theirHash) return console.log('Already up to date.')

  // Fast-forward: ours is ancestor of theirs
  if (isAncestor(ourHash, theirHash)) {
    const branch = currentBranch()
    if (branch) writeRef(branch, theirHash)
    else fs.writeFileSync(path.join(GITLET, 'HEAD'), theirHash + '\n')
    const c = readCommit(theirHash)
    restoreTree(c.tree)
    writeIndex(flattenTree(c.tree))
    console.log(`Fast-forward`)
    console.log(`[${(branch || 'HEAD').padEnd(10)} ${theirHash.slice(0, 7)}] ${c.message}`)
    return
  }

  // 3-way merge
  const ourHistory   = commitHistory(ourHash)
  const theirHistory = new Set(commitHistory(theirHash))
  const base         = ourHistory.find(h => theirHistory.has(h))
  const baseFiles    = base ? flattenTree(readCommit(base).tree) : {}
  const ourFiles     = flattenTree(readCommit(ourHash).tree)
  const theirFiles   = flattenTree(readCommit(theirHash).tree)
  const allFiles     = new Set([...Object.keys(baseFiles), ...Object.keys(ourFiles), ...Object.keys(theirFiles)])

  const mergedIndex  = {}
  const conflicts    = []

  for (const f of allFiles) {
    const baseH  = baseFiles[f]  || null
    const ourH   = ourFiles[f]   || null
    const theirH = theirFiles[f] || null

    if (ourH === theirH) {
      if (ourH) mergedIndex[f] = ourH
    } else if (ourH === baseH) {
      if (theirH) mergedIndex[f] = theirH
    } else if (theirH === baseH) {
      if (ourH) mergedIndex[f] = ourH
    } else {
      // Both sides changed — write conflict markers
      const ourData   = ourH   ? readObject(ourH).data   : ''
      const theirData = theirH ? readObject(theirH).data : ''
      const conflict  = `<<<<<<< HEAD\n${ourData}\n=======\n${theirData}\n>>>>>>> ${branchName}\n`
      const abs       = path.join('.', f)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, conflict)
      mergedIndex[f] = writeBlob(f)
      conflicts.push(f)
    }
  }

  // Write non-conflict files to disk
  for (const [f, h] of Object.entries(mergedIndex)) {
    if (conflicts.includes(f)) continue
    const abs = path.join('.', f)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, readObject(h).rawData)
  }

  if (conflicts.length) {
    writeIndex(mergedIndex)
    for (const f of conflicts) console.log(`CONFLICT (content): ${f}`)
    console.log('\nAutomatic merge failed; fix conflicts and commit.')
    return
  }

  const treeHash = buildTree(mergedIndex)
  const branch   = currentBranch()
  const message  = `Merge branch '${branchName}'`
  const commitH  = writeCommit({
    tree: treeHash, parentList: [ourHash, theirHash],
    message, author: process.env.USER || 'dev',
  })
  if (branch) writeRef(branch, commitH)
  else fs.writeFileSync(path.join(GITLET, 'HEAD'), commitH + '\n')
  writeIndex({})
  console.log(`Merged '${branchName}' into ${branch || 'HEAD'}`)
  console.log(`[${(branch || 'HEAD').padEnd(10)} ${commitH.slice(0, 7)}] ${message}`)
}

function cmd_reset(args) {
  let mode = '--mixed', target = null
  for (const a of args) {
    if (a === '--soft' || a === '--mixed' || a === '--hard') mode = a
    else target = a
  }
  if (!target) return console.log('error: reset target required (e.g. HEAD~1 or a hash)')

  let hash
  if (target === 'HEAD') {
    hash = readHead()
  } else if (/^HEAD[~^]\d*$/.test(target)) {
    let cur = readHead()
    const n = target.startsWith('HEAD~') ? parseInt(target.slice(5) || '1', 10) : 1
    for (let i = 0; i < n && cur; i++) cur = readCommit(cur).parent
    hash = cur
  } else {
    hash = readRef(target) || target
  }
  if (!hash) return console.log('error: could not resolve target')

  const branch = currentBranch()
  if (branch) writeRef(branch, hash)
  else fs.writeFileSync(path.join(GITLET, 'HEAD'), hash + '\n')

  if (mode === '--soft') {
    console.log(`HEAD is now at ${hash.slice(0, 7)}`)
    return
  }

  const c     = readCommit(hash)
  const files = flattenTree(c.tree)

  if (mode === '--hard') {
    restoreTree(c.tree)
    writeIndex(files)
    console.log(`HEAD is now at ${hash.slice(0, 7)} (hard reset)`)
  } else {
    writeIndex(files)
    console.log(`HEAD is now at ${hash.slice(0, 7)} (mixed reset)`)
  }
}

function cmd_stash(subcmd) {
  const stack = readStash()

  if (!subcmd || subcmd === 'save') {
    const idx = readIndex()
    if (!Object.keys(idx).length) return console.log('No local changes to stash.')
    stack.unshift({ date: new Date().toISOString(), index: idx })
    writeStash(stack)
    writeIndex({})
    console.log(`Saved working directory state to stash@{0}`)
    return
  }

  if (subcmd === 'list') {
    if (!stack.length) return console.log('No stash entries.')
    stack.forEach((e, i) => console.log(`stash@{${i}}: ${e.date}`))
    return
  }

  if (subcmd === 'drop') {
    if (!stack.length) return console.log('No stash entries to drop.')
    const d = stack.shift()
    writeStash(stack)
    console.log(`Dropped stash@{0}: ${d.date}`)
    return
  }

  if (subcmd === 'pop' || subcmd === 'apply') {
    if (!stack.length) return console.log('No stash entries.')
    const entry = stack[0]
    const idx   = readIndex()
    Object.assign(idx, entry.index)
    writeIndex(idx)
    if (subcmd === 'pop') { stack.shift(); writeStash(stack) }
    console.log(`Applied stash@{0}: ${entry.date}`)
    return
  }

  console.log(`Unknown stash subcommand: ${subcmd}`)
}

function cmd_tag(args) {
  const del  = args.includes('-d')
  const name = args.find(a => a !== '-d')

  if (!name) {
    const tags = listTags()
    if (!tags.length) return console.log('No tags.')
    for (const t of tags) console.log(t)
    return
  }

  if (del) {
    if (!readTag(name)) return console.log(`error: tag '${name}' not found`)
    deleteTag(name)
    return console.log(`Deleted tag '${name}'.`)
  }

  const hash = readHead()
  if (!hash) return console.log('error: no commits yet')
  writeTag(name, hash)
  console.log(`Tag '${name}' created at ${hash.slice(0, 7)}`)
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv

const HELP = {
  init:     'Initialize a repository',
  add:      'Stage files',
  status:   'Show working tree status',
  commit:   'Record changes  -m "message"',
  log:      'Show commit history  [--oneline]',
  diff:     'Show unstaged changes',
  show:     'Show a commit  [ref]',
  branch:   'List / create / delete branches  [-b] [-d]',
  checkout: 'Switch or create branch  [-b name]',
  merge:    'Merge a branch into HEAD',
  reset:    'Reset HEAD  [--soft|--mixed|--hard] <target>',
  stash:    'Stash changes  [pop|apply|list|drop]',
  tag:      'Create / list / delete tags  [-d]',
}

const commands = {
  init:     () => cmd_init(),
  add:      () => cmd_add(args),
  status:   () => cmd_status(),
  commit:   () => cmd_commit(args[args.indexOf('-m') + 1]),
  log:      () => cmd_log(args),
  diff:     () => cmd_diff(),
  show:     () => cmd_show(args[0]),
  branch:   () => cmd_branch(args),
  checkout: () => cmd_checkout(args),
  merge:    () => cmd_merge(args[0]),
  reset:    () => cmd_reset(args),
  stash:    () => cmd_stash(args[0]),
  tag:      () => cmd_tag(args),
}

if (!commands[cmd]) {
  console.log(`${C.bold}gitlet${C.reset} — git implementation\n`)
  console.log(`Usage: node index.js <command> [options]\n`)
  for (const [k, v] of Object.entries(HELP)) {
    console.log(`  ${k.padEnd(12)} ${C.dim}${v}${C.reset}`)
  }
} else {
  try { commands[cmd]() }
  catch (e) { console.error(`${C.red}error:${C.reset}`, e.message) }
}

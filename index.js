#!/usr/bin/env node
'use strict'
// gitlet — minimal git implementation.
// Commands: init · add · commit · status · log · diff · branch · checkout

const fs   = require('fs')
const path = require('path')
const { writeBlob, writeTree, writeCommit, readCommit, readTree, readObject } = require('./objects')
const { currentBranch, readHead, writeHead, readRef, writeRef, listBranches } = require('./refs')

const GITLET     = '.gitlet'
const INDEX_FILE = path.join(GITLET, 'index.json')

// ── Index (staging area) ──────────────────────────────────────────────────────

function readIndex() {
  return fs.existsSync(INDEX_FILE) ? JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) : {}
}
function writeIndex(idx) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2))
}

// ── Working tree helpers ───────────────────────────────────────────────────────

function listFiles(dir = '.', ignore = [GITLET, '.git', 'node_modules', '.DS_Store']) {
  const results = []
  for (const entry of fs.readdirSync(dir)) {
    if (ignore.includes(entry)) continue
    const full = path.join(dir, entry)
    const rel  = path.relative('.', full)
    if (fs.statSync(full).isDirectory()) results.push(...listFiles(full, ignore))
    else results.push(rel)
  }
  return results
}

function treeFromIndex(idx) {
  const grouped = {}
  for (const [file, hash] of Object.entries(idx)) {
    const parts = file.split(path.sep)
    const name  = parts[parts.length - 1]
    // Flatten to root-level tree for simplicity
    grouped[name] = { mode: '100644', name, hash }
  }
  return writeTree(Object.values(grouped))
}

// ── Commands ───────────────────────────────────────────────────────────────────

function cmd_init() {
  if (fs.existsSync(GITLET)) return console.log('Already a gitlet repository.')
  fs.mkdirSync(path.join(GITLET, 'objects'),        { recursive: true })
  fs.mkdirSync(path.join(GITLET, 'refs', 'heads'), { recursive: true })
  fs.writeFileSync(path.join(GITLET, 'HEAD'), 'ref: refs/heads/main\n')
  writeIndex({})
  console.log('Initialized empty gitlet repository in .gitlet/')
}

function cmd_add(files) {
  const idx = readIndex()
  const toAdd = files.length ? files : listFiles()
  for (const f of toAdd) {
    if (!fs.existsSync(f)) { console.log(`error: '${f}' not found`); continue }
    if (fs.statSync(f).isDirectory()) {
      for (const sub of listFiles(f)) { idx[sub] = writeBlob(sub) }
    } else {
      idx[f] = writeBlob(f)
    }
  }
  writeIndex(idx)
  console.log(`staged ${toAdd.length} file(s)`)
}

function cmd_status() {
  const idx     = readIndex()
  const working = new Set(listFiles())
  const staged  = new Set(Object.keys(idx))
  const branch  = currentBranch() || 'HEAD (detached)'
  console.log(`On branch ${branch}\n`)

  const untracked = [...working].filter(f => !staged.has(f))
  const deleted   = [...staged].filter(f => !working.has(f))
  const modified  = [...working].filter(f => {
    if (!staged.has(f)) return false
    const { sha256 } = require('./objects')
    const content = fs.readFileSync(f, 'utf8')
    const current = sha256(`blob ${content.length}\0${content}`)
    return current !== idx[f]
  })

  if (staged.size)      console.log(`  Staged for commit:\n${[...staged].map(f => `    + ${f}`).join('\n')}\n`)
  if (modified.length)  console.log(`  Modified (not staged):\n${modified.map(f => `    M ${f}`).join('\n')}\n`)
  if (deleted.length)   console.log(`  Deleted (not staged):\n${deleted.map(f => `    D ${f}`).join('\n')}\n`)
  if (untracked.length) console.log(`  Untracked:\n${untracked.map(f => `    ? ${f}`).join('\n')}\n`)
  if (!staged.size && !modified.length && !deleted.length) console.log('  nothing to commit, working tree clean')
}

function cmd_commit(message) {
  if (!message) return console.log('error: commit message required (-m "...")')
  const idx    = readIndex()
  if (!Object.keys(idx).length) return console.log('nothing to commit')
  const tree   = treeFromIndex(idx)
  const parent = readHead()
  const hash   = writeCommit({ tree, parent, message, author: process.env.USER || 'dev' })
  const branch = currentBranch()
  if (branch) writeRef(branch, hash)
  else fs.writeFileSync(path.join(GITLET, 'HEAD'), hash + '\n')
  writeIndex({})
  console.log(`[${(branch || 'HEAD').padEnd(10)} ${hash.slice(0, 7)}] ${message}`)
}

function cmd_log() {
  let hash = readHead()
  if (!hash) return console.log('No commits yet.')
  while (hash) {
    const c   = readCommit(hash)
    const br  = currentBranch()
    const ref = hash === readHead() ? ` (HEAD -> ${br || 'HEAD'})` : ''
    console.log(`\x1b[33mcommit ${hash}${ref}\x1b[0m`)
    console.log(`Author: ${c.author}`)
    console.log(`Date:   ${c.date}`)
    console.log(`\n    ${c.message}\n`)
    hash = c.parent
  }
}

function cmd_diff() {
  const idx   = readIndex()
  const files = listFiles()
  let   any   = false
  for (const f of files) {
    if (!idx[f]) continue
    const current = fs.readFileSync(f, 'utf8').split('\n')
    const { data: old } = readObject(idx[f])
    const oldLines = old.split('\n')
    const hunks    = diffLines(oldLines, current)
    if (!hunks.length) continue
    any = true
    console.log(`\x1b[1mdiff --gitlet a/${f} b/${f}\x1b[0m`)
    for (const line of hunks) console.log(line)
  }
  if (!any) console.log('No changes.')
}

function diffLines(oldLines, newLines) {
  const out   = []
  const maxL  = Math.max(oldLines.length, newLines.length)
  let   block = []
  for (let i = 0; i < maxL; i++) {
    const o = oldLines[i], n = newLines[i]
    if (o !== n) {
      if (o !== undefined) block.push(`\x1b[31m- ${o}\x1b[0m`)
      if (n !== undefined) block.push(`\x1b[32m+ ${n}\x1b[0m`)
    } else if (block.length) {
      out.push(`@@ line ${i + 1} @@`, ...block)
      block = []
    }
  }
  if (block.length) out.push(`@@ end @@`, ...block)
  return out
}

function cmd_branch(name) {
  if (!name) {
    const cur = currentBranch()
    for (const b of listBranches()) console.log(b === cur ? `* ${b}` : `  ${b}`)
    return
  }
  const head = readHead()
  if (!head) return console.log('error: no commits yet')
  writeRef(name, head)
  console.log(`Branch '${name}' created at ${head.slice(0, 7)}`)
}

function cmd_checkout(name) {
  const hash = readRef(name)
  if (!hash) return console.log(`error: branch '${name}' not found`)
  writeHead(name)
  console.log(`Switched to branch '${name}'`)
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv

const commands = {
  init:     () => cmd_init(),
  add:      () => cmd_add(args),
  status:   () => cmd_status(),
  commit:   () => cmd_commit(args[args.indexOf('-m') + 1]),
  log:      () => cmd_log(),
  diff:     () => cmd_diff(),
  branch:   () => cmd_branch(args[0]),
  checkout: () => cmd_checkout(args[0]),
}

if (!commands[cmd]) {
  console.log(`gitlet — mini git\n\nUsage: node index.js <command>\n\nCommands: ${Object.keys(commands).join(' · ')}`)
} else {
  try { commands[cmd]() }
  catch (e) { console.error('error:', e.message) }
}

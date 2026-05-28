'use strict'
const fs   = require('fs')
const path = require('path')

const GITLET = '.gitlet'

function headPath()    { return path.join(GITLET, 'HEAD') }
function refPath(name) { return path.join(GITLET, 'refs', 'heads', name) }
function tagPath(name) { return path.join(GITLET, 'refs', 'tags', name) }
function stashPath()   { return path.join(GITLET, 'stash') }

function currentBranch() {
  const head = fs.readFileSync(headPath(), 'utf8').trim()
  if (head.startsWith('ref: ')) return head.slice(16)   // "ref: refs/heads/main"
  return null   // detached HEAD
}

function readHead() {
  const head = fs.readFileSync(headPath(), 'utf8').trim()
  if (head.startsWith('ref: ')) {
    const refFile = path.join(GITLET, head.slice(5))
    return fs.existsSync(refFile) ? fs.readFileSync(refFile, 'utf8').trim() : null
  }
  return head   // detached HEAD — raw hash
}

function writeHead(branchOrHash, detached) {
  if (detached) {
    fs.writeFileSync(headPath(), branchOrHash + '\n')
  } else {
    fs.writeFileSync(headPath(), `ref: refs/heads/${branchOrHash}\n`)
  }
}

function readRef(name) {
  const p = refPath(name)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null
}

function writeRef(name, hash) {
  const p = refPath(name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, hash + '\n')
}

function deleteRef(name) {
  const p = refPath(name)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

function listBranches() {
  const dir = path.join(GITLET, 'refs', 'heads')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
}

// ── Tags ──────────────────────────────────────────────────────────────────────

function writeTag(name, hash) {
  const p = tagPath(name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, hash + '\n')
}

function readTag(name) {
  const p = tagPath(name)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null
}

function deleteTag(name) {
  const p = tagPath(name)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

function listTags() {
  const dir = path.join(GITLET, 'refs', 'tags')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
}

// ── Stash ─────────────────────────────────────────────────────────────────────

function readStash() {
  const p = stashPath()
  if (!fs.existsSync(p)) return []
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) { return [] }
}

function writeStash(stack) {
  fs.writeFileSync(stashPath(), JSON.stringify(stack, null, 2))
}

module.exports = {
  currentBranch, readHead, writeHead,
  readRef, writeRef, deleteRef, listBranches,
  writeTag, readTag, deleteTag, listTags,
  readStash, writeStash,
}

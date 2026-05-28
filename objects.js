'use strict'
// Content-addressable object store — the core of git's design.
// Every blob, tree, and commit is identified by SHA-256 of its content.

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const GITLET_DIR = '.gitlet'

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function objectPath(hash) {
  return path.join(GITLET_DIR, 'objects', hash.slice(0, 2), hash.slice(2))
}

function writeObject(type, content) {
  const data   = Buffer.isBuffer(content) ? content : Buffer.from(content)
  const header = Buffer.from(`${type} ${data.length}\0`)
  const full   = Buffer.concat([header, data])
  const hash   = sha256(full)
  const p      = objectPath(hash)
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, full)
  }
  return hash
}

function readObject(hash) {
  const full   = fs.readFileSync(objectPath(hash))
  const nullAt = full.indexOf(0)
  const header = full.slice(0, nullAt).toString()
  const [type] = header.split(' ')
  const data   = full.slice(nullAt + 1)
  return { type, data: data.toString(), rawData: data }
}

// ── Object types ──────────────────────────────────────────────────────────────

function writeBlob(filePath) {
  const content = fs.readFileSync(filePath)
  return writeObject('blob', content)
}

// Build a nested tree from a flat {filepath: hash} index.
// Recursively creates subtree objects for each directory level.
function buildTree(index) {
  function buildNode(entries) {
    const dirMap  = {}  // dirname -> [[relpath, hash], ...]
    const fileMap = {}  // name    -> hash

    for (const [filepath, hash] of entries) {
      const slash = filepath.indexOf('/')
      if (slash === -1) {
        fileMap[filepath] = hash
      } else {
        const dir  = filepath.slice(0, slash)
        const rest = filepath.slice(slash + 1)
        if (!dirMap[dir]) dirMap[dir] = []
        dirMap[dir].push([rest, hash])
      }
    }

    const treeEntries = []
    for (const [dir, subEntries] of Object.entries(dirMap)) {
      const subTreeHash = buildNode(subEntries)
      treeEntries.push({ mode: '040000', name: dir, hash: subTreeHash })
    }
    for (const [name, hash] of Object.entries(fileMap)) {
      treeEntries.push({ mode: '100644', name, hash })
    }
    return writeTree(treeEntries)
  }

  const entries = Object.entries(index)
  if (!entries.length) return writeTree([])
  // Normalise path separators to forward slash
  const normalised = entries.map(([p, h]) => [p.split(path.sep).join('/'), h])
  return buildNode(normalised)
}

// Recursively read a nested tree and return flat {filepath: hash}.
function flattenTree(treeHash, prefix) {
  prefix = prefix || ''
  const result  = {}
  const entries = readTree(treeHash)
  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.mode === '040000') {
      const sub = flattenTree(entry.hash, fullPath)
      Object.assign(result, sub)
    } else {
      result[fullPath] = entry.hash
    }
  }
  return result
}

function writeTree(entries) {
  // entries: [{mode, name, hash}]
  const content = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => `${e.mode} ${e.name}\0${e.hash}`)
    .join('\n')
  return writeObject('tree', content)
}

function readTree(hash) {
  const { data } = readObject(hash)
  if (!data.trim()) return []
  return data.split('\n').map(line => {
    const nullAt = line.indexOf('\0')
    const [mode, name] = line.slice(0, nullAt).split(' ')
    const h    = line.slice(nullAt + 1)
    return { mode, name, hash: h }
  })
}

// Accept both single parent (backwards compat) and parentList: [hash, ...]
function writeCommit({ tree, parent, parentList, message, author }) {
  const parents = parentList
    ? parentList
    : parent
      ? [parent]
      : []

  const ts    = new Date().toISOString()
  const lines = [
    `tree ${tree}`,
    ...parents.map(p => `parent ${p}`),
    `author ${author || 'unknown'}`,
    `date ${ts}`,
    '',
    message,
  ]
  return writeObject('commit', lines.join('\n'))
}

function readCommit(hash) {
  const { data } = readObject(hash)
  const lines    = data.split('\n')
  const meta     = { parents: [] }
  let   i        = 0
  while (i < lines.length && lines[i] !== '') {
    const sp  = lines[i].indexOf(' ')
    const key = lines[i].slice(0, sp)
    const val = lines[i].slice(sp + 1)
    if (key === 'parent') {
      meta.parents.push(val)
    } else {
      meta[key] = val
    }
    i++
  }
  // Backwards-compat: expose first parent as meta.parent
  meta.parent  = meta.parents[0] || null
  meta.message = lines.slice(i + 1).join('\n').trim()
  return meta
}

// BFS walk — returns array of all reachable commit hashes starting from hash
function commitHistory(hash) {
  const visited = new Set()
  const queue   = [hash]
  const result  = []
  while (queue.length) {
    const cur = queue.shift()
    if (!cur || visited.has(cur)) continue
    visited.add(cur)
    result.push(cur)
    try {
      const c = readCommit(cur)
      for (const p of c.parents) queue.push(p)
    } catch (_) {}
  }
  return result
}

// Returns true if ancestorHash is reachable from descendantHash
function isAncestor(ancestorHash, descendantHash) {
  const history = commitHistory(descendantHash)
  return history.includes(ancestorHash)
}

module.exports = {
  sha256,
  writeBlob,
  buildTree,
  flattenTree,
  writeTree,
  readTree,
  writeCommit,
  readCommit,
  readObject,
  commitHistory,
  isAncestor,
}

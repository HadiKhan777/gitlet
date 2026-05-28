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
  const data   = Buffer.from(content)
  const header = `${type} ${data.length}\0`
  const full   = Buffer.concat([Buffer.from(header), data])
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
  return { type, data: data.toString() }
}

// ── Object types ──────────────────────────────────────────────────────────────

function writeBlob(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  return writeObject('blob', content)
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

function writeCommit({ tree, parent, message, author }) {
  const ts      = new Date().toISOString()
  const content = [
    `tree ${tree}`,
    parent ? `parent ${parent}` : null,
    `author ${author || 'unknown'}`,
    `date ${ts}`,
    '',
    message,
  ].filter(l => l !== null).join('\n')
  return writeObject('commit', content)
}

function readCommit(hash) {
  const { data } = readObject(hash)
  const lines    = data.split('\n')
  const meta     = {}
  let   i        = 0
  while (lines[i] !== '' && i < lines.length) {
    const sp   = lines[i].indexOf(' ')
    meta[lines[i].slice(0, sp)] = lines[i].slice(sp + 1)
    i++
  }
  meta.message = lines.slice(i + 1).join('\n').trim()
  return meta
}

module.exports = { sha256, writeBlob, writeTree, readTree, writeCommit, readCommit, readObject }

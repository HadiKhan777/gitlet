# gitlet

A subset of git implemented from scratch in Node.js. No dependencies.

Built to understand how git actually works — content-addressable storage, Merkle trees, the index, refs.

## Commands

```bash
node index.js init                  # initialise repository
node index.js add [file...]         # stage files (or all)
node index.js commit -m "message"   # create a commit
node index.js status                # show staged / modified / untracked
node index.js log                   # commit history
node index.js diff                  # diff staged files vs working tree
node index.js branch [name]         # list or create branches
node index.js checkout <branch>     # switch branch
```

## How it works

Every file, directory snapshot, and commit is stored as a content-addressed object — identified by its SHA-256 hash.

```
.gitlet/
  HEAD               → ref: refs/heads/main
  index.json         → staging area {path: hash}
  refs/heads/main    → commit hash
  objects/ab/cdef…   → blob / tree / commit objects
```

- **Blob** — file content
- **Tree** — directory snapshot (list of blobs + sub-trees)
- **Commit** — tree hash + parent hash + message

This is exactly how real git works (except git uses SHA-1 and zlib compression).

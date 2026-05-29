# gitlet

Git implemented from scratch in Node.js. No dependencies.

Built to understand how git actually works: content-addressable object store, Merkle trees, the index, refs, and the merge algorithm.

## Commands

```
init          Initialize a repository
add           Stage files
status        Show working tree status
commit        Record changes  -m "message"
log           Show commit history  [--oneline]
diff          Show unstaged changes (LCS-based unified diff)
show          Show a commit and its diff  [ref]
branch        List / create / delete branches  [-b] [-d]
checkout      Switch or create branch  [-b name]
merge         Merge a branch (fast-forward or 3-way)
reset         Reset HEAD  [--soft|--mixed|--hard] <target>
stash         Stash changes  [pop|apply|list|drop]
tag           Create / list / delete tags  [-d]
```

## Quick start

```bash
node index.js init
echo "hello" > README.md
node index.js add .
node index.js commit -m "initial commit"

# Branch and merge
node index.js branch feature
node index.js checkout feature
echo "feature work" > feature.js
node index.js add . && node index.js commit -m "add feature"
node index.js checkout main
node index.js merge feature

# Stash
node index.js stash
node index.js stash pop

# Tags
node index.js tag v1.0
node index.js tag

# Reset
node index.js reset --hard HEAD~1

# Oneline log
node index.js log --oneline
```

## How it works

**Object store** (`objects.js`)

Every blob, tree, and commit is content-addressed by SHA-256 and stored in `.gitlet/objects/<2>/<62>`. Identical content always produces the same hash — the core property that makes git work.

**Nested trees**

Unlike a flat index, trees are recursive: a commit points to a tree, which points to blobs (files) and sub-trees (directories). `buildTree(index)` recursively constructs the tree from the flat `{filepath: hash}` staging area. `flattenTree(hash)` reverses it.

**Merge algorithm**

1. **Fast-forward**: if `HEAD` is an ancestor of the target, just advance the ref.
2. **3-way merge**: find the common ancestor via BFS through commit history. For each file: take the changed side if only one changed; write conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) if both changed. Creates a merge commit with two parents.

**Reset modes**

- `--soft` — move `HEAD` only (staged changes preserved)
- `--mixed` — move `HEAD` + reset index (default)
- `--hard` — move `HEAD` + reset index + restore working tree

**Unified diff**

Uses LCS (Longest Common Subsequence) to compute edit operations, then groups changes into hunks with configurable context lines — the same algorithm as GNU diff.

## .gitletignore

Place a `.gitletignore` in the repo root. Supports exact paths, directory prefixes, bare filenames, and `*.ext` globs.

```
node_modules
*.log
dist/
.env
```

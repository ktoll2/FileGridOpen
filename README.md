# FileGridOpen

Opens a configured set of files side by side in VS Code.

## Configuration

File sets live outside the project, in your user config directory — not in
VS Code settings and not committed with the project. Each workspace gets its
own JSON file, named from the folder's name plus a short hash of its full
path:

- Linux: `$XDG_CONFIG_HOME/file-grid-open/workspaces/` (defaults to `~/.config/file-grid-open/workspaces/`)
- macOS: `~/Library/Application Support/file-grid-open/workspaces/`
- Windows: `%APPDATA%\file-grid-open\workspaces\`

Use the **Edit Configuration** button in the sidebar (or the
**FileGridOpen: Edit Configuration** command) rather than remembering the exact
path — it creates the file with a starter example and opens it.

To use a different location, set **FileGridOpen: Config Path**
(`fileGridOpen.configPath`) in Settings (per-workspace, since it's a resource
setting). A relative value resolves against the workspace folder — so you
could point it back inside the project if you want the config committed
after all — a leading `~` expands to your home directory, and leaving it
empty keeps the default location above.

Each file is a JSON array of objects, with a `name` and a `paths` list
(relative to the workspace root, or absolute).

Each path entry is either a plain string, or an object with `path` plus
optional `column`/`row` numbers for explicit layout control:

```json
[
  {
    "name": "component + styles + test",
    "paths": [
      "src/components/Button.tsx",
      "src/components/Button.css",
      "src/components/Button.test.tsx"
    ]
  },
  {
    "name": "component with test below",
    "paths": [
      { "path": "src/components/Button.tsx", "column": 0, "row": 0 },
      { "path": "src/components/Button.test.tsx", "column": 0, "row": 1 },
      { "path": "src/components/Button.css", "column": 1 }
    ]
  }
]
```

- **No `column`/`row`**: files open left to right in the order listed, one
  per column, matching the plain-string form above.
- **`column`** (0-based): controls horizontal position. `column` values are
  sort keys, not literal slots, so `0` and `2` with no `1` still produces two
  adjacent columns.
- **`row`** (0-based): stacks files vertically within a column (a vertical
  split). Omit it, or give every file in a column the same row, to keep that
  column single-row.
- Up to 9 editor groups total (VS Code's limit); extra files are skipped with
  a warning.
- **Side effect**: a file set that uses `row` rebuilds the whole editor grid
  to create the split, which closes/discards any other open editor groups in
  the window. A file set that only uses `column` (or neither) doesn't do
  this — it opens new columns alongside whatever's already open.

## Usage

A **FileGridOpen** icon in the Activity Bar opens a sidebar listing your
configured sets; click one to open its files side by side. The view's title
bar has buttons to edit the config file and to refresh the list.

Its **Edit Configuration** button opens a form-based editor for the file
sets (add/remove sets and files, browse for a path, set `column`/`row`) with
an **Edit as JSON** escape hatch for anything the form doesn't cover. Saving
rejects a file set where two files resolve to the same column/row — that's
ambiguous, since only one file can occupy a given grid cell — and highlights
the conflicting rows until you fix them.

Alternatively, run **FileGridOpen: Open File Set** from the Command Palette —
if more than one set is configured, you'll be prompted to pick one.

Right-click a file (or a multi-selection) in the Explorer and choose **Add to
FileGridOpen Set...** to append it to an existing set or create a new one,
without hand-editing the config.

## Development

```bash
npm install
npm run compile
npm test
```

Press F5 in VS Code to launch an Extension Development Host, or run
`make package` to build a `.vsix`.

Tests cover the pure config/layout logic in `src/core/` (no VS Code API
needed) via Node's built-in test runner - `src/config.ts` and `src/layout.ts`
are thin wrappers around that core adding the actual `vscode.*` calls, and
aren't covered by these tests.

## Publishing

`package.json`'s `publisher`, `repository`, `bugs`, and `homepage` fields, and
`LICENSE`'s copyright line, are still placeholders (`your-publisher-id`,
`your-github-username`, `REPLACE_WITH_YOUR_NAME`) - fill those in with your
real Marketplace publisher ID and repo URL before publishing.

- `make package` builds `file-grid-open.vsix`, stamped with the version in `VERSION`.
- `make publish-vscode` / `make publish-ovsx` / `make publish` publish that
  vsix to the VS Code Marketplace and/or Open VSX; each needs its own token
  (`VSCE_PAT`, `OVSX_PAT`) available in the environment.
- `.github/workflows/release.yml` does the same in CI: run it manually with
  `release: release` to build, test, package, publish to whichever
  marketplace has its PAT set as a repo secret, and cut a GitHub release.

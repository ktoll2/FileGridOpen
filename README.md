# File Grid Open

<img src="resources/marketplace-icon.png" align="left" width="120" alt="File Grid Open logo">

[![Build](https://github.com/ktoll2/FileGridOpen/actions/workflows/release.yml/badge.svg)](https://github.com/ktoll2/FileGridOpen/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/ktoll2/FileGridOpen?display_name=tag&logo=github)](https://github.com/ktoll2/FileGridOpen/releases/latest)
[![Prerelease](https://img.shields.io/github/v/release/ktoll2/FileGridOpen?include_prereleases&display_name=tag&filter=*-pre&label=prerelease)](https://github.com/ktoll2/FileGridOpen/releases)
[![License: MIT](https://img.shields.io/github/license/ktoll2/FileGridOpen)](LICENSE)

Save groups of files as named sets and open any set side by side in one click, laid out in the columns and rows you choose.

<br clear="left">

## Requirements

- VS Code 1.85 or later (or VSCodium)
- A folder or workspace open, since file sets are stored per workspace

## Install

Search for **File Grid Open** in the Extensions view, or install a `.vsix` from the [releases page](https://github.com/ktoll2/FileGridOpen/releases): open the Extensions view, choose the `...` menu, and select **Install from VSIX...**. From a terminal:

```bash
code --install-extension FileGridOpen.vsix
```

Use `codium` instead of `code` for VSCodium. Each release's notes list the `.vsix` SHA-256 checksum (`sha256sum FileGridOpen.vsix` to check it).

## Getting started

1. Click the **File Grid Open** icon in the Activity Bar.
2. Create a set: right-click a file in the Explorer and choose **Add to File Grid Open Set...**, or use **Edit Configuration** in the view's title bar. You can also arrange your editors the way you like and run **File Grid Open: Save Current Layout as File Set...**.
3. Click a set in the sidebar to open its files side by side.

## The sidebar

Sets are listed in the sidebar and expand to show their files. A file that no longer exists is marked with a warning icon.

- **Right-click a set** to open, edit, rename, duplicate, pin to the status bar, update from the current layout, copy as JSON, move to a group, or delete it (with confirmation).
- **Right-click a file** to remove it from its set, or open just that file in a chosen editor group: its configured position, the active group, beside it, or any open group.
- **Groups** are sidebar folders. Use **Move to Group...** to file a set under one, then right-click the folder to rename it or remove it (the sets are kept).
- **Drag and drop**: drag files from the Explorer onto a set to add them, drag sets to reorder them or onto a folder to group them, and drag files within a set or onto another set to move them.

## The configuration editor

**Edit Configuration** opens a form for your sets. It saves automatically as you type, and **Edit as JSON** opens the raw file for anything the form doesn't cover.

- Add, remove, duplicate and reorder sets and files (arrow buttons), and browse for a path.
- Set each file's `column` and `row`. If two files would land in the same cell, the change isn't saved and the conflicting rows are highlighted.
- Per-set options: **Close other editors on open**, **Open on startup**, **Pin to status bar**, and **Group**.
- Duplicate names get a number appended ("New set 2").
- Paths that don't exist are highlighted. The editor updates itself when the config changes elsewhere.

## Commands

Run these from the Command Palette, or the `...` menu in the view's title bar.

| Command | What it does |
| --- | --- |
| **File Grid Open: Open File Set** | Open a set, choosing from a list if there is more than one |
| **File Grid Open: Open Last File Set** | Reopen the set you opened last (also a status bar button) |
| **File Grid Open: Save Current Layout as File Set...** | Create a set from the files open in the editor grid, keeping their columns and rows |
| **File Grid Open: Import File Set from Clipboard** | Add sets from JSON copied with **Copy File Set as JSON** |
| **File Grid Open: Edit Configuration** | Open the configuration editor |
| **File Grid Open: Edit Configuration (JSON)** | Open the raw config file |
| **File Grid Open: Refresh** | Reload the sidebar |

None of them have default keybindings; bind any of them in Keyboard Shortcuts.

## The config file

File sets live outside your project, in your user config directory, with one JSON file per workspace named from the folder's name plus a short hash of its path:

- Linux: `~/.config/FileGridOpen/workspaces/` (or `$XDG_CONFIG_HOME/FileGridOpen/workspaces/`)
- macOS: `~/Library/Application Support/FileGridOpen/workspaces/`
- Windows: `%APPDATA%\FileGridOpen\workspaces\`

**Edit Configuration (JSON)** opens the right file for you. To store it somewhere else, set **File Grid Open: Config Path** (`fileGridOpen.configPath`): a relative value resolves against the workspace folder (so you can keep it in the project and commit it), and `~` expands to your home directory.

The file is a JSON array of sets. Each has a `name` and a `paths` list (relative to the workspace root, or absolute), and gets an automatic `id` that you should leave alone. A path is a plain string, or an object with `path` plus optional `column` and `row`:

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

### Layout

- With no `column` or `row`, files open left to right in the order listed, one per column.
- `column` (0-based) sets horizontal position. Values are sort keys, not literal slots, so `0` and `2` with no `1` still give two adjacent columns.
- `row` (0-based) stacks files vertically within a column. Leave it out, or give every file in a column the same row, to keep that column to a single row.
- VS Code allows up to 9 editor groups; extra files are skipped with a warning.
- A set that uses `row` rebuilds the whole editor grid, which closes any other open editor groups in the window. A set that only uses `column` opens new columns alongside whatever is already open.

### Set options

| Field | Effect |
| --- | --- |
| `"closeOthers": true` | Close every other editor before opening the set |
| `"openOnStartup": true` | Open the set when the workspace loads (only the first flagged set opens) |
| `"pinned": true` | Show the set as its own button in the status bar |
| `"group": "Name"` | List the set under a sidebar folder of that name |

### Glob patterns and dates

A path containing `*`, `?` or `{` is a glob pattern relative to the workspace, such as `src/components/Button.*`. When the set opens, it is replaced by the matching files (up to 100) in natural order, so `log.2` comes before `log.10`. Without a `column` the matches go into successive columns; with one they stack as rows in that column, starting at the entry's `row` (or 0). A pattern that matches nothing shows a warning. Brackets aren't special, so `pages/[id].tsx` is a literal name.

Set `"newest": N` on a glob entry to open only the N most recently modified matches, still laid out in name order: `{ "path": "logs/All_*.log", "newest": 1 }`.

Brace groups made only of `YYYY`, `MM`, `DD` and the separators `-`, `_` and `.` are replaced with today's local date before the pattern runs: `{YYYY-MM-DD}` becomes `2026-10-03` and `{YYYYMMDD}` becomes `20261003`. So `logs/All_{YYYY-MM-DD}*.log` matches today's `All_2026-10-03.log` and any rotations like `All_2026-10-03.1.log`. Add a day offset to move the date: `{YYYY-MM-DD-1}` is yesterday and `{YYYYMMDD+7}` is a week from now. Other braces, like `{a,b}`, work as normal glob alternatives.

In the sidebar, a glob entry lists the files it matches right now, with a count ("3 matches", or "1 of 7 matches" when `newest` limits it). The list refreshes when you refresh the view or the config changes, not when files appear on disk.

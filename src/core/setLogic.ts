import * as path from 'path';
import { FileSet, FileSetPathEntry, newFileSetId, parseFileSets, serializeFileSet } from './configFile';
import { ORIENTATION_HORIZONTAL } from './layout';

/*
 * Pure helpers for manipulating file sets. `uniqueName` and `moveItem` are also embedded verbatim
 * into the configuration editor's webview script via Function.prototype.toString, so they must stay
 * self-contained (no references to anything else in this module).
 */

/** Returns baseName if unused, else "baseName N" with the lowest free N >= 2. */
export function uniqueName(baseName: string, takenNames: string[]): string {
	const taken: Set<string> = new Set(takenNames);
	if (!taken.has(baseName)) {
		return baseName;
	}

	let n: number = 2;
	while (taken.has(baseName + ' ' + n)) {
		n++;
	}
	return baseName + ' ' + n;
}

/** Returns a copy of the array with the item at `from` moved to `to`; out-of-range moves return it unchanged. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
	const result: T[] = items.slice();
	if (from < 0 || from >= result.length || to < 0 || to >= result.length) {
		return result;
	}

	const moved: T[] = result.splice(from, 1);
	result.splice(to, 0, moved[0]);
	return result;
}

/** A copy of the set with a new id and a unique name; it never inherits "open on startup". */
export function duplicateFileSet(fileSet: FileSet, existing: FileSet[]): FileSet {
	const copy: FileSet = JSON.parse(JSON.stringify(fileSet));
	copy.id = newFileSetId();
	copy.name = uniqueName(
		fileSet.name,
		existing.map((set) => set.name)
	);
	delete copy.openOnStartup;
	delete copy.pinned;
	return copy;
}

/** JSON text for sharing one set: no id (a new one is assigned on import) and no per-user flags. */
export function exportFileSet(fileSet: FileSet): string {
	const serialized: Record<string, unknown> = serializeFileSet(fileSet);
	delete serialized.id;
	delete serialized.openOnStartup;
	delete serialized.pinned;
	return JSON.stringify(serialized, null, 2);
}

/**
 * Parses exported JSON (one set or an array of sets) into new sets with fresh ids and names that
 * don't collide with `existing` or each other. Throws a user-readable error for invalid input.
 */
export function importFileSets(text: string, existing: FileSet[]): FileSet[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error('the clipboard does not contain valid JSON.');
	}

	const parsed: FileSet[] = parseFileSets(Array.isArray(data) ? data : [data]);
	if (parsed.length === 0) {
		throw new Error('no file sets found in the JSON.');
	}

	const taken: string[] = existing.map((set) => set.name);
	return parsed.map((set) => {
		const name: string = uniqueName(set.name, taken);
		taken.push(name);
		const imported: FileSet = { ...set, id: newFileSetId(), name };
		delete imported.openOnStartup;
		delete imported.pinned;
		return imported;
	});
}

/**
 * Whether a configured path is a glob pattern (contains "*", "?" or "{") to be expanded when the set
 * opens. "[" is deliberately not a glob character, so names like "[id].tsx" stay literal.
 */
export function isGlobPattern(filePath: string): boolean {
	return /[*?{]/.test(filePath);
}

/**
 * Turns a glob entry and its (already sorted) matches into concrete entries. Without a column the
 * matches fan out into successive columns; with one they stack as rows in that column, starting at
 * the entry's row (or 0).
 */
export function expandGlobEntry(entry: FileSetPathEntry, matches: string[]): FileSetPathEntry[] {
	if (entry.column === undefined) {
		return matches.map((match) => (entry.row !== undefined ? { path: match, row: entry.row } : { path: match }));
	}

	if (matches.length === 1 && entry.row === undefined) {
		return [{ path: matches[0], column: entry.column }];
	}

	const startRow: number = entry.row ?? 0;
	return matches.map((match, i) => ({ path: match, column: entry.column, row: startRow + i }));
}

/**
 * Replaces date tokens in a path with the given (local) date. A token is a brace group made only of
 * YYYY, MM, DD and the separators "-", "_" and ".", optionally followed by a day offset:
 * "{YYYY-MM-DD}" becomes "2026-10-03", "{YYYYMMDD}" becomes "20261003", and "{YYYY-MM-DD-1}" is
 * yesterday ("{...+2}" is two days ahead). Other brace groups, like "{a,b}", are left for the glob.
 */
export function expandDateTokens(filePath: string, now: Date): string {
	const pad = (value: number): string => String(value).padStart(2, '0');
	return filePath.replace(/\{([YMD._-]+)(?:([+-])(\d+))?\}/g, (group: string, format: string, sign?: string, days?: string) => {
		const date: Date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		if (sign && days) {
			date.setDate(date.getDate() + (sign === '-' ? -1 : 1) * Number(days));
		}

		const formatted: string = format
			.replace(/YYYY/g, String(date.getFullYear()))
			.replace(/MM/g, pad(date.getMonth() + 1))
			.replace(/DD/g, pad(date.getDate()));
		return formatted === format ? group : formatted;
	});
}

/** The `count` most recently modified paths (ties broken by natural name order), in natural order. */
export function selectNewest(files: { path: string; mtime: number }[], count: number): string[] {
	return files
		.slice()
		.sort((a, b) => b.mtime - a.mtime || naturalCompare(a.path, b.path))
		.slice(0, count)
		.map((file) => file.path)
		.sort(naturalCompare);
}

/** Sets (or, for undefined, clears) the group of the sets with the given ids; returns a new array. */
export function assignGroup(sets: FileSet[], ids: string[], group: string | undefined): FileSet[] {
	return sets.map((set) => {
		if (!set.id || !ids.includes(set.id)) {
			return set;
		}
		const updated: FileSet = { ...set };
		if (group) {
			updated.group = group;
		} else {
			delete updated.group;
		}
		return updated;
	});
}

/**
 * Moves the sets into a group, placing them after the group's last existing set (or at the end if
 * the group is new). The dragged sets keep their relative order.
 */
export function moveSetsIntoGroup(sets: FileSet[], ids: string[], group: string): FileSet[] {
	const assigned: FileSet[] = assignGroup(sets, ids, group);
	const dragged: FileSet[] = assigned.filter((set) => set.id !== undefined && ids.includes(set.id));
	const remaining: FileSet[] = assigned.filter((set) => !dragged.includes(set));
	let lastInGroup: number = -1;
	remaining.forEach((set, index) => {
		if (set.group === group) {
			lastInGroup = index;
		}
	});

	remaining.splice(lastInGroup === -1 ? remaining.length : lastInGroup + 1, 0, ...dragged);
	return remaining;
}

/** Renames a group (merging into an existing one of that name); an empty new name ungroups the sets. */
export function renameGroup(sets: FileSet[], oldName: string, newName: string): FileSet[] {
	return sets.map((set) => {
		if (set.group !== oldName) {
			return set;
		}
		const updated: FileSet = { ...set };
		if (newName) {
			updated.group = newName;
		} else {
			delete updated.group;
		}
		return updated;
	});
}

/** Distinct group names in the order they first appear. */
export function groupNames(sets: FileSet[]): string[] {
	return [...new Set(sets.flatMap((set) => (set.group ? [set.group] : [])))];
}

const NATURAL_COLLATOR: Intl.Collator = new Intl.Collator('en', { numeric: true });

/** Orders strings with embedded numbers by value, so "log.2" sorts before "log.10". */
export function naturalCompare(a: string, b: string): number {
	return NATURAL_COLLATOR.compare(a, b);
}

export interface FileRef {
	setId: string;
	index: number;
}

/**
 * Moves the sets with the given ids into the target set's slot: before it when moving up, after it
 * when moving down. The dragged sets keep their relative order. Returns a new array.
 */
export function moveSets(sets: FileSet[], ids: string[], targetId: string): FileSet[] {
	const targetIndex: number = sets.findIndex((set) => set.id === targetId);
	const dragged: FileSet[] = sets.filter((set) => set.id !== undefined && ids.includes(set.id));
	if (targetIndex === -1 || dragged.length === 0 || ids.includes(targetId)) {
		return sets.slice();
	}

	const movingDown: boolean = sets.indexOf(dragged[0]) < targetIndex;
	const remaining: FileSet[] = sets.filter((set) => !dragged.includes(set));
	const at: number = remaining.findIndex((set) => set.id === targetId);
	remaining.splice(movingDown ? at + 1 : at, 0, ...dragged);
	return remaining;
}

/**
 * Moves file entries (possibly from several sets) into the target set, before `beforeIndex` or at
 * the end. Returns a deep copy of the sets; the input is not modified.
 */
export function moveFiles(sets: FileSet[], refs: FileRef[], targetSetId: string, beforeIndex?: number): FileSet[] {
	const result: FileSet[] = JSON.parse(JSON.stringify(sets));
	const target: FileSet | undefined = result.find((set) => set.id === targetSetId);
	if (!target) {
		return result;
	}

	// Collect in set order, then index order, ignoring refs that no longer point at an entry.
	const picked: { set: FileSet; index: number }[] = [];
	for (const set of result) {
		const indexes: number[] = [
			...new Set(refs.filter((ref) => ref.setId === set.id && ref.index >= 0 && ref.index < set.paths.length).map((ref) => ref.index))
		].sort((a, b) => a - b);
		indexes.forEach((index) => picked.push({ set, index }));
	}
	if (picked.length === 0) {
		return result;
	}

	const entries: FileSetPathEntry[] = picked.map((p) => p.set.paths[p.index]);
	const requestedAt: number = beforeIndex ?? target.paths.length;
	const removedBefore: number = picked.filter((p) => p.set === target && p.index < requestedAt).length;

	for (const p of [...picked].sort((a, b) => b.index - a.index)) {
		p.set.paths.splice(p.index, 1);
	}
	target.paths.splice(requestedAt - removedBefore, 0, ...entries);
	return result;
}

/** Adds paths not already in the set (before `beforeIndex` or at the end); returns how many were added. */
export function addPathsToSet(fileSet: FileSet, paths: string[], beforeIndex?: number): number {
	const existing: Set<string> = new Set(fileSet.paths.map((entry) => entry.path));
	const fresh: string[] = [...new Set(paths)].filter((p) => !existing.has(p));
	fileSet.paths.splice(beforeIndex ?? fileSet.paths.length, 0, ...fresh.map((p) => ({ path: p })));
	return fresh.length;
}

/** A path relative to the folder with forward slashes, or the original absolute path if it is outside it. */
export function toRelativePath(baseFolder: string, filePath: string): string {
	const relative: string = path.relative(baseFolder, filePath).split(path.sep).join('/');
	return relative.startsWith('..') ? filePath : relative;
}

/** Unique non-empty path strings from the sets for which `isMissing` returns true. */
export function findMissingPaths(fileSets: FileSet[], isMissing: (filePath: string) => boolean): string[] {
	const missing: Set<string> = new Set();
	for (const fileSet of fileSets) {
		for (const entry of fileSet.paths) {
			if (entry.path !== '' && !isGlobPattern(entry.path) && isMissing(entry.path)) {
				missing.add(entry.path);
			}
		}
	}
	return [...missing];
}

/** Resolves a configured path (absolute, or relative to the workspace folder) to an absolute one. */
export function resolveFilePath(baseFolder: string, filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.join(baseFolder, filePath);
}

/** Shape of the result of VS Code's `vscode.getEditorLayout` command. */
export interface EditorLayoutNode {
	size?: number;
	groups?: EditorLayoutNode[];
}

export interface EditorLayout {
	orientation: number;
	groups: EditorLayoutNode[];
}

export interface GroupPosition {
	/** 1-based editor group number, in VS Code's grid traversal order. */
	viewColumn: number;
	column: number;
	/** Only set for groups stacked vertically within their column. */
	row?: number;
}

function leafCount(node: EditorLayoutNode): number {
	return node.groups && node.groups.length > 0 ? node.groups.reduce((sum, child) => sum + leafCount(child), 0) : 1;
}

/**
 * Maps an editor grid layout to column/row positions per editor group. Top-level horizontal
 * children become columns and their sub-groups become rows. Layouts deeper or more irregular than
 * that are flattened to one column per group, since the config format can't express them.
 */
export function layoutToPositions(layout: EditorLayout): GroupPosition[] {
	const result: GroupPosition[] = [];
	let viewColumn: number = 1;

	if (layout.orientation === ORIENTATION_HORIZONTAL) {
		layout.groups.forEach((child, column) => {
			const rows: number = leafCount(child);
			for (let row = 0; row < rows; row++) {
				result.push({ viewColumn: viewColumn++, column, ...(rows > 1 ? { row } : {}) });
			}
		});
		return result;
	}

	if (layout.groups.every((child) => leafCount(child) === 1)) {
		layout.groups.forEach((_, row) => {
			result.push({ viewColumn: viewColumn++, column: 0, ...(layout.groups.length > 1 ? { row } : {}) });
		});
		return result;
	}

	const total: number = layout.groups.reduce((sum, child) => sum + leafCount(child), 0);
	for (let i = 0; i < total; i++) {
		result.push({ viewColumn: i + 1, column: i });
	}
	return result;
}

/** Builds path entries from group positions and the file open in each group (by viewColumn). */
export function positionsToEntries(positions: GroupPosition[], pathByViewColumn: Map<number, string>): FileSetPathEntry[] {
	const entries: FileSetPathEntry[] = [];
	for (const position of positions) {
		const filePath: string | undefined = pathByViewColumn.get(position.viewColumn);
		if (filePath === undefined) {
			continue;
		}

		const entry: FileSetPathEntry = { path: filePath, column: position.column };
		if (position.row !== undefined) {
			entry.row = position.row;
		}
		entries.push(entry);
	}
	return entries;
}

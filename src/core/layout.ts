import { FileSetPathEntry } from './configFile';

export interface PlacedFile {
	entry: FileSetPathEntry;
	viewColumn: number;
}

// Matches VS Code's internal GroupOrientation enum, which `vscode.setEditorLayout` expects but
// does not export a type for.
export const ORIENTATION_HORIZONTAL = 0;
export const ORIENTATION_VERTICAL = 1;

export const MAX_VIEW_COLUMNS = 9;

export interface ResolvedEntry {
	entry: FileSetPathEntry;
	index: number;
	column: number;
	row: number;
}

/**
 * Resolves each entry's effective column/row (both 0-based): explicit values are used as-is, an
 * omitted column auto-increments past the highest column used so far (starting at 0), and an
 * omitted row defaults to 0.
 */
export function resolvePositions(entries: FileSetPathEntry[]): ResolvedEntry[] {
	let highestColumn = -1;
	return entries.map((entry, index) => {
		const column = entry.column ?? highestColumn + 1;
		highestColumn = Math.max(highestColumn, column);
		return { entry, index, column, row: entry.row ?? 0 };
	});
}

export interface PositionCollision {
	column: number;
	row: number;
	indexes: number[];
	paths: string[];
}

/** Finds groups of path entries that resolve to the same (column, row) slot - an ambiguous placement. */
export function findCollisions(entries: FileSetPathEntry[]): PositionCollision[] {
	const groups = new Map<string, ResolvedEntry[]>();
	for (const resolved of resolvePositions(entries)) {
		const key = `${resolved.column}:${resolved.row}`;
		const group = groups.get(key);
		if (group) {
			group.push(resolved);
		} else {
			groups.set(key, [resolved]);
		}
	}

	const collisions: PositionCollision[] = [];
	for (const group of groups.values()) {
		if (group.length > 1) {
			collisions.push({
				column: group[0].column,
				row: group[0].row,
				indexes: group.map((g) => g.index),
				paths: group.map((g) => g.entry.path)
			});
		}
	}

	return collisions;
}

/**
 * Assigns a 1-based ViewColumn to each path entry from its optional (0-based) column/row hints.
 * Column and row are sort keys, not literal slot numbers, so gaps (e.g. columns 0 and 2 but no 1)
 * are fine.
 *
 * When every column holds at most one row, no group layout is touched: entries are placed with a
 * plain ViewColumn number, which VS Code creates on demand without disturbing other open groups.
 *
 * When some column needs more than one row (a vertical split), the whole editor grid is rebuilt
 * via `vscode.setEditorLayout` to create it, which discards any other open editor groups in the
 * window - callers should warn about that side effect before invoking it.
 */
export interface LayoutPlan {
	placements: PlacedFile[];
	rebuildsGrid: boolean;
	groups?: unknown[];
}

export function planLayout(entries: FileSetPathEntry[]): LayoutPlan {
	const resolved = resolvePositions(entries);
	const columns = [...new Set(resolved.map((r) => r.column))].sort((a, b) => a - b);
	const rebuildsGrid = columns.some(
		(column) => new Set(resolved.filter((r) => r.column === column).map((r) => r.row)).size > 1
	);

	if (!rebuildsGrid) {
		return {
			rebuildsGrid: false,
			placements: resolved.map((r) => ({ entry: r.entry, viewColumn: columns.indexOf(r.column) + 1 }))
		};
	}

	const groups: unknown[] = [];
	const placements: PlacedFile[] = [];
	let leafCount = 0;

	for (const column of columns) {
		const rowsInColumn = [...new Set(resolved.filter((r) => r.column === column).map((r) => r.row))].sort(
			(a, b) => a - b
		);
		const startLeaf = leafCount + 1;

		if (rowsInColumn.length <= 1) {
			groups.push({});
			leafCount += 1;
		} else {
			groups.push({ orientation: ORIENTATION_VERTICAL, groups: rowsInColumn.map(() => ({})) });
			leafCount += rowsInColumn.length;
		}

		for (const r of resolved.filter((entry) => entry.column === column)) {
			placements.push({ entry: r.entry, viewColumn: startLeaf + rowsInColumn.indexOf(r.row) });
		}
	}

	return { placements, rebuildsGrid: true, groups };
}

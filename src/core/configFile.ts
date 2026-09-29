import * as fs from 'fs';
import * as path from 'path';

/** Label used in error messages; the on-disk filename itself is per-workspace (see configPaths.ts). */
const CONFIG_LABEL = 'file-grid-open config';

export interface FileSetPathEntry {
	path: string;
	/** 0-based sort key for horizontal placement. Entries without one auto-increment left to right. */
	column?: number;
	/** 0-based sort key for vertical placement within a column. Omitted means the column's only row. */
	row?: number;
}

export interface FileSet {
	name: string;
	paths: FileSetPathEntry[];
}

function parsePathEntry(raw: unknown, setIndex: number, pathIndex: number): FileSetPathEntry {
	if (typeof raw === 'string') {
		return { path: raw };
	}

	if (typeof raw !== 'object' || raw === null || typeof (raw as FileSetPathEntry).path !== 'string') {
		throw new Error(
			`${CONFIG_LABEL}: entry ${setIndex}, path ${pathIndex} must be a string or an object with a "path" string.`
		);
	}

	const entry = raw as FileSetPathEntry;
	for (const key of ['column', 'row'] as const) {
		const value = entry[key];
		if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
			throw new Error(`${CONFIG_LABEL}: entry ${setIndex}, path ${pathIndex}: "${key}" must be a non-negative integer.`);
		}
	}

	const result: FileSetPathEntry = { path: entry.path };
	if (entry.column !== undefined) {
		result.column = entry.column;
	}
	if (entry.row !== undefined) {
		result.row = entry.row;
	}

	return result;
}

/** Reads and parses the config file, tolerating a missing file (returns an empty list). */
export function readFileSets(configPath: string): FileSet[] {
	if (!fs.existsSync(configPath)) {
		return [];
	}

	const contents = fs.readFileSync(configPath, 'utf8');
	const parsed: unknown = JSON.parse(contents);
	if (!Array.isArray(parsed)) {
		throw new Error(`${CONFIG_LABEL} must contain a JSON array.`);
	}

	return parsed.map((entry, setIndex) => {
		if (
			typeof entry !== 'object' ||
			entry === null ||
			typeof (entry as { name?: unknown }).name !== 'string' ||
			!Array.isArray((entry as { paths?: unknown }).paths)
		) {
			throw new Error(`${CONFIG_LABEL}: entry ${setIndex} must be an object with "name" and "paths".`);
		}

		const name = (entry as { name: string }).name;
		const paths = (entry as { paths: unknown[] }).paths.map((raw, pathIndex) => parsePathEntry(raw, setIndex, pathIndex));
		return { name, paths };
	});
}

const STARTER_CONFIG: FileSet[] = [
	{
		name: 'Example set',
		paths: [{ path: 'src/example.ts' }, { path: 'src/example.test.ts' }]
	}
];

/** Creates the config file (and its containing directory) with a starter example if missing. */
export function ensureConfigFile(configPath: string): void {
	if (fs.existsSync(configPath)) {
		return;
	}

	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(STARTER_CONFIG, null, 2) + '\n', 'utf8');
}

/** Serializes file sets back to the config file, creating its containing directory if needed. */
export function writeFileSets(configPath: string, fileSets: FileSet[]): void {
	const serializable = fileSets.map((fileSet) => ({
		name: fileSet.name,
		paths: fileSet.paths.map((entry) => {
			const out: FileSetPathEntry = { path: entry.path };
			if (entry.column !== undefined) {
				out.column = entry.column;
			}
			if (entry.row !== undefined) {
				out.row = entry.row;
			}
			return out;
		})
	}));

	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(serializable, null, 2) + '\n', 'utf8');
}

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Label used in error messages; the on-disk filename itself is per-workspace (see configPaths.ts). */
const CONFIG_LABEL = 'File Grid Open config';

export interface FileSetPathEntry {
	path: string;
	/** 0-based sort key for horizontal placement. Entries without one auto-increment left to right. */
	column?: number;
	/** 0-based sort key for vertical placement within a column. Omitted means the column's only row. */
	row?: number;
	/** For a glob path: open only this many of the most recently modified matches. */
	newest?: number;
}

export interface FileSet {
	/** Stable identifier used to target a set; names can change or (via hand edits) repeat. */
	id?: string;
	name: string;
	/** Sidebar folder this set is shown under; sets without one are listed at the top level. */
	group?: string;
	/** Close every other editor before opening this set. */
	closeOthers?: boolean;
	/** Open this set automatically when the workspace loads. */
	openOnStartup?: boolean;
	/** Show this set as its own item in the status bar. */
	pinned?: boolean;
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

	if (entry.newest !== undefined && (typeof entry.newest !== 'number' || !Number.isInteger(entry.newest) || entry.newest < 1)) {
		throw new Error(`${CONFIG_LABEL}: entry ${setIndex}, path ${pathIndex}: "newest" must be a positive integer.`);
	}

	const result: FileSetPathEntry = { path: entry.path };
	if (entry.column !== undefined) {
		result.column = entry.column;
	}
	if (entry.row !== undefined) {
		result.row = entry.row;
	}
	if (entry.newest !== undefined) {
		result.newest = entry.newest;
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

	return parseFileSets(parsed);
}

/** Validates and normalizes an already-parsed array of file sets. */
export function parseFileSets(parsed: unknown[]): FileSet[] {
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
		const result: FileSet = { name, paths };
		const rawId: unknown = (entry as { id?: unknown }).id;
		if (typeof rawId === 'string' && rawId !== '') {
			// Rebuilt so that "id" comes first, matching how sets are written back.
			return { id: rawId, ...parseFlags(entry, setIndex, result) };
		}
		return parseFlags(entry, setIndex, result);
	});
}

/** Copies the optional group and boolean flags from a raw entry onto the set, rejecting invalid values. */
function parseFlags(raw: unknown, setIndex: number, set: FileSet): FileSet {
	const result: FileSet = { ...set };
	const group: unknown = (raw as Record<string, unknown>).group;
	if (group !== undefined) {
		if (typeof group !== 'string') {
			throw new Error(`${CONFIG_LABEL}: entry ${setIndex}: "group" must be a string.`);
		}
		if (group.trim() !== '') {
			result.group = group.trim();
		}
	}

	for (const key of ['closeOthers', 'openOnStartup', 'pinned'] as const) {
		const value: unknown = (raw as Record<string, unknown>)[key];
		if (value === undefined) {
			continue;
		}
		if (typeof value !== 'boolean') {
			throw new Error(`${CONFIG_LABEL}: entry ${setIndex}: "${key}" must be true or false.`);
		}
		if (value) {
			result[key] = true;
		}
	}
	return result;
}

/** Generates a new unique file set id. */
export function newFileSetId(): string {
	return randomUUID();
}

/** Returns the sets with an id on every entry, generating ids where missing. */
export function withIds(fileSets: FileSet[]): FileSet[] {
	return fileSets.map((fileSet) => (fileSet.id ? fileSet : { ...fileSet, id: newFileSetId() }));
}

/**
 * Like readFileSets, but guarantees every set has an id. Sets missing one (e.g. a config written
 * before ids existed or edited by hand) get one generated and the file is rewritten so the ids stay stable.
 */
export function readFileSetsEnsuringIds(configPath: string): FileSet[] {
	const fileSets: FileSet[] = readFileSets(configPath);
	if (fileSets.every((fileSet) => fileSet.id)) {
		return fileSets;
	}

	const withGeneratedIds: FileSet[] = withIds(fileSets);
	writeFileSets(configPath, withGeneratedIds);
	return withGeneratedIds;
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
	const serializable = fileSets.map(serializeFileSet);

	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(serializable, null, 2) + '\n', 'utf8');
}

/** The on-disk shape of a file set: optional fields are omitted rather than written as undefined/false. */
export function serializeFileSet(fileSet: FileSet): Record<string, unknown> {
	return {
		...(fileSet.id ? { id: fileSet.id } : {}),
		name: fileSet.name,
		...(fileSet.group ? { group: fileSet.group } : {}),
		...(fileSet.closeOthers ? { closeOthers: true } : {}),
		...(fileSet.openOnStartup ? { openOnStartup: true } : {}),
		...(fileSet.pinned ? { pinned: true } : {}),
		paths: fileSet.paths.map((entry) => {
			const out: FileSetPathEntry = { path: entry.path };
			if (entry.column !== undefined) {
				out.column = entry.column;
			}
			if (entry.row !== undefined) {
				out.row = entry.row;
			}
			if (entry.newest !== undefined) {
				out.newest = entry.newest;
			}
			return out;
		})
	};
}

import * as fs from 'fs';
import * as path from 'path';
import { compileGlob, splitGlobPattern } from './globMatch';

export interface WalkOptions {
	/* Stop after this many matches (default 100). Not reported as truncation. */
	maxMatches?: number;
	/* Stop after visiting this many directory entries (default 50000); the result is then truncated. */
	maxEntries?: number;
	caseSensitive?: boolean;
}

export interface WalkResult {
	/* Absolute paths of matching files. */
	matches: string[];
	/* True when the search stopped because of the entry limit. */
	truncated: boolean;
}

const SKIPPED_DIRECTORIES: string[] = ['.git', 'node_modules'];

/*
 * Finds the files matching an absolute glob pattern by walking the file system from the pattern's
 * base directory. Symbolic links to directories are not followed, and `.git` and `node_modules` are
 * skipped unless the pattern names them as a literal segment. A pattern without glob characters
 * matches itself if it is an existing file.
 */
export function walkGlob(pattern: string, options: WalkOptions = {}): WalkResult {
	const maxMatches: number = options.maxMatches ?? 100;
	const maxEntries: number = options.maxEntries ?? 50000;
	const caseSensitive: boolean = options.caseSensitive ?? true;
	const { baseDir, remainder } = splitGlobPattern(pattern);
	const result: WalkResult = { matches: [], truncated: false };

	if (remainder === '') {
		try {
			if (fs.statSync(baseDir).isFile()) {
				result.matches.push(baseDir);
			}
		} catch {
			// A missing file simply matches nothing.
		}
		return result;
	}

	const matchesRemainder: (relativePath: string) => boolean = compileGlob(remainder, caseSensitive);
	const segments: string[] = remainder.split('/');
	const unbounded: boolean = segments.includes('**');
	let visited: number = 0;

	// Returns false once a limit has been reached, so callers unwind.
	const walk = (dir: string, relative: string, depth: number): boolean => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return true;
		}

		for (const entry of entries) {
			if (visited >= maxEntries) {
				result.truncated = true;
				return false;
			}
			visited++;

			const entryRelative: string = relative === '' ? entry.name : relative + '/' + entry.name;
			const entryPath: string = path.join(dir, entry.name);
			let isFile: boolean = entry.isFile();
			let isDirectory: boolean = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isFile = fs.statSync(entryPath).isFile();
				} catch {
					isFile = false;
				}
				isDirectory = false;
			}

			if (isFile && matchesRemainder(entryRelative)) {
				result.matches.push(entryPath);
				if (result.matches.length >= maxMatches) {
					return false;
				}
			} else if (isDirectory && (unbounded || depth < segments.length)) {
				if (SKIPPED_DIRECTORIES.includes(entry.name) && !segments.includes(entry.name)) {
					continue;
				}
				if (!walk(entryPath, entryRelative, depth + 1)) {
					return false;
				}
			}
		}
		return true;
	};

	walk(baseDir, '', 1);
	return result;
}

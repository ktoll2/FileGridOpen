import * as fs from 'fs';
import * as os from 'os';
import { FileSetPathEntry } from './config';
import { walkGlob, WalkResult } from './core/globWalk';
import { expandDateTokens, naturalCompare, resolveFilePath, selectNewest } from './core/setLogic';

export interface GlobResult {
	/* The pattern after date tokens were filled in. */
	pattern: string;
	/* Absolute matches in natural order, after any "newest" limit. */
	matches: string[];
	/* How many files matched before the "newest" limit. */
	total: number;
	/* True when the search was cut short by the directory entry limit. */
	truncated: boolean;
}

/* Resolves a glob entry to its current matching files: date tokens filled in, newest-N applied. */
export function findGlobMatches(entry: FileSetPathEntry): GlobResult {
	const pattern: string = expandDateTokens(entry.path, new Date());
	const found: WalkResult = walkGlob(resolveFilePath(os.homedir(), pattern), { caseSensitive: process.platform !== 'win32' });
	if (entry.newest === undefined || found.matches.length <= entry.newest) {
		return { pattern, matches: found.matches.sort(naturalCompare), total: found.matches.length, truncated: found.truncated };
	}

	const withTimes: { path: string; mtime: number }[] = found.matches.map((match) => {
		let mtime: number = 0;
		try {
			mtime = fs.statSync(match).mtimeMs;
		} catch {
			// A file that vanished between the search and the stat just counts as oldest.
		}
		return { path: match, mtime };
	});
	return { pattern, matches: selectNewest(withTimes, entry.newest), total: found.matches.length, truncated: found.truncated };
}

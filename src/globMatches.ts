import * as path from 'path';
import * as vscode from 'vscode';
import { FileSetPathEntry } from './config';
import { expandDateTokens, naturalCompare, selectNewest, toRelativePath } from './core/setLogic';

export interface GlobResult {
	/** The pattern after date tokens were filled in. */
	pattern: string;
	/** Workspace-relative matches in natural order, after any "newest" limit. */
	matches: string[];
	/** How many files matched before the "newest" limit. */
	total: number;
}

const MAX_MATCHES = 100;

/** Resolves a glob entry to its current matching files: date tokens filled in, newest-N applied. */
export async function findGlobMatches(folder: vscode.WorkspaceFolder, entry: FileSetPathEntry): Promise<GlobResult> {
	const pattern: string = expandDateTokens(entry.path, new Date());
	if (path.isAbsolute(pattern)) {
		return { pattern, matches: [], total: 0 };
	}

	const found: vscode.Uri[] = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, MAX_MATCHES);
	const relative: string[] = found.map((uri) => toRelativePath(folder.uri.fsPath, uri.fsPath));
	if (entry.newest === undefined || relative.length <= entry.newest) {
		return { pattern, matches: relative.sort(naturalCompare), total: relative.length };
	}

	const withTimes: { path: string; mtime: number }[] = await Promise.all(
		found.map(async (uri) => {
			let mtime: number = 0;
			try {
				mtime = (await vscode.workspace.fs.stat(uri)).mtime;
			} catch {
				// A file that vanished between the search and the stat just counts as oldest.
			}
			return { path: toRelativePath(folder.uri.fsPath, uri.fsPath), mtime };
		})
	);
	return { pattern, matches: selectNewest(withTimes, entry.newest), total: relative.length };
}

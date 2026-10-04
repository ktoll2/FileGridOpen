import * as fs from 'fs';
import * as vscode from 'vscode';
import { FileSet, FileSetPathEntry, getConfigPath, getPrimaryWorkspaceFolder, readFileSetsEnsuringIds } from './config';
import { isGlobPattern, resolveFilePath } from './core/setLogic';
import { GlobResult, findGlobMatches } from './globMatches';

function isMissing(folder: vscode.WorkspaceFolder, filePath: string): boolean {
	return filePath !== '' && !isGlobPattern(filePath) && !fs.existsSync(resolveFilePath(folder.uri.fsPath, filePath));
}

function describePosition(entry: FileSetPathEntry): string {
	return [
		entry.column !== undefined ? `col ${entry.column}` : undefined,
		entry.row !== undefined ? `row ${entry.row}` : undefined
	]
		.filter((part): part is string => part !== undefined)
		.join(', ');
}

/** A sidebar folder holding the sets that share a `group`. */
export class GroupItem extends vscode.TreeItem {
	constructor(
		public readonly groupName: string,
		public readonly sets: FileSet[]
	) {
		super(groupName, vscode.TreeItemCollapsibleState.Expanded);
		this.id = `group:${groupName}`;
		this.description = `${sets.length} set${sets.length === 1 ? '' : 's'}`;
		this.iconPath = new vscode.ThemeIcon('folder');
		this.contextValue = 'fileGridOpenGroup';
	}
}

export class FileSetItem extends vscode.TreeItem {
	constructor(
		public readonly fileSet: FileSet,
		missingCount: number
	) {
		super(
			fileSet.name,
			fileSet.paths.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
		);
		this.id = fileSet.id;
		const fileCount: string = `${fileSet.paths.length} file${fileSet.paths.length === 1 ? '' : 's'}`;
		this.description = missingCount > 0 ? `${fileCount}, ${missingCount} missing` : fileCount;
		this.tooltip = fileSet.paths
			.map((entry) => {
				const position: string = describePosition(entry);
				return position ? `${entry.path} (${position})` : entry.path;
			})
			.join('\n');
		this.iconPath = new vscode.ThemeIcon(missingCount > 0 ? 'warning' : 'files');
		this.contextValue = fileSet.pinned ? 'fileGridOpenSetPinned' : 'fileGridOpenSet';
		this.command = {
			command: 'fileGridOpen.openSetById',
			title: 'Open File Set',
			arguments: [fileSet.id]
		};
	}
}

/** A file listed under its set; a glob entry also lists the files it currently matches. */
export class FilePathItem extends vscode.TreeItem {
	/** Workspace-relative files a glob entry currently matches (empty for plain entries). */
	readonly matches: string[];

	constructor(
		public readonly setId: string | undefined,
		public readonly pathIndex: number,
		public readonly entry: FileSetPathEntry,
		folder: vscode.WorkspaceFolder,
		glob?: GlobResult
	) {
		super(
			entry.path || '(empty path)',
			glob && glob.matches.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
		);
		this.id = `${setId}:${pathIndex}:${entry.path}`;
		this.matches = glob?.matches ?? [];

		const isPattern: boolean = isGlobPattern(entry.path);
		const missing: boolean = isMissing(folder, entry.path);
		const noMatches: boolean = isPattern && this.matches.length === 0;
		const note: string | undefined = missing
			? 'missing'
			: noMatches
				? 'no matches'
				: glob
					? glob.total > glob.matches.length
						? `${glob.matches.length} of ${glob.total} matches`
						: `${glob.matches.length} match${glob.matches.length === 1 ? '' : 'es'}`
					: undefined;
		this.description = [describePosition(entry), note].filter((part): part is string => !!part).join(' - ');
		this.tooltip = missing
			? `${entry.path} - file not found`
			: glob && glob.pattern !== entry.path
				? `${entry.path}\ntoday: ${glob.pattern}`
				: entry.path;
		this.iconPath = new vscode.ThemeIcon(missing || noMatches ? 'warning' : isPattern ? 'search' : 'file');
		this.contextValue = isPattern ? 'fileGridOpenFileGlob' : 'fileGridOpenFile';
		if (!missing && !isPattern && entry.path !== '') {
			this.command = {
				command: 'vscode.open',
				title: 'Open File',
				arguments: [vscode.Uri.file(resolveFilePath(folder.uri.fsPath, entry.path))]
			};
		}
	}
}

/** A file matched by a glob entry. */
export class FileMatchItem extends vscode.TreeItem {
	constructor(filePath: string, parent: FilePathItem, folder: vscode.WorkspaceFolder) {
		super(filePath, vscode.TreeItemCollapsibleState.None);
		this.id = `${parent.id}>${filePath}`;
		this.iconPath = new vscode.ThemeIcon('file');
		this.contextValue = 'fileGridOpenMatch';
		this.command = {
			command: 'vscode.open',
			title: 'Open File',
			arguments: [vscode.Uri.file(resolveFilePath(folder.uri.fsPath, filePath))]
		};
	}
}

export type FileSetTreeNode = GroupItem | FileSetItem | FilePathItem | FileMatchItem;

export class FileSetsProvider implements vscode.TreeDataProvider<FileSetTreeNode> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	getTreeItem(element: FileSetTreeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: FileSetTreeNode): Promise<FileSetTreeNode[]> {
		const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
		if (!folder) {
			return [];
		}

		if (element instanceof FileMatchItem) {
			return [];
		}

		if (element instanceof FilePathItem) {
			return element.matches.map((match) => new FileMatchItem(match, element, folder));
		}

		if (element instanceof FileSetItem) {
			return Promise.all(
				element.fileSet.paths.map(async (entry, index) => {
					const glob: GlobResult | undefined = isGlobPattern(entry.path) ? await findGlobMatches(folder, entry) : undefined;
					return new FilePathItem(element.fileSet.id, index, entry, folder, glob);
				})
			);
		}

		if (element instanceof GroupItem) {
			return element.sets.map((fileSet) => this.createSetItem(folder, fileSet));
		}

		try {
			return this.rootNodes(folder, readFileSetsEnsuringIds(getConfigPath(folder)));
		} catch (error) {
			vscode.window.showErrorMessage(`File Grid Open: ${(error as Error).message}`);
			return [];
		}
	}

	/** Top level: ungrouped sets in file order, with each group appearing where its first set is. */
	private rootNodes(folder: vscode.WorkspaceFolder, fileSets: FileSet[]): FileSetTreeNode[] {
		const nodes: FileSetTreeNode[] = [];
		const seenGroups: Set<string> = new Set();
		for (const fileSet of fileSets) {
			if (!fileSet.group) {
				nodes.push(this.createSetItem(folder, fileSet));
			} else if (!seenGroups.has(fileSet.group)) {
				seenGroups.add(fileSet.group);
				nodes.push(
					new GroupItem(
						fileSet.group,
						fileSets.filter((set) => set.group === fileSet.group)
					)
				);
			}
		}
		return nodes;
	}

	private createSetItem(folder: vscode.WorkspaceFolder, fileSet: FileSet): FileSetItem {
		return new FileSetItem(
			fileSet,
			fileSet.paths.filter((entry) => isMissing(folder, entry.path)).length
		);
	}
}

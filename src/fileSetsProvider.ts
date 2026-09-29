import * as vscode from 'vscode';
import { FileSet, getConfigPath, getPrimaryWorkspaceFolder, readFileSets } from './config';

export class FileSetItem extends vscode.TreeItem {
	constructor(public readonly fileSet: FileSet) {
		super(fileSet.name, vscode.TreeItemCollapsibleState.None);
		this.description = `${fileSet.paths.length} file${fileSet.paths.length === 1 ? '' : 's'}`;
		this.tooltip = fileSet.paths
			.map((entry) => {
				const position = [
					entry.column !== undefined ? `col ${entry.column}` : undefined,
					entry.row !== undefined ? `row ${entry.row}` : undefined
				]
					.filter((part): part is string => part !== undefined)
					.join(', ');
				return position ? `${entry.path} (${position})` : entry.path;
			})
			.join('\n');
		this.iconPath = new vscode.ThemeIcon('files');
		this.contextValue = 'fileGridOpenSet';
		this.command = {
			command: 'fileGridOpen.openSetByName',
			title: 'Open File Set',
			arguments: [fileSet.name]
		};
	}
}

export class FileSetsProvider implements vscode.TreeDataProvider<FileSetItem> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	getTreeItem(element: FileSetItem): vscode.TreeItem {
		return element;
	}

	getChildren(): FileSetItem[] {
		const folder = getPrimaryWorkspaceFolder();
		if (!folder) {
			return [];
		}

		try {
			return readFileSets(getConfigPath(folder)).map((fileSet) => new FileSetItem(fileSet));
		} catch (error) {
			vscode.window.showErrorMessage(`FileGridOpen: ${(error as Error).message}`);
			return [];
		}
	}
}

import * as fs from 'fs';
import * as vscode from 'vscode';
import { FileSet, getConfigPath, getPrimaryWorkspaceFolder, readFileSetsEnsuringIds, writeFileSets } from './config';
import { FileRef, addPathsToSet, assignGroup, moveFiles, moveSets, moveSetsIntoGroup, toRelativePath } from './core/setLogic';
import { FilePathItem, FileSetItem, FileSetTreeNode, GroupItem } from './fileSetsProvider';

/** Tree drag mime types must be "application/vnd.code.tree." plus the lowercased view id. */
export const SETS_MIME = 'application/vnd.code.tree.filegridopensets';
const URI_LIST_MIME = 'text/uri-list';

type DragPayload = { kind: 'sets'; ids: string[] } | { kind: 'files'; refs: FileRef[] };

/**
 * Drag and drop for the File Sets view: reorder sets, move files within or between sets, and add
 * files dragged in from the Explorer.
 */
export class FileSetsDragAndDrop implements vscode.TreeDragAndDropController<FileSetTreeNode> {
	readonly dragMimeTypes: readonly string[] = [SETS_MIME];
	readonly dropMimeTypes: readonly string[] = [SETS_MIME, URI_LIST_MIME];

	constructor(private readonly onChange: () => void) {}

	handleDrag(source: readonly FileSetTreeNode[], dataTransfer: vscode.DataTransfer): void {
		let payload: DragPayload | undefined;
		if (source.every((node): node is FileSetItem => node instanceof FileSetItem)) {
			const ids: string[] = source.flatMap((node) => (node.fileSet.id ? [node.fileSet.id] : []));
			payload = { kind: 'sets', ids };
		} else if (source.every((node): node is FilePathItem => node instanceof FilePathItem)) {
			const refs: FileRef[] = source.flatMap((node) => (node.setId ? [{ setId: node.setId, index: node.pathIndex }] : []));
			payload = { kind: 'files', refs };
		}

		if (payload) {
			dataTransfer.set(SETS_MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
		}
	}

	async handleDrop(target: FileSetTreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
		if (!target || !folder) {
			return;
		}

		// Files can only be dropped on sets and on the files within them.
		const targetSetId: string | undefined =
			target instanceof FileSetItem ? target.fileSet.id : target instanceof FilePathItem ? target.setId : undefined;
		const targetGroup: string | undefined = target instanceof GroupItem ? target.groupName : undefined;
		const beforeIndex: number | undefined = target instanceof FilePathItem ? target.pathIndex : undefined;
		if (!targetSetId && !targetGroup) {
			return;
		}

		const configPath: string = getConfigPath(folder);
		let fileSets: FileSet[];
		try {
			fileSets = readFileSetsEnsuringIds(configPath);
		} catch (error) {
			vscode.window.showErrorMessage(`File Grid Open: ${(error as Error).message}`);
			return;
		}

		const own: vscode.DataTransferItem | undefined = dataTransfer.get(SETS_MIME);
		if (targetGroup !== undefined) {
			// Dropping sets on a group folder moves them into it; anything else is ignored.
			const payload: DragPayload | undefined = own ? JSON.parse(await own.asString()) : undefined;
			if (payload?.kind !== 'sets') {
				return;
			}
			fileSets = moveSetsIntoGroup(fileSets, payload.ids, targetGroup);
		} else if (!targetSetId) {
			return;
		} else if (own) {
			const payload: DragPayload = JSON.parse(await own.asString());
			if (payload.kind === 'sets') {
				// Dropping on another set reorders, and the moved sets join that set's group.
				const targetGroupOfSet: string | undefined = fileSets.find((set) => set.id === targetSetId)?.group;
				fileSets = assignGroup(moveSets(fileSets, payload.ids, targetSetId), payload.ids, targetGroupOfSet);
			} else {
				fileSets = moveFiles(fileSets, payload.refs, targetSetId, beforeIndex);
			}
		} else {
			const uriList: vscode.DataTransferItem | undefined = dataTransfer.get(URI_LIST_MIME);
			const targetSet: FileSet | undefined = fileSets.find((set) => set.id === targetSetId);
			if (!uriList || !targetSet) {
				return;
			}

			const paths: string[] = (await uriList.asString())
				.split(/\r?\n/)
				.filter((line) => line.trim() !== '' && !line.startsWith('#'))
				.map((line) => vscode.Uri.parse(line.trim()))
				.filter((uri) => uri.scheme === 'file' && isFile(uri.fsPath))
				.map((uri) => toRelativePath(folder.uri.fsPath, uri.fsPath));
			const added: number = addPathsToSet(targetSet, paths, beforeIndex);
			if (added === 0) {
				vscode.window.showInformationMessage('File Grid Open: no new files to add (folders and files already in the set are skipped).');
				return;
			}
			vscode.window.showInformationMessage(`File Grid Open: added ${added} file${added === 1 ? '' : 's'} to "${targetSet.name}".`);
		}

		try {
			writeFileSets(configPath, fileSets);
		} catch (error) {
			vscode.window.showErrorMessage(`File Grid Open: could not save: ${(error as Error).message}`);
			return;
		}
		this.onChange();
	}
}

function isFile(fsPath: string): boolean {
	try {
		return fs.statSync(fsPath).isFile();
	} catch {
		return false;
	}
}

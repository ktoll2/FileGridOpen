import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	FileSet,
	FileSetPathEntry,
	ensureConfigFile,
	getConfigPath,
	newFileSetId,
	readFileSetsEnsuringIds,
	writeFileSets
} from './config';
import { openConfigEditor, reloadConfigEditor } from './configEditor';
import {
	EditorLayout,
	assignGroup,
	duplicateFileSet,
	excludeExistingPaths,
	exportFileSet,
	expandGlobEntry,
	groupNames,
	importFileSets,
	isGlobPattern,
	layoutToPositions,
	moveSetsIntoGroup,
	positionsToEntries,
	renameGroup,
	resolveFilePath,
	uniqueName
} from './core/setLogic';
import { GlobResult, findGlobMatches } from './globMatches';
import { FileSetsDragAndDrop } from './fileSetsDnd';
import { FilePathItem, FileSetItem, FileSetsProvider, GroupItem } from './fileSetsProvider';
import { MAX_VIEW_COLUMNS, applyGridLayout, planLayout } from './layout';

const LAST_SET_KEY = 'lastSetId';

let extensionContext: vscode.ExtensionContext;
let lastSetStatusItem: vscode.StatusBarItem;
/* One status bar item per pinned set, keyed by set id. */
const pinnedStatusItems: Map<string, vscode.StatusBarItem> = new Map();

export function activate(context: vscode.ExtensionContext): void {
	extensionContext = context;
	const provider = new FileSetsProvider();
	context.subscriptions.push(
		vscode.window.createTreeView('fileGridOpenSets', {
			treeDataProvider: provider,
			dragAndDropController: new FileSetsDragAndDrop(() => refreshViews()),
			canSelectMany: true
		}),
		new vscode.Disposable(() => pinnedStatusItems.forEach((item) => item.dispose()))
	);

	lastSetStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	lastSetStatusItem.command = 'fileGridOpen.openLastSet';
	context.subscriptions.push(lastSetStatusItem);

	/* Refreshes everything that displays the config: the File Sets view, the editor panel and the status bar. */
	function refreshViews(): void {
		provider.refresh();
		reloadConfigEditor();
		updateStatusItems();
	}

	let configWatcher: vscode.FileSystemWatcher | undefined;
	function rebuildConfigWatcher(): void {
		configWatcher?.dispose();
		configWatcher = undefined;

		const configPath: string = getConfigPath();
		try {
			// Watching a directory that does not exist yet is unreliable, so create it up front.
			fs.mkdirSync(path.dirname(configPath), { recursive: true });
		} catch {
			// The watcher is best effort; reading and writing report their own errors.
		}
		configWatcher = vscode.workspace.createFileSystemWatcher(
			// A RelativePattern is needed to watch a config file outside any workspace folder.
			new vscode.RelativePattern(vscode.Uri.file(path.dirname(configPath)), path.basename(configPath))
		);
		configWatcher.onDidChange(() => refreshViews());
		configWatcher.onDidCreate(() => refreshViews());
		configWatcher.onDidDelete(() => refreshViews());
	}

	rebuildConfigWatcher();

	context.subscriptions.push(
		new vscode.Disposable(() => configWatcher?.dispose()),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('fileGridOpen.configPath')) {
				rebuildConfigWatcher();
				refreshViews();
			}
		}),
		vscode.commands.registerCommand('fileGridOpen.openSet', () => openSet(undefined)),
		vscode.commands.registerCommand('fileGridOpen.openSetById', (id: string) => openSet(id)),
		vscode.commands.registerCommand('fileGridOpen.editConfig', () => editConfig()),
		vscode.commands.registerCommand('fileGridOpen.editConfigJson', editConfigJson),
		vscode.commands.registerCommand('fileGridOpen.refresh', () => refreshViews()),
		vscode.commands.registerCommand('fileGridOpen.openLastSet', openLastSet),
		vscode.commands.registerCommand('fileGridOpen.saveLayoutAsSet', async () => {
			await saveLayoutAsSet();
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.pinSet', async (item: FileSetItem) => {
			await setPinned(item.fileSet.id, true);
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.unpinSet', async (item: FileSetItem) => {
			await setPinned(item.fileSet.id, false);
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.updateSetFromLayout', async (item: FileSetItem) => {
			await updateSetFromLayout(item.fileSet.id);
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.openFileAt', (item: FilePathItem) => openFileAt(item)),
		vscode.commands.registerCommand('fileGridOpen.moveToGroup', async (item: FileSetItem) => {
			await moveToGroup(item.fileSet.id);
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.renameGroup', async (item: GroupItem) => {
			await renameGroupCommand(item.groupName);
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.ungroup', async (item: GroupItem) => {
			await changeGroup(item.groupName, '');
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.importSet', async () => {
			await importSet();
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.duplicateSet', async (item: FileSetItem) => {
			await duplicateSet(item.fileSet.id);
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.copySetAsJson', async (item: FileSetItem) => {
			await vscode.env.clipboard.writeText(exportFileSet(item.fileSet));
			vscode.window.showInformationMessage(`File Grid Open: copied "${item.fileSet.name}" to the clipboard as JSON.`);
		}),
		vscode.commands.registerCommand('fileGridOpen.removeFileFromSet', async (item: FilePathItem) => {
			await removeFileFromSet(item);
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.openSetItem', (item: FileSetItem) => openSet(item.fileSet.id)),
		vscode.commands.registerCommand('fileGridOpen.editSet', (item: FileSetItem) => editConfig(item.fileSet.id)),
		vscode.commands.registerCommand('fileGridOpen.renameSet', async (item: FileSetItem) => {
			await renameSet(item.fileSet.id);
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.deleteSet', async (item: FileSetItem) => {
			await deleteSet(item.fileSet.id);
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.addToSet', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
			// Run from a keybinding there is no argument, so fall back to the active file.
			const target: vscode.Uri | undefined = uri ?? getActiveFileUri();
			if (!target) {
				vscode.window.showInformationMessage('File Grid Open: no file to add.');
				return;
			}
			await addFilesToSet(target, uris);
			refreshViews();
		}),
		vscode.commands.registerCommand('fileGridOpen.addActiveFileToSet', async () => {
			const activeUri: vscode.Uri | undefined = getActiveFileUri();
			if (!activeUri) {
				vscode.window.showInformationMessage('File Grid Open: no file to add.');
				return;
			}
			await addFilesToSet(activeUri, undefined);
			refreshViews();
		})
	);

	updateStatusItems();
	openStartupSet().catch((error: unknown) => {
		vscode.window.showErrorMessage(`File Grid Open: could not open the startup set: ${(error as Error).message}`);
	});
}

export function deactivate(): void {
	// no-op
}

async function editConfig(focusSetId?: string): Promise<void> {
	openConfigEditor(getConfigPath, editConfigJson, focusSetId);
}

async function editConfigJson(): Promise<void> {
	const configPath: string = getConfigPath();
	try {
		ensureConfigFile(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not create ${configPath}: ${(error as Error).message}`);
		return;
	}

	try {
		const document: vscode.TextDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
		await vscode.window.showTextDocument(document, { preview: false });
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not open ${configPath}: ${(error as Error).message}`);
	}
}

/*
 * The file in the active tab, which (unlike activeTextEditor) is still known when focus is in a
 * webview or non-text editor; falls back to activeTextEditor. Only local files qualify.
 */
function getActiveFileUri(): vscode.Uri | undefined {
	const input: unknown = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input instanceof vscode.TabInputText && input.uri.scheme === 'file') {
		return input.uri;
	}
	const editorUri: vscode.Uri | undefined = vscode.window.activeTextEditor?.document.uri;
	return editorUri && editorUri.scheme === 'file' ? editorUri : undefined;
}

async function loadFileSets(): Promise<FileSet[] | undefined> {
	try {
		return readFileSetsEnsuringIds(getConfigPath());
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: ${(error as Error).message}`);
		return undefined;
	}
}

/*
 * Re-reads the config after a prompt (the file is shared with other windows and the editor) and finds
 * the set by id in the fresh list. Warns and returns undefined if the set is gone or the file is unreadable.
 */
async function reloadTargetSet(id: string | undefined): Promise<{ fileSets: FileSet[]; target: FileSet } | undefined> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	if (!fileSets) {
		return undefined;
	}
	const target: FileSet | undefined = fileSets.find((set) => set.id === id);
	if (!target) {
		vscode.window.showWarningMessage('File Grid Open: that file set no longer exists.');
		return undefined;
	}
	return { fileSets, target };
}

async function openSet(id: string | undefined): Promise<void> {
	const fileSets = await loadFileSets();
	if (!fileSets) {
		return;
	}

	if (fileSets.length === 0) {
		const editConfigChoice = 'Edit Configuration';
		const choice = await vscode.window.showInformationMessage(
			`File Grid Open: No file sets are configured. Add entries to ${getConfigPath()}.`,
			editConfigChoice
		);
		if (choice === editConfigChoice) {
			await editConfig();
		}
		return;
	}

	let selected: FileSet | undefined;
	if (id !== undefined) {
		selected = fileSets.find((fileSet) => fileSet.id === id);
	} else if (fileSets.length === 1) {
		selected = fileSets[0];
	} else {
		const picked: (vscode.QuickPickItem & { fileSet: FileSet }) | undefined = await vscode.window.showQuickPick(
			fileSets.map((fileSet) => ({ label: fileSet.name, fileSet })),
			{ placeHolder: 'Select a file set to open' }
		);
		selected = picked?.fileSet;
	}

	if (!selected) {
		return;
	}

	await openFiles(selected);
}

async function openFiles(fileSet: FileSet): Promise<void> {
	if (fileSet.paths.length === 0) {
		vscode.window.showWarningMessage(`File set "${fileSet.name}" has no files configured.`);
		return;
	}

	const entries: FileSetPathEntry[] = expandGlobs(fileSet.paths);
	if (entries.length === 0) {
		return;
	}

	if (fileSet.closeOthers) {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
	}

	const plan = planLayout(entries);
	const overflow = plan.placements.filter((p) => p.viewColumn > MAX_VIEW_COLUMNS);
	if (overflow.length > 0) {
		vscode.window.showWarningMessage(
			`File Grid Open: "${fileSet.name}" needs more than ${MAX_VIEW_COLUMNS} editor groups; ` +
				`skipping ${overflow.map((p) => p.entry.path).join(', ')}.`
		);
	}

	if (plan.rebuildsGrid && plan.groups) {
		vscode.window.showInformationMessage(`File Grid Open: rebuilding the editor grid for "${fileSet.name}".`);
		await applyGridLayout(plan.groups);
	}

	const missing: string[] = [];

	for (const placement of plan.placements) {
		if (placement.viewColumn > MAX_VIEW_COLUMNS) {
			continue;
		}

		try {
			await vscode.window.showTextDocument(resolveConfiguredUri(placement.entry.path), {
				viewColumn: placement.viewColumn as vscode.ViewColumn,
				preview: false,
				preserveFocus: false
			});
		} catch {
			missing.push(placement.entry.path);
		}
	}

	if (missing.length > 0) {
		vscode.window.showWarningMessage(`Could not open: ${missing.join(', ')}`);
	}

	await extensionContext.globalState.update(LAST_SET_KEY, fileSet.id);
	updateStatusItems();
}

/* Reads the file sets without surfacing errors; for background uses like the status bar. */
function readFileSetsQuietly(): FileSet[] {
	try {
		return readFileSetsEnsuringIds(getConfigPath());
	} catch {
		return [];
	}
}

/*
 * Updates the status bar: one item per pinned set, plus one for the most recently opened set (unless
 * that set is pinned and already has its own item).
 */
function updateStatusItems(): void {
	const sets: FileSet[] = readFileSetsQuietly();

	const pinned: FileSet[] = sets.filter((set) => set.pinned && set.id);
	for (const [id, item] of pinnedStatusItems) {
		if (!pinned.some((set) => set.id === id)) {
			item.dispose();
			pinnedStatusItems.delete(id);
		}
	}
	pinned.forEach((set, index) => {
		const id: string = set.id as string;
		let item: vscode.StatusBarItem | undefined = pinnedStatusItems.get(id);
		if (!item) {
			item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100 - index);
			pinnedStatusItems.set(id, item);
		}
		item.text = `$(pin) ${set.name}`;
		item.tooltip = `File Grid Open: open "${set.name}"`;
		item.command = { command: 'fileGridOpen.openSetById', title: 'Open File Set', arguments: [id] };
		item.show();
	});

	const lastId: string | undefined = extensionContext.globalState.get<string>(LAST_SET_KEY);
	const lastSet: FileSet | undefined = sets.find((set) => set.id === lastId);
	if (!lastSet || lastSet.pinned) {
		lastSetStatusItem.hide();
		return;
	}

	lastSetStatusItem.text = `$(files) ${lastSet.name}`;
	lastSetStatusItem.tooltip = `File Grid Open: reopen "${lastSet.name}"`;
	lastSetStatusItem.show();
}

/* Reopens the last opened set, or prompts for one if there is none (or it no longer exists). */
async function openLastSet(): Promise<void> {
	const lastId: string | undefined = extensionContext.globalState.get<string>(LAST_SET_KEY);
	const exists: boolean = readFileSetsQuietly().some((set) => set.id === lastId);
	await openSet(exists ? lastId : undefined);
}

/** Opens the first set marked "open on startup", if any. */
async function openStartupSet(): Promise<void> {
	const startupSet: FileSet | undefined = readFileSetsQuietly().find((set) => set.openOnStartup);
	if (startupSet) {
		await openFiles(startupSet);
	}
}

const CREATE_NEW_SET = '$(add) Create New Set...';

/* Renames a file set after prompting for a name; a name another set already uses gets a number appended. */
async function renameSet(id: string | undefined): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === id);
	if (!fileSets || !target) {
		return;
	}

	const oldName: string = target.name;
	const newName: string | undefined = await vscode.window.showInputBox({
		prompt: `Rename file set "${oldName}"`,
		value: oldName,
		validateInput: (value) => (value.trim() ? undefined : 'Name cannot be empty.')
	});
	if (!newName) {
		return;
	}

	const fresh: { fileSets: FileSet[]; target: FileSet } | undefined = await reloadTargetSet(id);
	if (!fresh) {
		return;
	}

	const finalName: string = uniqueName(
		newName.trim(),
		fresh.fileSets.filter((set) => set !== fresh.target).map((set) => set.name)
	);
	if (finalName === fresh.target.name) {
		return;
	}

	fresh.target.name = finalName;
	saveFileSets(fresh.fileSets);
}

/* Deletes a file set after a modal confirmation. */
async function deleteSet(id: string | undefined): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === id);
	if (!fileSets || !target) {
		return;
	}

	const confirm: string | undefined = await vscode.window.showWarningMessage(
		`Delete file set "${target.name}"?`,
		{ modal: true },
		'Delete'
	);
	if (confirm !== 'Delete') {
		return;
	}

	const fresh: { fileSets: FileSet[]; target: FileSet } | undefined = await reloadTargetSet(id);
	if (!fresh) {
		return;
	}

	saveFileSets(fresh.fileSets.filter((set) => set.id !== id));
}

function saveFileSets(fileSets: FileSet[]): void {
	try {
		writeFileSets(getConfigPath(), fileSets);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not save: ${(error as Error).message}`);
	}
}

/* Adds one or more Explorer-selected files to an existing or new file set. */
async function addFilesToSet(uri: vscode.Uri, selected: vscode.Uri[] | undefined): Promise<void> {
	const allUris: vscode.Uri[] = Array.isArray(selected) && selected.length > 0 ? selected : [uri];
	// The menu only hides the command for a clicked folder, so drop folders from a multi-selection here.
	const uris: vscode.Uri[] = allUris.filter((fileUri) => !isDirectory(fileUri.fsPath));
	const folderCount: number = allUris.length - uris.length;
	if (uris.length === 0) {
		vscode.window.showInformationMessage('File Grid Open: folders cannot be added to a file set.');
		return;
	}

	const configPath: string = getConfigPath();
	let fileSets: FileSet[];
	try {
		fileSets = readFileSetsEnsuringIds(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: ${(error as Error).message}`);
		return;
	}

	const items: (vscode.QuickPickItem & { fileSet?: FileSet })[] = [
		{ label: CREATE_NEW_SET },
		...fileSets.map((fileSet) => ({ label: fileSet.name, fileSet }))
	];
	const picked: (vscode.QuickPickItem & { fileSet?: FileSet }) | undefined = await vscode.window.showQuickPick(items, {
		placeHolder: `Add ${uris.length} file${uris.length === 1 ? '' : 's'} to which set?`
	});
	if (!picked) {
		return;
	}

	let newSetName: string | undefined;
	if (!picked.fileSet) {
		newSetName = await vscode.window.showInputBox({
			prompt: 'New file set name',
			validateInput: (value) => (value.trim() ? undefined : 'Name cannot be empty.')
		});
		if (!newSetName) {
			return;
		}
	}

	// Re-read now that the prompts are answered, so changes made elsewhere meanwhile are kept.
	try {
		fileSets = readFileSetsEnsuringIds(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: ${(error as Error).message}`);
		return;
	}

	let targetSet: FileSet | undefined;
	if (newSetName !== undefined) {
		targetSet = {
			id: newFileSetId(),
			name: uniqueName(
				newSetName.trim(),
				fileSets.map((set) => set.name)
			),
			paths: []
		};
		fileSets = [...fileSets, targetSet];
	} else {
		const pickedId: string | undefined = picked.fileSet?.id;
		targetSet = fileSets.find((set) => set.id === pickedId);
		if (!targetSet) {
			vscode.window.showWarningMessage('File Grid Open: that file set no longer exists.');
			return;
		}
	}

	const newPaths: string[] = excludeExistingPaths(
		targetSet,
		[...new Set(uris.map((fileUri) => fileUri.fsPath))],
		os.homedir(),
		process.platform === 'win32'
	);
	for (const filePath of newPaths) {
		targetSet.paths.push({ path: filePath });
	}

	try {
		writeFileSets(configPath, fileSets);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not save: ${(error as Error).message}`);
		return;
	}

	const addedCount: number = newPaths.length;
	const alreadyPresentCount: number = uris.length - addedCount;
	const notes: string[] = [];
	if (alreadyPresentCount > 0) {
		notes.push(`${alreadyPresentCount} already present`);
	}
	if (folderCount > 0) {
		notes.push(`${folderCount} folder${folderCount === 1 ? '' : 's'} skipped`);
	}
	vscode.window.showInformationMessage(
		`File Grid Open: added ${addedCount} file${addedCount === 1 ? '' : 's'} to "${targetSet.name}"` +
			(notes.length > 0 ? ` (${notes.join(', ')}).` : '.')
	);
}

function isDirectory(fsPath: string): boolean {
	try {
		return fs.statSync(fsPath).isDirectory();
	} catch {
		return false;
	}
}

function resolveConfiguredUri(filePath: string): vscode.Uri {
	return vscode.Uri.file(resolveFilePath(os.homedir(), filePath));
}

/* Adds a copy of a set (new id, numbered name) right after the original. */
async function duplicateSet(id: string | undefined): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const index: number = fileSets?.findIndex((set) => set.id === id) ?? -1;
	if (!fileSets || index === -1) {
		return;
	}

	fileSets.splice(index + 1, 0, duplicateFileSet(fileSets[index], fileSets));
	saveFileSets(fileSets);
}

/* Removes one file entry from its set, from the sidebar. */
async function removeFileFromSet(item: FilePathItem): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === item.setId);
	if (!fileSets || !target) {
		return;
	}

	// The tree may be slightly stale, so fall back to matching by path if the index has moved.
	const index: number =
		target.paths[item.pathIndex]?.path === item.entry.path
			? item.pathIndex
			: target.paths.findIndex((entry) => entry.path === item.entry.path);
	if (index === -1) {
		return;
	}

	target.paths.splice(index, 1);
	saveFileSets(fileSets);
}

/* Imports one or more sets from JSON on the clipboard (as produced by "Copy File Set as JSON"). */
async function importSet(): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	if (!fileSets) {
		return;
	}

	let imported: FileSet[];
	try {
		imported = importFileSets(await vscode.env.clipboard.readText(), fileSets);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not import: ${(error as Error).message}`);
		return;
	}

	saveFileSets([...fileSets, ...imported]);
	vscode.window.showInformationMessage(
		`File Grid Open: imported ${imported.length} file set${imported.length === 1 ? '' : 's'}: ` +
			imported.map((set) => `"${set.name}"`).join(', ')
	);
}

/*
 * Captures the files open in the editor grid as path entries with their columns/rows. Returns
 * undefined (after warning) when there is nothing to capture.
 */
async function captureCurrentLayout(): Promise<FileSetPathEntry[] | undefined> {
	// The file shown in each editor group: its active tab, else its first file tab.
	const pathByViewColumn: Map<number, string> = new Map();
	for (const group of vscode.window.tabGroups.all) {
		const fileTabs: vscode.Tab[] = group.tabs.filter(
			(tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file'
		);
		const shown: vscode.Tab | undefined = group.activeTab && fileTabs.includes(group.activeTab) ? group.activeTab : fileTabs[0];
		if (shown) {
			pathByViewColumn.set(group.viewColumn, (shown.input as vscode.TabInputText).uri.fsPath);
		}
	}
	if (pathByViewColumn.size === 0) {
		vscode.window.showWarningMessage('File Grid Open: there are no open file editors to save.');
		return undefined;
	}

	// `vscode.getEditorLayout` is an internal command; fall back to one column per group if it is unavailable.
	let layout: EditorLayout | undefined;
	try {
		layout = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
	} catch {
		layout = undefined;
	}
	if (!layout || !Array.isArray(layout.groups)) {
		layout = { orientation: 0, groups: vscode.window.tabGroups.all.map(() => ({})) };
	}

	return positionsToEntries(layoutToPositions(layout), pathByViewColumn);
}

/* Creates a new set from the files currently open in the editor grid, preserving their columns/rows. */
async function saveLayoutAsSet(): Promise<void> {
	const entries: FileSetPathEntry[] | undefined = await captureCurrentLayout();
	if (!entries) {
		return;
	}

	const name: string | undefined = await vscode.window.showInputBox({
		prompt: `Name for the new file set (${entries.length} file${entries.length === 1 ? '' : 's'})`,
		value: 'Current layout',
		validateInput: (value) => (value.trim() ? undefined : 'Name cannot be empty.')
	});
	if (!name) {
		return;
	}

	const fileSets: FileSet[] | undefined = await loadFileSets();
	if (!fileSets) {
		return;
	}

	const finalName: string = uniqueName(
		name.trim(),
		fileSets.map((set) => set.name)
	);
	saveFileSets([...fileSets, { id: newFileSetId(), name: finalName, paths: entries }]);
	vscode.window.showInformationMessage(`File Grid Open: saved the current layout as "${finalName}".`);
}

/* Replaces a set's files with the ones currently open in the editor grid, after confirmation. */
async function updateSetFromLayout(id: string | undefined): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === id);
	if (!fileSets || !target) {
		return;
	}

	const entries: FileSetPathEntry[] | undefined = await captureCurrentLayout();
	if (!entries) {
		return;
	}

	const confirm: string | undefined = await vscode.window.showWarningMessage(
		`Replace the ${target.paths.length} file${target.paths.length === 1 ? '' : 's'} in "${target.name}" ` +
			`with the ${entries.length} currently open?`,
		{ modal: true },
		'Replace'
	);
	if (confirm !== 'Replace') {
		return;
	}

	const fresh: { fileSets: FileSet[]; target: FileSet } | undefined = await reloadTargetSet(id);
	if (!fresh) {
		return;
	}

	fresh.target.paths = entries;
	saveFileSets(fresh.fileSets);
}

/* Pins or unpins a set's status bar item. */
async function setPinned(id: string | undefined, pinned: boolean): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === id);
	if (!fileSets || !target) {
		return;
	}

	if (pinned) {
		target.pinned = true;
	} else {
		delete target.pinned;
	}
	saveFileSets(fileSets);
}

/* Opens a single file from a set in an editor group the user picks, without opening the whole set. */
async function openFileAt(item: FilePathItem): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === item.setId);
	const entry: FileSetPathEntry | undefined = target?.paths[item.pathIndex];
	if (!target || !entry || entry.path !== item.entry.path) {
		return;
	}

	type GroupPick = vscode.QuickPickItem & { viewColumn: vscode.ViewColumn };
	const picks: GroupPick[] = [];

	const placement = planLayout(target.paths).placements.find((placed) => placed.entry === entry);
	if (placement && placement.viewColumn <= MAX_VIEW_COLUMNS) {
		picks.push({
			label: `$(layout) Configured position`,
			description: `editor group ${placement.viewColumn}`,
			viewColumn: placement.viewColumn as vscode.ViewColumn
		});
	}
	picks.push(
		{ label: '$(target) Active editor group', viewColumn: vscode.ViewColumn.Active },
		{ label: '$(split-horizontal) Beside the active group', viewColumn: vscode.ViewColumn.Beside }
	);
	for (const group of vscode.window.tabGroups.all) {
		picks.push({
			label: `$(window) Editor group ${group.viewColumn}`,
			description: group.activeTab?.label,
			viewColumn: group.viewColumn
		});
	}

	const picked: GroupPick | undefined = await vscode.window.showQuickPick(picks, {
		placeHolder: `Open ${entry.path} in...`
	});
	if (!picked) {
		return;
	}

	try {
		await vscode.window.showTextDocument(resolveConfiguredUri(entry.path), { viewColumn: picked.viewColumn, preview: false });
	} catch {
		vscode.window.showWarningMessage(`File Grid Open: Could not open: ${entry.path}`);
	}
}

/*
 * Expands glob entries (after filling in date tokens) into the matching files. Plain entries pass
 * through. A pattern with no matches is reported and contributes nothing.
 */
function expandGlobs(entries: FileSetPathEntry[]): FileSetPathEntry[] {
	const result: FileSetPathEntry[] = [];
	for (const entry of entries) {
		if (!isGlobPattern(entry.path)) {
			result.push(entry);
			continue;
		}

		const found: GlobResult = findGlobMatches(entry);
		if (found.truncated) {
			vscode.window.showWarningMessage(`File Grid Open: the search for "${found.pattern}" was cut short because it covers too many folders.`);
		}
		if (found.matches.length === 0) {
			vscode.window.showWarningMessage(`File Grid Open: no files match "${found.pattern}".`);
			continue;
		}
		result.push(...expandGlobEntry(entry, found.matches));
	}
	return result;
}

/* Moves a set into an existing group, a new one, or out of its group, chosen from a quick pick. */
async function moveToGroup(id: string | undefined): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === id);
	if (!fileSets || !target || !target.id) {
		return;
	}

	type GroupPick = vscode.QuickPickItem & { action: 'existing' | 'new' | 'none'; group?: string };
	const picks: GroupPick[] = groupNames(fileSets)
		.filter((name) => name !== target.group)
		.map((name) => ({ label: `$(folder) ${name}`, action: 'existing', group: name }));
	picks.push({ label: '$(new-folder) New Group...', action: 'new' });
	if (target.group) {
		picks.push({ label: '$(close) Remove from Group', action: 'none' });
	}

	const picked: GroupPick | undefined = await vscode.window.showQuickPick(picks, { placeHolder: `Move "${target.name}" to...` });
	if (!picked) {
		return;
	}

	let newGroup: string | undefined;
	if (picked.action === 'new') {
		const name: string | undefined = await vscode.window.showInputBox({
			prompt: 'New group name',
			validateInput: (value) => (value.trim() ? undefined : 'Name cannot be empty.')
		});
		if (!name) {
			return;
		}
		newGroup = name.trim();
	}

	const fresh: { fileSets: FileSet[]; target: FileSet } | undefined = await reloadTargetSet(id);
	if (!fresh) {
		return;
	}

	const targetId: string = target.id;
	if (picked.action === 'existing' && picked.group) {
		saveFileSets(moveSetsIntoGroup(fresh.fileSets, [targetId], picked.group));
	} else if (newGroup !== undefined) {
		saveFileSets(assignGroup(fresh.fileSets, [targetId], newGroup));
	} else if (picked.action === 'none') {
		saveFileSets(assignGroup(fresh.fileSets, [targetId], undefined));
	}
}

/* Prompts for a new name for a group and applies it to every set in it. */
async function renameGroupCommand(oldName: string): Promise<void> {
	const newName: string | undefined = await vscode.window.showInputBox({
		prompt: `Rename group "${oldName}"`,
		value: oldName,
		validateInput: (value) => (value.trim() ? undefined : 'Name cannot be empty.')
	});
	if (newName && newName.trim() !== oldName) {
		await changeGroup(oldName, newName.trim());
	}
}

/* Renames a group on every set in it; an empty new name removes the group and keeps its sets. */
async function changeGroup(oldName: string, newName: string): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	if (fileSets) {
		saveFileSets(renameGroup(fileSets, oldName, newName));
	}
}

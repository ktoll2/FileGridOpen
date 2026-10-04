import * as path from 'path';
import * as vscode from 'vscode';
import {
	FileSet,
	FileSetPathEntry,
	ensureConfigFile,
	getConfigPath,
	getPrimaryWorkspaceFolder,
	newFileSetId,
	readFileSetsEnsuringIds,
	writeFileSets
} from './config';
import { openConfigEditor, reloadConfigEditor } from './configEditor';
import {
	EditorLayout,
	assignGroup,
	duplicateFileSet,
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
	toRelativePath,
	uniqueName
} from './core/setLogic';
import { findGlobMatches } from './globMatches';
import { FileSetsDragAndDrop } from './fileSetsDnd';
import { FilePathItem, FileSetItem, FileSetsProvider, GroupItem } from './fileSetsProvider';
import { MAX_VIEW_COLUMNS, applyGridLayout, planLayout } from './layout';

const LAST_SET_KEY = 'lastSetId';

let extensionContext: vscode.ExtensionContext;
let lastSetStatusItem: vscode.StatusBarItem;
/** One status bar item per pinned set, keyed by set id. */
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

	/** Refreshes everything that displays the config: the File Sets view, the editor panel and the status bar. */
	function refreshViews(): void {
		provider.refresh();
		reloadConfigEditor();
		updateStatusItems();
	}

	let configWatcher: vscode.FileSystemWatcher | undefined;
	function rebuildConfigWatcher(): void {
		configWatcher?.dispose();
		configWatcher = undefined;

		const folder = getPrimaryWorkspaceFolder();
		if (!folder) {
			return;
		}

		const configPath: string = getConfigPath(folder);
		configWatcher = vscode.workspace.createFileSystemWatcher(
			// A RelativePattern is needed to watch a config file that lives outside the workspace.
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
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			rebuildConfigWatcher();
			refreshViews();
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
		vscode.commands.registerCommand('fileGridOpen.addToSet', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
			await addFilesToSet(uri, uris);
			refreshViews();
		})
	);

	updateStatusItems();
	void openStartupSet();
}

export function deactivate(): void {
	// no-op
}

async function editConfig(focusSetId?: string): Promise<void> {
	const folder = getPrimaryWorkspaceFolder();
	if (!folder) {
		vscode.window.showWarningMessage('File Grid Open: open a folder or workspace first.');
		return;
	}

	openConfigEditor(folder, getConfigPath(folder), editConfigJson, focusSetId);
}

async function editConfigJson(): Promise<void> {
	const folder = getPrimaryWorkspaceFolder();
	if (!folder) {
		vscode.window.showWarningMessage('File Grid Open: open a folder or workspace first.');
		return;
	}

	const configPath = getConfigPath(folder);
	try {
		ensureConfigFile(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not create ${configPath}: ${(error as Error).message}`);
		return;
	}

	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
	await vscode.window.showTextDocument(document, { preview: false });
}

async function loadFileSets(): Promise<FileSet[] | undefined> {
	const folder = getPrimaryWorkspaceFolder();
	if (!folder) {
		vscode.window.showWarningMessage('File Grid Open: open a folder or workspace first.');
		return undefined;
	}

	const configPath = getConfigPath(folder);
	try {
		return readFileSetsEnsuringIds(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: ${(error as Error).message}`);
		return undefined;
	}
}

async function openSet(id: string | undefined): Promise<void> {
	const fileSets = await loadFileSets();
	if (!fileSets) {
		return;
	}

	if (fileSets.length === 0) {
		const folder = getPrimaryWorkspaceFolder();
		const configPath = folder ? getConfigPath(folder) : undefined;
		const editConfigChoice = 'Edit Configuration';
		const choice = await vscode.window.showInformationMessage(
			configPath
				? `No file sets are configured. Add entries to ${configPath}.`
				: 'No file sets are configured.',
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

	const entries: FileSetPathEntry[] = await expandGlobs(fileSet.paths);
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
			await vscode.window.showTextDocument(resolveWorkspacePath(placement.entry.path), {
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

	await extensionContext.workspaceState.update(LAST_SET_KEY, fileSet.id);
	updateStatusItems();
}

/** Reads the file sets without surfacing errors; for background uses like the status bar. */
function readFileSetsQuietly(): FileSet[] {
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	if (!folder) {
		return [];
	}

	try {
		return readFileSetsEnsuringIds(getConfigPath(folder));
	} catch {
		return [];
	}
}

/**
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

	const lastId: string | undefined = extensionContext.workspaceState.get<string>(LAST_SET_KEY);
	const lastSet: FileSet | undefined = sets.find((set) => set.id === lastId);
	if (!lastSet || lastSet.pinned) {
		lastSetStatusItem.hide();
		return;
	}

	lastSetStatusItem.text = `$(files) ${lastSet.name}`;
	lastSetStatusItem.tooltip = `File Grid Open: reopen "${lastSet.name}"`;
	lastSetStatusItem.show();
}

/** Reopens the last opened set, or prompts for one if there is none (or it no longer exists). */
async function openLastSet(): Promise<void> {
	const lastId: string | undefined = extensionContext.workspaceState.get<string>(LAST_SET_KEY);
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

/** Renames a file set after prompting for a name; a name another set already uses gets a number appended. */
async function renameSet(id: string | undefined): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === id);
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	if (!fileSets || !target || !folder) {
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

	const finalName: string = uniqueName(
		newName.trim(),
		fileSets.filter((set) => set !== target).map((set) => set.name)
	);
	if (finalName === oldName) {
		return;
	}

	target.name = finalName;
	saveFileSets(folder, fileSets);
}

/** Deletes a file set after a modal confirmation. */
async function deleteSet(id: string | undefined): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === id);
	if (!fileSets || !folder || !target) {
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

	saveFileSets(
		folder,
		fileSets.filter((set) => set.id !== id)
	);
}

function saveFileSets(folder: vscode.WorkspaceFolder, fileSets: FileSet[]): void {
	try {
		writeFileSets(getConfigPath(folder), fileSets);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not save: ${(error as Error).message}`);
	}
}

/** Adds one or more Explorer-selected files to an existing or new file set. */
async function addFilesToSet(uri: vscode.Uri, selected: vscode.Uri[] | undefined): Promise<void> {
	const uris = selected && selected.length > 0 ? selected : [uri];
	const folder = vscode.workspace.getWorkspaceFolder(uri) ?? getPrimaryWorkspaceFolder();
	if (!folder) {
		vscode.window.showWarningMessage('File Grid Open: open a folder or workspace first.');
		return;
	}

	const configPath = getConfigPath(folder);
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

	let targetSet: FileSet;
	if (!picked.fileSet) {
		const name = await vscode.window.showInputBox({
			prompt: 'New file set name',
			validateInput: (value) => (value.trim() ? undefined : 'Name cannot be empty.')
		});
		if (!name) {
			return;
		}

		targetSet = {
			id: newFileSetId(),
			name: uniqueName(
				name.trim(),
				fileSets.map((set) => set.name)
			),
			paths: []
		};
		fileSets = [...fileSets, targetSet];
	} else {
		targetSet = picked.fileSet;
	}

	const existingPaths = new Set(targetSet.paths.map((entry) => entry.path));
	let addedCount = 0;
	for (const fileUri of uris) {
		const relativePath = toWorkspaceRelativePath(folder, fileUri);
		if (!existingPaths.has(relativePath)) {
			targetSet.paths.push({ path: relativePath });
			existingPaths.add(relativePath);
			addedCount++;
		}
	}

	try {
		writeFileSets(configPath, fileSets);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not save: ${(error as Error).message}`);
		return;
	}

	const skippedCount = uris.length - addedCount;
	vscode.window.showInformationMessage(
		`File Grid Open: added ${addedCount} file${addedCount === 1 ? '' : 's'} to "${targetSet.name}"` +
			(skippedCount > 0 ? ` (${skippedCount} already present).` : '.')
	);
}

function toWorkspaceRelativePath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
	return toRelativePath(folder.uri.fsPath, uri.fsPath);
}

function resolveWorkspacePath(filePath: string): vscode.Uri {
	const folder = getPrimaryWorkspaceFolder();
	return vscode.Uri.file(resolveFilePath(folder ? folder.uri.fsPath : '', filePath));
}

/** Adds a copy of a set (new id, numbered name) right after the original. */
async function duplicateSet(id: string | undefined): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	const index: number = fileSets?.findIndex((set) => set.id === id) ?? -1;
	if (!fileSets || !folder || index === -1) {
		return;
	}

	fileSets.splice(index + 1, 0, duplicateFileSet(fileSets[index], fileSets));
	saveFileSets(folder, fileSets);
}

/** Removes one file entry from its set, from the sidebar. */
async function removeFileFromSet(item: FilePathItem): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === item.setId);
	if (!fileSets || !folder || !target) {
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
	saveFileSets(folder, fileSets);
}

/** Imports one or more sets from JSON on the clipboard (as produced by "Copy File Set as JSON"). */
async function importSet(): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	if (!fileSets || !folder) {
		return;
	}

	let imported: FileSet[];
	try {
		imported = importFileSets(await vscode.env.clipboard.readText(), fileSets);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not import: ${(error as Error).message}`);
		return;
	}

	saveFileSets(folder, [...fileSets, ...imported]);
	vscode.window.showInformationMessage(
		`File Grid Open: imported ${imported.length} file set${imported.length === 1 ? '' : 's'}: ` +
			imported.map((set) => `"${set.name}"`).join(', ')
	);
}

/**
 * Captures the files open in the editor grid as path entries with their columns/rows. Returns
 * undefined (after warning) when there is nothing to capture.
 */
async function captureCurrentLayout(folder: vscode.WorkspaceFolder): Promise<FileSetPathEntry[] | undefined> {
	// The file shown in each editor group: its active tab, else its first file tab.
	const pathByViewColumn: Map<number, string> = new Map();
	for (const group of vscode.window.tabGroups.all) {
		const fileTabs: vscode.Tab[] = group.tabs.filter(
			(tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file'
		);
		const shown: vscode.Tab | undefined = group.activeTab && fileTabs.includes(group.activeTab) ? group.activeTab : fileTabs[0];
		if (shown) {
			pathByViewColumn.set(group.viewColumn, toWorkspaceRelativePath(folder, (shown.input as vscode.TabInputText).uri));
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

/** Creates a new set from the files currently open in the editor grid, preserving their columns/rows. */
async function saveLayoutAsSet(): Promise<void> {
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	if (!folder) {
		vscode.window.showWarningMessage('File Grid Open: open a folder or workspace first.');
		return;
	}

	const entries: FileSetPathEntry[] | undefined = await captureCurrentLayout(folder);
	if (!entries) {
		return;
	}

	const fileSets: FileSet[] | undefined = await loadFileSets();
	if (!fileSets) {
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

	const finalName: string = uniqueName(
		name.trim(),
		fileSets.map((set) => set.name)
	);
	saveFileSets(folder, [...fileSets, { id: newFileSetId(), name: finalName, paths: entries }]);
	vscode.window.showInformationMessage(`File Grid Open: saved the current layout as "${finalName}".`);
}

/** Replaces a set's files with the ones currently open in the editor grid, after confirmation. */
async function updateSetFromLayout(id: string | undefined): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === id);
	if (!fileSets || !folder || !target) {
		return;
	}

	const entries: FileSetPathEntry[] | undefined = await captureCurrentLayout(folder);
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

	target.paths = entries;
	saveFileSets(folder, fileSets);
}

/** Pins or unpins a set's status bar item. */
async function setPinned(id: string | undefined, pinned: boolean): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === id);
	if (!fileSets || !folder || !target) {
		return;
	}

	if (pinned) {
		target.pinned = true;
	} else {
		delete target.pinned;
	}
	saveFileSets(folder, fileSets);
}

/** Opens a single file from a set in an editor group the user picks, without opening the whole set. */
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
		await vscode.window.showTextDocument(resolveWorkspacePath(entry.path), { viewColumn: picked.viewColumn, preview: false });
	} catch {
		vscode.window.showWarningMessage(`Could not open: ${entry.path}`);
	}
}

/**
 * Expands glob entries (relative to the workspace, after filling in date tokens) into the matching files. Plain
 * entries pass through. A pattern with no matches is reported and contributes nothing.
 */
async function expandGlobs(entries: FileSetPathEntry[]): Promise<FileSetPathEntry[]> {
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	const result: FileSetPathEntry[] = [];
	for (const entry of entries) {
		if (!isGlobPattern(entry.path)) {
			result.push(entry);
			continue;
		}

		const found = folder ? await findGlobMatches(folder, entry) : undefined;
		if (!found || found.matches.length === 0) {
			vscode.window.showWarningMessage(
				`File Grid Open: no files match "${found?.pattern ?? entry.path}" (patterns must be relative to the workspace).`
			);
			continue;
		}
		result.push(...expandGlobEntry(entry, found.matches));
	}
	return result;
}

/** Moves a set into an existing group, a new one, or out of its group, chosen from a quick pick. */
async function moveToGroup(id: string | undefined): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	const target: FileSet | undefined = fileSets?.find((set) => set.id === id);
	if (!fileSets || !folder || !target || !target.id) {
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

	if (picked.action === 'existing' && picked.group) {
		saveFileSets(folder, moveSetsIntoGroup(fileSets, [target.id], picked.group));
	} else if (picked.action === 'new') {
		const name: string | undefined = await vscode.window.showInputBox({
			prompt: 'New group name',
			validateInput: (value) => (value.trim() ? undefined : 'Name cannot be empty.')
		});
		if (name) {
			saveFileSets(folder, assignGroup(fileSets, [target.id], name.trim()));
		}
	} else if (picked.action === 'none') {
		saveFileSets(folder, assignGroup(fileSets, [target.id], undefined));
	}
}

/** Prompts for a new name for a group and applies it to every set in it. */
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

/** Renames a group on every set in it; an empty new name removes the group and keeps its sets. */
async function changeGroup(oldName: string, newName: string): Promise<void> {
	const fileSets: FileSet[] | undefined = await loadFileSets();
	const folder: vscode.WorkspaceFolder | undefined = getPrimaryWorkspaceFolder();
	if (fileSets && folder) {
		saveFileSets(folder, renameGroup(fileSets, oldName, newName));
	}
}

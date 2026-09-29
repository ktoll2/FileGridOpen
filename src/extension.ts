import * as path from 'path';
import * as vscode from 'vscode';
import { FileSet, ensureConfigFile, getConfigPath, getPrimaryWorkspaceFolder, readFileSets, writeFileSets } from './config';
import { openConfigEditor } from './configEditor';
import { FileSetsProvider } from './fileSetsProvider';
import { MAX_VIEW_COLUMNS, applyGridLayout, planLayout } from './layout';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new FileSetsProvider();
	context.subscriptions.push(vscode.window.registerTreeDataProvider('fileGridOpenSets', provider));

	let configWatcher: vscode.FileSystemWatcher | undefined;
	function rebuildConfigWatcher(): void {
		configWatcher?.dispose();
		configWatcher = undefined;

		const folder = getPrimaryWorkspaceFolder();
		if (!folder) {
			return;
		}

		configWatcher = vscode.workspace.createFileSystemWatcher(getConfigPath(folder));
		configWatcher.onDidChange(() => provider.refresh());
		configWatcher.onDidCreate(() => provider.refresh());
		configWatcher.onDidDelete(() => provider.refresh());
	}

	rebuildConfigWatcher();

	context.subscriptions.push(
		new vscode.Disposable(() => configWatcher?.dispose()),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('fileGridOpen.configPath')) {
				rebuildConfigWatcher();
				provider.refresh();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			rebuildConfigWatcher();
			provider.refresh();
		}),
		vscode.commands.registerCommand('fileGridOpen.openSet', () => openSet(undefined)),
		vscode.commands.registerCommand('fileGridOpen.openSetByName', (name: string) => openSet(name)),
		vscode.commands.registerCommand('fileGridOpen.editConfig', editConfig),
		vscode.commands.registerCommand('fileGridOpen.editConfigJson', editConfigJson),
		vscode.commands.registerCommand('fileGridOpen.refresh', () => provider.refresh()),
		vscode.commands.registerCommand('fileGridOpen.addToSet', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
			await addFilesToSet(uri, uris);
			provider.refresh();
		})
	);
}

export function deactivate(): void {
	// no-op
}

async function editConfig(): Promise<void> {
	const folder = getPrimaryWorkspaceFolder();
	if (!folder) {
		vscode.window.showWarningMessage('FileGridOpen: open a folder or workspace first.');
		return;
	}

	openConfigEditor(folder, getConfigPath(folder), editConfigJson);
}

async function editConfigJson(): Promise<void> {
	const folder = getPrimaryWorkspaceFolder();
	if (!folder) {
		vscode.window.showWarningMessage('FileGridOpen: open a folder or workspace first.');
		return;
	}

	const configPath = getConfigPath(folder);
	try {
		ensureConfigFile(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`FileGridOpen: could not create ${configPath}: ${(error as Error).message}`);
		return;
	}

	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
	await vscode.window.showTextDocument(document, { preview: false });
}

async function loadFileSets(): Promise<FileSet[] | undefined> {
	const folder = getPrimaryWorkspaceFolder();
	if (!folder) {
		vscode.window.showWarningMessage('FileGridOpen: open a folder or workspace first.');
		return undefined;
	}

	const configPath = getConfigPath(folder);
	try {
		return readFileSets(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`FileGridOpen: ${(error as Error).message}`);
		return undefined;
	}
}

async function openSet(name: string | undefined): Promise<void> {
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
	if (name !== undefined) {
		selected = fileSets.find((fileSet) => fileSet.name === name);
	} else if (fileSets.length === 1) {
		selected = fileSets[0];
	} else {
		const pickedName = await vscode.window.showQuickPick(
			fileSets.map((fileSet) => fileSet.name),
			{ placeHolder: 'Select a file set to open' }
		);
		selected = fileSets.find((fileSet) => fileSet.name === pickedName);
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

	const plan = planLayout(fileSet.paths);
	const overflow = plan.placements.filter((p) => p.viewColumn > MAX_VIEW_COLUMNS);
	if (overflow.length > 0) {
		vscode.window.showWarningMessage(
			`FileGridOpen: "${fileSet.name}" needs more than ${MAX_VIEW_COLUMNS} editor groups; ` +
				`skipping ${overflow.map((p) => p.entry.path).join(', ')}.`
		);
	}

	if (plan.rebuildsGrid && plan.groups) {
		vscode.window.showInformationMessage(`FileGridOpen: rebuilding the editor grid for "${fileSet.name}".`);
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
}

const CREATE_NEW_SET = '$(add) Create New Set...';

/** Adds one or more Explorer-selected files to an existing or new file set. */
async function addFilesToSet(uri: vscode.Uri, selected: vscode.Uri[] | undefined): Promise<void> {
	const uris = selected && selected.length > 0 ? selected : [uri];
	const folder = vscode.workspace.getWorkspaceFolder(uri) ?? getPrimaryWorkspaceFolder();
	if (!folder) {
		vscode.window.showWarningMessage('FileGridOpen: open a folder or workspace first.');
		return;
	}

	const configPath = getConfigPath(folder);
	let fileSets: FileSet[];
	try {
		fileSets = readFileSets(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`FileGridOpen: ${(error as Error).message}`);
		return;
	}

	const picked = await vscode.window.showQuickPick([CREATE_NEW_SET, ...fileSets.map((set) => set.name)], {
		placeHolder: `Add ${uris.length} file${uris.length === 1 ? '' : 's'} to which set?`
	});
	if (!picked) {
		return;
	}

	let targetSet: FileSet;
	if (picked === CREATE_NEW_SET) {
		const name = await vscode.window.showInputBox({
			prompt: 'New file set name',
			validateInput: (value) => {
				if (!value.trim()) {
					return 'Name cannot be empty.';
				}
				if (fileSets.some((set) => set.name === value.trim())) {
					return 'A set with this name already exists.';
				}
				return undefined;
			}
		});
		if (!name) {
			return;
		}

		targetSet = { name: name.trim(), paths: [] };
		fileSets = [...fileSets, targetSet];
	} else {
		const existing = fileSets.find((set) => set.name === picked);
		if (!existing) {
			return;
		}
		targetSet = existing;
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
		vscode.window.showErrorMessage(`FileGridOpen: could not save: ${(error as Error).message}`);
		return;
	}

	const skippedCount = uris.length - addedCount;
	vscode.window.showInformationMessage(
		`FileGridOpen: added ${addedCount} file${addedCount === 1 ? '' : 's'} to "${targetSet.name}"` +
			(skippedCount > 0 ? ` (${skippedCount} already present).` : '.')
	);
}

function toWorkspaceRelativePath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
	const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
	return relative.startsWith('..') ? uri.fsPath : relative;
}

function resolveWorkspacePath(filePath: string): vscode.Uri {
	if (path.isAbsolute(filePath)) {
		return vscode.Uri.file(filePath);
	}

	const folder = getPrimaryWorkspaceFolder();
	const base = folder ? folder.uri.fsPath : '';
	return vscode.Uri.file(path.join(base, filePath));
}

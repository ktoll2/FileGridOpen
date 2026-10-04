import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileSet, ensureConfigFile, readFileSetsEnsuringIds, withIds, writeFileSets } from './config';
import { findMissingPaths, moveItem, resolveFilePath, uniqueName } from './core/setLogic';
import { findCollisions } from './layout';

type InboundMessage =
	| { type: 'save'; fileSets: FileSet[]; auto?: boolean; version: number }
	| { type: 'browse'; setIndex: number; pathIndex: number }
	| { type: 'confirmRemoveSet'; id: string; name: string }
	| { type: 'openJson' };

type OutboundMessage =
	| { type: 'browseResult'; setIndex: number; pathIndex: number; path: string }
	| { type: 'saved'; version: number; missing: string[] }
	| { type: 'focusSet'; id: string }
	| { type: 'removeSetConfirmed'; id: string }
	| { type: 'reload'; fileSets: FileSet[]; missing: string[] }
	| { type: 'saveRejected'; messages: string[]; cells: { setIndex: number; pathIndex: number }[] };

let activePanel: vscode.WebviewPanel | undefined;
let activeConfigPath: string | undefined;
let activeFolder: vscode.WorkspaceFolder | undefined;

/** The configured paths, among those in the sets, that don't exist on disk. */
function findMissing(folder: vscode.WorkspaceFolder, fileSets: FileSet[]): string[] {
	return findMissingPaths(fileSets, (filePath) => !fs.existsSync(resolveFilePath(folder.uri.fsPath, filePath)));
}

/**
 * Pushes the config file's current contents to the open editor panel (if any), e.g. after a set was
 * deleted from the sidebar or the file was edited elsewhere. The page ignores it while it has unsaved edits.
 */
export function reloadConfigEditor(): void {
	if (!activePanel || !activeConfigPath || !activeFolder) {
		return;
	}

	try {
		const fileSets: FileSet[] = readFileSetsEnsuringIds(activeConfigPath);
		const outbound: OutboundMessage = { type: 'reload', fileSets, missing: findMissing(activeFolder, fileSets) };
		activePanel.webview.postMessage(outbound);
	} catch {
		// An unreadable config (e.g. mid-edit invalid JSON) leaves the editor showing its last good state.
	}
}

/**
 * Opens (or reveals) a form-based editor for the file sets in a config file, as an alternative to
 * hand-editing the JSON. Only one instance is kept open at a time since there's one config file
 * per workspace folder. When focusSetId is given, the editor scrolls to and highlights that set.
 */
export function openConfigEditor(
	folder: vscode.WorkspaceFolder,
	configPath: string,
	openJson: () => Promise<void>,
	focusSetId?: string
): void {
	if (activePanel) {
		activePanel.reveal();
		if (focusSetId !== undefined) {
			activePanel.webview.postMessage({ type: 'focusSet', id: focusSetId } satisfies OutboundMessage);
		}
		return;
	}

	try {
		ensureConfigFile(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not create ${configPath}: ${(error as Error).message}`);
		return;
	}

	const panel = vscode.window.createWebviewPanel('fileGridOpenConfigEditor', 'File Grid Open: Configuration', vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true
	});
	activePanel = panel;
	activeConfigPath = configPath;
	activeFolder = folder;

	let fileSets: FileSet[];
	try {
		fileSets = readFileSetsEnsuringIds(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: ${(error as Error).message}`);
		fileSets = [];
	}

	panel.webview.html = getHtml(fileSets, focusSetId, findMissing(folder, fileSets));

	panel.webview.onDidReceiveMessage(async (message: InboundMessage) => {
		switch (message.type) {
			case 'save': {
				const collisionMessages: string[] = [];
				const collisionCells: { setIndex: number; pathIndex: number }[] = [];

				message.fileSets.forEach((fileSet, setIndex) => {
					for (const collision of findCollisions(fileSet.paths)) {
						collisionMessages.push(
							`"${fileSet.name}": ${collision.paths.join(', ')} all target column ${collision.column}, row ${collision.row}.`
						);
						for (const pathIndex of collision.indexes) {
							collisionCells.push({ setIndex, pathIndex });
						}
					}
				});

				if (collisionMessages.length > 0) {
					const outbound: OutboundMessage = { type: 'saveRejected', messages: collisionMessages, cells: collisionCells };
					panel.webview.postMessage(outbound);
					// Autosave fires mid-edit, so conflicts show inline only rather than as a popup.
					if (!message.auto) {
						vscode.window.showErrorMessage(
							`File Grid Open: not saved - fix these column/row conflicts first:\n${collisionMessages.join('\n')}`
						);
					}
					return;
				}

				try {
					const toSave: FileSet[] = withIds(message.fileSets);
					writeFileSets(configPath, toSave);
					vscode.window.setStatusBarMessage('File Grid Open: configuration saved.', 2000);
					panel.webview.postMessage({
						type: 'saved',
						version: message.version,
						missing: findMissing(folder, toSave)
					} satisfies OutboundMessage);
				} catch (error) {
					vscode.window.showErrorMessage(`File Grid Open: could not save: ${(error as Error).message}`);
				}
				return;
			}
			case 'browse': {
				const picked = await vscode.window.showOpenDialog({
					defaultUri: folder.uri,
					canSelectMany: false,
					openLabel: 'Select File'
				});
				const file = picked?.[0];
				if (!file) {
					return;
				}

				const relative = path.relative(folder.uri.fsPath, file.fsPath).split(path.sep).join('/');
				const outbound: OutboundMessage = {
					type: 'browseResult',
					setIndex: message.setIndex,
					pathIndex: message.pathIndex,
					path: relative.startsWith('..') ? file.fsPath : relative
				};
				panel.webview.postMessage(outbound);
				return;
			}
			case 'confirmRemoveSet': {
				// Webviews can't show window.confirm, so the confirmation is a modal on the extension side.
				const choice: string | undefined = await vscode.window.showWarningMessage(
					`Delete file set "${message.name}"?`,
					{ modal: true },
					'Delete'
				);
				if (choice === 'Delete') {
					panel.webview.postMessage({ type: 'removeSetConfirmed', id: message.id } satisfies OutboundMessage);
				}
				return;
			}
			case 'openJson':
				await openJson();
				return;
		}
	});

	panel.onDidDispose(() => {
		activePanel = undefined;
		activeConfigPath = undefined;
		activeFolder = undefined;
	});
}

function getNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return text;
}

function getHtml(fileSets: FileSet[], focusSetId: string | undefined, missing: string[]): string {
	const nonce = getNonce();
	const initialFocus = JSON.stringify(focusSetId ?? null).replace(/</g, '\\u003c');
	const initialMissing = JSON.stringify(missing).replace(/</g, '\\u003c');
	const initialState = JSON.stringify(fileSets).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>File Grid Open Configuration</title>
<style>
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 16px; }
	.toolbar { display: flex; gap: 8px; margin-bottom: 14px; }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 2px; font-family: inherit; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); }
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
	button.icon { padding: 2px 6px; }
	.set { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px 12px; margin-bottom: 12px; }
	.set-header { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
	.set-header input[type=text] { flex: 1; font-weight: 600; }
	.path-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
	.path-row input[type=text] { flex: 1; }
	.path-row input[type=number] { width: 52px; }
	.path-row label { font-size: 11px; opacity: 0.75; }
	input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; font-family: inherit; }
	input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.set.focused { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
	.set-header .spacer { flex: 1; }
	.options { display: flex; gap: 16px; margin-bottom: 10px; font-size: 12px; }
	.options label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
	button:disabled { opacity: 0.4; cursor: default; }
	.path-row.missing input[type=text] { border-color: var(--vscode-editorWarning-foreground); outline: 1px solid var(--vscode-editorWarning-foreground); outline-offset: -1px; }
	.empty { opacity: 0.7; font-style: italic; margin-bottom: 12px; }
	.add-path { margin-top: 2px; }
	.hint { opacity: 0.7; font-size: 12px; margin-bottom: 14px; }
	.status { min-height: 18px; margin-bottom: 10px; font-size: 12px; white-space: pre-line; }
	.status.error { color: var(--vscode-errorForeground); }
	.status.success { color: var(--vscode-terminal-ansiGreen, var(--vscode-foreground)); }
	.path-row.collision input[type=number] { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); outline: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); outline-offset: -1px; }
</style>
</head>
<body>
	<div class="hint">Changes are saved automatically. Paths may be glob patterns like src/components/*.tsx (matches expand when the set opens); {YYYY-MM-DD}, {YYYYMMDD}, {YYYY}, {MM} and {DD} become today's date. Column/row are optional. No column/row: files open left to right. A shared column with different rows creates a vertical split within that column.</div>
	<div class="toolbar">
		<button id="addSet">+ Add File Set</button>
		<button id="openJson" class="secondary">Edit as JSON</button>
	</div>
	<div id="status" class="status"></div>
	<div id="sets"></div>
<script nonce="${nonce}">
(function () {
	const vscode = acquireVsCodeApi();
	let fileSets = ${initialState};
	let collisionCells = [];
	let missingPaths = new Set(${initialMissing});

	// Shared with the extension (src/core/setLogic.ts) so the logic is tested once.
	${uniqueName.toString()}
	${moveItem.toString()}

	function cellKey(setIndex, pathIndex) { return setIndex + ':' + pathIndex; }

	function setStatus(text, kind) {
		const status = document.getElementById('status');
		status.textContent = text;
		status.className = 'status' + (kind ? ' ' + kind : '');
	}

	let saveTimer;
	// editVersion counts edits; savedVersion is the last edit the extension confirmed as written.
	// They differ while edits are pending or in flight, during which disk reloads are ignored.
	let editVersion = 0;
	let savedVersion = 0;
	function scheduleSave() {
		clearTimeout(saveTimer);
		editVersion++;
		const version = editVersion;
		saveTimer = setTimeout(() => {
			vscode.postMessage({ type: 'save', fileSets, auto: true, version });
		}, 500);
	}

	// Key-order-independent form of the sets, for comparing page state against what is on disk.
	function snapshot(sets) {
		return JSON.stringify(sets.map((set) => ({
			id: set.id,
			name: set.name,
			closeOthers: !!set.closeOthers,
			openOnStartup: !!set.openOnStartup,
			pinned: !!set.pinned,
			group: set.group || '',
			paths: set.paths.map((entry) => ({ path: entry.path, column: entry.column, row: entry.row, newest: entry.newest }))
		})));
	}

	// Marks rows whose file does not exist on disk. Row positions map back to entries by data attributes.
	function applyMissing() {
		document.querySelectorAll('.path-row').forEach((row) => {
			const set = fileSets[Number(row.dataset.setIndex)];
			const entry = set && set.paths[Number(row.dataset.pathIndex)];
			const missing = !!entry && missingPaths.has(entry.path);
			row.classList.toggle('missing', missing);
			row.title = missing ? 'File not found' : '';
		});
	}

	function el(tag, props, children) {
		const node = document.createElement(tag);
		Object.assign(node, props || {});
		(children || []).forEach((child) => node.appendChild(child));
		return node;
	}

	function render() {
		const container = document.getElementById('sets');
		container.innerHTML = '';

		const groupList = el('datalist', { id: 'groupList' });
		[...new Set(fileSets.map((s) => s.group).filter(Boolean))].forEach((name) => groupList.appendChild(el('option', { value: name })));
		container.appendChild(groupList);

		if (fileSets.length === 0) {
			container.appendChild(el('div', { className: 'empty', textContent: 'No file sets yet. Click "Add File Set" to create one.' }));
		}

		fileSets.forEach((set, setIndex) => {
			const nameInput = el('input', { type: 'text', value: set.name, placeholder: 'Set name' });
			nameInput.addEventListener('input', () => { fileSets[setIndex].name = nameInput.value; scheduleSave(); });
			// On blur, a name that duplicates another set gets the lowest free number appended.
			nameInput.addEventListener('change', () => {
				const unique = uniqueName(nameInput.value, fileSets.filter((_, i) => i !== setIndex).map((s) => s.name));
				if (unique !== nameInput.value) {
					nameInput.value = unique;
					fileSets[setIndex].name = unique;
					scheduleSave();
				}
			});

			const removeSetBtn = el('button', { className: 'secondary', textContent: 'Remove Set' });
			removeSetBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'confirmRemoveSet', id: set.id, name: set.name });
			});

			const moveSetUpBtn = el('button', { className: 'secondary icon', textContent: '↑', title: 'Move set up', disabled: setIndex === 0 });
			moveSetUpBtn.addEventListener('click', () => {
				fileSets = moveItem(fileSets, setIndex, setIndex - 1);
				collisionCells = [];
				render();
				scheduleSave();
			});

			const moveSetDownBtn = el('button', { className: 'secondary icon', textContent: '↓', title: 'Move set down', disabled: setIndex === fileSets.length - 1 });
			moveSetDownBtn.addEventListener('click', () => {
				fileSets = moveItem(fileSets, setIndex, setIndex + 1);
				collisionCells = [];
				render();
				scheduleSave();
			});

			const duplicateSetBtn = el('button', { className: 'secondary', textContent: 'Duplicate' });
			duplicateSetBtn.addEventListener('click', () => {
				const copy = JSON.parse(JSON.stringify(set));
				copy.id = crypto.randomUUID();
				copy.name = uniqueName(set.name, fileSets.map((s) => s.name));
				delete copy.openOnStartup;
				delete copy.pinned;
				fileSets.splice(setIndex + 1, 0, copy);
				collisionCells = [];
				render();
				scheduleSave();
			});

			const header = el('div', { className: 'set-header' }, [nameInput, moveSetUpBtn, moveSetDownBtn, duplicateSetBtn, removeSetBtn]);

			const closeOthersInput = el('input', { type: 'checkbox', checked: !!set.closeOthers });
			closeOthersInput.addEventListener('change', () => {
				if (closeOthersInput.checked) { fileSets[setIndex].closeOthers = true; } else { delete fileSets[setIndex].closeOthers; }
				scheduleSave();
			});
			const openOnStartupInput = el('input', { type: 'checkbox', checked: !!set.openOnStartup });
			openOnStartupInput.addEventListener('change', () => {
				// Only one set can open on startup, so ticking this clears it on every other set.
				fileSets.forEach((s) => { delete s.openOnStartup; });
				if (openOnStartupInput.checked) { fileSets[setIndex].openOnStartup = true; }
				render();
				scheduleSave();
			});
			const pinnedInput = el('input', { type: 'checkbox', checked: !!set.pinned });
			pinnedInput.addEventListener('change', () => {
				if (pinnedInput.checked) { fileSets[setIndex].pinned = true; } else { delete fileSets[setIndex].pinned; }
				scheduleSave();
			});
			const groupInput = el('input', { type: 'text', value: set.group || '', placeholder: 'none' });
			groupInput.setAttribute('list', 'groupList');
			groupInput.addEventListener('input', () => {
				const v = groupInput.value.trim();
				if (v) { fileSets[setIndex].group = v; } else { delete fileSets[setIndex].group; }
				scheduleSave();
			});
			const options = el('div', { className: 'options' }, [
				el('label', { title: 'Close all other editors before opening this set' }, [closeOthersInput, document.createTextNode('Close other editors on open')]),
				el('label', { title: 'Open this set automatically when the workspace loads' }, [openOnStartupInput, document.createTextNode('Open on startup')]),
				el('label', { title: 'Show this set as a button in the status bar' }, [pinnedInput, document.createTextNode('Pin to status bar')]),
				el('label', { title: 'Sidebar folder this set is listed under' }, [document.createTextNode('Group'), groupInput])
			]);

			const setEl = el('div', { className: 'set' }, [header, options]);
			setEl.dataset.setIndex = String(setIndex);

			set.paths.forEach((entry, pathIndex) => {
				const pathInput = el('input', { type: 'text', value: entry.path, placeholder: 'relative/or/absolute/path' });
				pathInput.style.flex = '1';
				pathInput.addEventListener('input', () => { fileSets[setIndex].paths[pathIndex].path = pathInput.value; scheduleSave(); });

				const browseBtn = el('button', { className: 'secondary', textContent: 'Browse...' });
				browseBtn.addEventListener('click', () => {
					vscode.postMessage({ type: 'browse', setIndex, pathIndex });
				});

				const colInput = el('input', { type: 'number', min: '0', value: entry.column !== undefined ? String(entry.column) : '' });
				colInput.addEventListener('input', () => {
					const v = colInput.value.trim();
					fileSets[setIndex].paths[pathIndex].column = v === '' ? undefined : Number(v);
					collisionCells = [];
					setStatus('', '');
					scheduleSave();
				});

				const rowInput = el('input', { type: 'number', min: '0', value: entry.row !== undefined ? String(entry.row) : '' });
				rowInput.addEventListener('input', () => {
					const v = rowInput.value.trim();
					fileSets[setIndex].paths[pathIndex].row = v === '' ? undefined : Number(v);
					collisionCells = [];
					setStatus('', '');
					scheduleSave();
				});

				const newestInput = el('input', { type: 'number', min: '1', value: entry.newest !== undefined ? String(entry.newest) : '', title: 'For a glob pattern: open only the N most recently modified matches' });
				newestInput.addEventListener('input', () => {
					const v = newestInput.value.trim();
					// Only a positive whole number is valid in the config file; anything else clears the limit.
					if (/^[1-9][0-9]*$/.test(v)) { fileSets[setIndex].paths[pathIndex].newest = Number(v); } else { delete fileSets[setIndex].paths[pathIndex].newest; }
					scheduleSave();
				});

				const moveUpBtn = el('button', { className: 'secondary icon', textContent: '↑', title: 'Move file up', disabled: pathIndex === 0 });
				moveUpBtn.addEventListener('click', () => {
					fileSets[setIndex].paths = moveItem(fileSets[setIndex].paths, pathIndex, pathIndex - 1);
					collisionCells = [];
					render();
					scheduleSave();
				});

				const moveDownBtn = el('button', { className: 'secondary icon', textContent: '↓', title: 'Move file down', disabled: pathIndex === set.paths.length - 1 });
				moveDownBtn.addEventListener('click', () => {
					fileSets[setIndex].paths = moveItem(fileSets[setIndex].paths, pathIndex, pathIndex + 1);
					collisionCells = [];
					render();
					scheduleSave();
				});

				const removePathBtn = el('button', { className: 'secondary icon', textContent: '✕', title: 'Remove file' });
				removePathBtn.addEventListener('click', () => { fileSets[setIndex].paths.splice(pathIndex, 1); render(); scheduleSave(); });

				const isColliding = collisionCells.indexOf(cellKey(setIndex, pathIndex)) !== -1;
				const row = el('div', { className: 'path-row' + (isColliding ? ' collision' : '') }, [
					pathInput,
					browseBtn,
					el('label', { textContent: 'col' }),
					colInput,
					el('label', { textContent: 'row' }),
					rowInput,
					el('label', { textContent: 'newest' }),
					newestInput,
					moveUpBtn,
					moveDownBtn,
					removePathBtn
				]);
				row.dataset.setIndex = String(setIndex);
				row.dataset.pathIndex = String(pathIndex);
				setEl.appendChild(row);
			});

			const addPathBtn = el('button', { className: 'add-path', textContent: '+ Add File' });
			addPathBtn.addEventListener('click', () => { fileSets[setIndex].paths.push({ path: '' }); render(); scheduleSave(); });
			setEl.appendChild(addPathBtn);

			container.appendChild(setEl);
		});

		applyMissing();
	}

	function focusSet(id) {
		const index = fileSets.findIndex((set) => set.id === id);
		const target = document.querySelector('.set[data-set-index="' + index + '"]');
		if (!target) { return; }
		document.querySelectorAll('.set.focused').forEach((node) => node.classList.remove('focused'));
		target.classList.add('focused');
		target.scrollIntoView({ block: 'start', behavior: 'smooth' });
	}

	document.getElementById('addSet').addEventListener('click', () => {
		fileSets.push({ id: crypto.randomUUID(), name: uniqueName('New set', fileSets.map((s) => s.name)), paths: [] });
		render();
		scheduleSave();
	});

	document.getElementById('openJson').addEventListener('click', () => {
		vscode.postMessage({ type: 'openJson' });
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message.type === 'browseResult') {
			fileSets[message.setIndex].paths[message.pathIndex].path = message.path;
			render();
			scheduleSave();
		} else if (message.type === 'focusSet') {
			focusSet(message.id);
		} else if (message.type === 'saved') {
			collisionCells = [];
			savedVersion = message.version;
			missingPaths = new Set(message.missing);
			applyMissing();
			setStatus('Saved.', 'success');
		} else if (message.type === 'removeSetConfirmed') {
			const index = fileSets.findIndex((set) => set.id === message.id);
			if (index !== -1) {
				fileSets.splice(index, 1);
				render();
				scheduleSave();
			}
		} else if (message.type === 'reload') {
			if (editVersion !== savedVersion || snapshot(message.fileSets) === snapshot(fileSets)) {
				return;
			}
			fileSets = message.fileSets;
			collisionCells = [];
			missingPaths = new Set(message.missing);
			setStatus('Updated from the saved configuration.', '');
			render();
		} else if (message.type === 'saveRejected') {
			collisionCells = message.cells.map((c) => cellKey(c.setIndex, c.pathIndex));
			setStatus(message.messages.join('\\n'), 'error');
			render();
		}
	});

	render();
	const initialFocus = ${initialFocus};
	if (initialFocus !== null) { focusSet(initialFocus); }
})();
</script>
</body>
</html>`;
}

import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { FileSet, ensureConfigFile, readFileSets, readFileSetsEnsuringIds, withIds, writeFileSets } from './config';
import { parseFileSetsPayload } from './core/configFile';
import { findMissingPaths, moveItem, resolveFilePath, uniqueName } from './core/setLogic';
import { findCollisions } from './layout';

type InboundMessage =
	// fileSets is untrusted page state; it is validated before use.
	| { type: 'save'; fileSets: unknown; auto?: boolean; version: number; configPath: string }
	| { type: 'browse'; setId: string; pathIndex: number }
	| { type: 'confirmRemoveSet'; id: string; name: string }
	| { type: 'openJson' };

type OutboundMessage =
	| { type: 'browseResult'; setId: string; pathIndex: number; path: string }
	| { type: 'saved'; configPath: string; version: number; missing: string[] }
	| { type: 'focusSet'; id: string }
	| { type: 'removeSetConfirmed'; id: string }
	| { type: 'reload'; configPath: string; fileSets: FileSet[]; missing: string[] }
	| { type: 'pathChanged'; configPath: string; fileSets: FileSet[]; missing: string[] }
	| { type: 'invalid'; configPath: string; message: string }
	| { type: 'saveRejected'; messages: string[]; cells: { setIndex: number; pathIndex: number }[] };

let activePanel: vscode.WebviewPanel | undefined;
/** Resolves the current config path; called on every read/write since the setting can change while the editor is open. */
let activeConfigPathGetter: (() => string) | undefined;

/** Checks a raw webview message's shape and field types; returns undefined for anything malformed. */
function parseInboundMessage(raw: unknown): InboundMessage | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}

	const message: Record<string, unknown> = raw as Record<string, unknown>;
	switch (message.type) {
		case 'save':
			if (
				typeof message.configPath !== 'string' ||
				typeof message.version !== 'number' ||
				(message.auto !== undefined && typeof message.auto !== 'boolean')
			) {
				return undefined;
			}
			return { type: 'save', fileSets: message.fileSets, auto: message.auto, version: message.version, configPath: message.configPath };
		case 'browse':
			if (typeof message.setId !== 'string' || typeof message.pathIndex !== 'number' || !Number.isInteger(message.pathIndex) || message.pathIndex < 0) {
				return undefined;
			}
			return { type: 'browse', setId: message.setId, pathIndex: message.pathIndex };
		case 'confirmRemoveSet':
			if (typeof message.id !== 'string' || typeof message.name !== 'string') {
				return undefined;
			}
			return { type: 'confirmRemoveSet', id: message.id, name: message.name };
		case 'openJson':
			return { type: 'openJson' };
		default:
			return undefined;
	}
}

/** The configured paths, among those in the sets, that don't exist on disk. */
function findMissing(fileSets: FileSet[]): string[] {
	return findMissingPaths(fileSets, (filePath) => !fs.existsSync(resolveFilePath(os.homedir(), filePath)));
}

/**
 * Pushes the config file's current contents to the open editor panel (if any), e.g. after a set was
 * deleted from the sidebar or the file was edited elsewhere. The page ignores it while it has unsaved edits.
 */
export function reloadConfigEditor(): void {
	if (!activePanel || !activeConfigPathGetter) {
		return;
	}

	postContents(activePanel, activeConfigPathGetter(), 'reload');
}

/** Sends the file's current contents (or, if unreadable, an invalid notice) tagged with the path they came from. */
function postContents(panel: vscode.WebviewPanel, configPath: string, type: 'reload' | 'pathChanged'): void {
	try {
		const fileSets: FileSet[] = readFileSetsEnsuringIds(configPath);
		const outbound: OutboundMessage = { type, configPath, fileSets, missing: findMissing(fileSets) };
		panel.webview.postMessage(outbound);
	} catch (error) {
		// An unreadable config (e.g. mid-edit invalid JSON) locks the page so it cannot overwrite the file.
		panel.webview.postMessage({ type: 'invalid', configPath, message: (error as Error).message } satisfies OutboundMessage);
	}
}

/**
 * Opens (or reveals) a form-based editor for the file sets in a config file, as an alternative to
 * hand-editing the JSON. Only one instance is kept open at a time since there's one global config file. When focusSetId is given, the editor scrolls to and highlights that set.
 */
export function openConfigEditor(
	getConfigPath: () => string,
	openJson: () => Promise<void>,
	focusSetId?: string
): void {
	if (activePanel) {
		activePanel.reveal();
		reloadConfigEditor();
		if (focusSetId !== undefined) {
			activePanel.webview.postMessage({ type: 'focusSet', id: focusSetId } satisfies OutboundMessage);
		}
		return;
	}

	const initialPath: string = getConfigPath();
	try {
		ensureConfigFile(initialPath);
	} catch (error) {
		vscode.window.showErrorMessage(`File Grid Open: could not create ${initialPath}: ${(error as Error).message}`);
		return;
	}

	const panel = vscode.window.createWebviewPanel('fileGridOpenConfigEditor', 'File Grid Open: Configuration', vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true
	});
	activePanel = panel;
	activeConfigPathGetter = getConfigPath;

	let fileSets: FileSet[] = [];
	let initialError: string | undefined;
	try {
		fileSets = readFileSetsEnsuringIds(initialPath);
	} catch (error) {
		initialError = (error as Error).message;
	}

	panel.webview.html = getHtml(initialPath, fileSets, focusSetId, findMissing(fileSets), initialError);

	const handleMessage = async (raw: unknown): Promise<void> => {
		const message: InboundMessage | undefined = parseInboundMessage(raw);
		if (!message) {
			return;
		}

		switch (message.type) {
			case 'save': {
				// The page's state was loaded from another path (the setting changed): never write it here.
				if (message.configPath !== getConfigPath()) {
					postContents(panel, getConfigPath(), 'pathChanged');
					return;
				}

				// Only what the next read would accept may be written.
				const parsed: { fileSets: FileSet[] } | { error: string } = parseFileSetsPayload(message.fileSets);
				if ('error' in parsed) {
					const rejected: OutboundMessage = { type: 'saveRejected', messages: [parsed.error], cells: [] };
					panel.webview.postMessage(rejected);
					return;
				}
				const pageFileSets: FileSet[] = parsed.fileSets;

				const collisionMessages: string[] = [];
				const collisionCells: { setIndex: number; pathIndex: number }[] = [];

				pageFileSets.forEach((fileSet, setIndex) => {
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
					const configPath: string = message.configPath;
					try {
						// Never overwrite a file that does not currently parse; the user may be mid-edit.
						readFileSets(configPath);
					} catch (error) {
						panel.webview.postMessage({ type: 'invalid', configPath, message: (error as Error).message } satisfies OutboundMessage);
						return;
					}
					const toSave: FileSet[] = withIds(pageFileSets);
					writeFileSets(configPath, toSave);
					vscode.window.setStatusBarMessage('File Grid Open: configuration saved.', 2000);
					panel.webview.postMessage({
						type: 'saved',
						configPath,
						version: message.version,
						missing: findMissing(toSave)
					} satisfies OutboundMessage);
				} catch (error) {
					vscode.window.showErrorMessage(`File Grid Open: could not save: ${(error as Error).message}`);
				}
				return;
			}
			case 'browse': {
				const picked = await vscode.window.showOpenDialog({
					defaultUri: vscode.Uri.file(os.homedir()),
					canSelectMany: false,
					openLabel: 'Select File'
				});
				const file = picked?.[0];
				if (!file) {
					return;
				}

				const outbound: OutboundMessage = {
					type: 'browseResult',
					setId: message.setId,
					pathIndex: message.pathIndex,
					path: file.fsPath
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
	};

	panel.webview.onDidReceiveMessage(async (raw: unknown) => {
		try {
			await handleMessage(raw);
		} catch (error) {
			vscode.window.showErrorMessage(`File Grid Open: ${error instanceof Error ? error.message : 'unexpected error.'}`);
		}
	});

	panel.onDidDispose(() => {
		activePanel = undefined;
		activeConfigPathGetter = undefined;
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

function getHtml(configPath: string, fileSets: FileSet[], focusSetId: string | undefined, missing: string[], initialError: string | undefined): string {
	const nonce = getNonce();
	const initialPath = JSON.stringify(configPath).replace(/</g, '\\u003c');
	const initialFocus = JSON.stringify(focusSetId ?? null).replace(/</g, '\\u003c');
	const initialMissing = JSON.stringify(missing).replace(/</g, '\\u003c');
	const initialState = JSON.stringify(fileSets).replace(/</g, '\\u003c');
	const initialInvalid = JSON.stringify(initialError ?? null).replace(/</g, '\\u003c');

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
	// The config path the page's state was loaded from; every save carries it so the extension can refuse a mismatch.
	let loadedPath = ${initialPath};
	let collisionCells = [];
	let missingPaths = new Set(${initialMissing});
	// While the config file cannot be read the page shows only the error and never saves.
	let invalidMessage = ${initialInvalid};

	// Shared with the extension (src/core/setLogic.ts) so the logic is tested once.
	${uniqueName.toString()}
	${moveItem.toString()}

	// A non-negative whole number that survives a JSON round trip (rejects "-1", "1.5", "1e400").
	function isWholeNumber(text) { return /^[0-9]+$/.test(text) && Number.isSafeInteger(Number(text)); }

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
		if (invalidMessage !== null) { return; }
		clearTimeout(saveTimer);
		editVersion++;
		const version = editVersion;
		saveTimer = setTimeout(() => {
			vscode.postMessage({ type: 'save', fileSets, auto: true, version, configPath: loadedPath });
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
		document.getElementById('addSet').disabled = invalidMessage !== null;
		if (invalidMessage !== null) {
			setStatus('The configuration file cannot be read, so editing is disabled until it is fixed:\\n' + invalidMessage, 'error');
			return;
		}

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
				el('label', { title: 'Open this set automatically when a window starts (in every window)' }, [openOnStartupInput, document.createTextNode('Open on startup')]),
				el('label', { title: 'Show this set as a button in the status bar' }, [pinnedInput, document.createTextNode('Pin to status bar')]),
				el('label', { title: 'Sidebar folder this set is listed under' }, [document.createTextNode('Group'), groupInput])
			]);

			const setEl = el('div', { className: 'set' }, [header, options]);
			setEl.dataset.setIndex = String(setIndex);

			set.paths.forEach((entry, pathIndex) => {
				const pathInput = el('input', { type: 'text', value: entry.path, placeholder: '/absolute/path or ~/path' });
				pathInput.style.flex = '1';
				pathInput.addEventListener('input', () => { fileSets[setIndex].paths[pathIndex].path = pathInput.value; scheduleSave(); });

				const browseBtn = el('button', { className: 'secondary', textContent: 'Browse...' });
				browseBtn.addEventListener('click', () => {
					vscode.postMessage({ type: 'browse', setId: set.id, pathIndex });
				});

				const colInput = el('input', { type: 'number', min: '0', value: entry.column !== undefined ? String(entry.column) : '' });
				colInput.addEventListener('input', () => {
					const v = colInput.value.trim();
					// Only a non-negative whole number is valid in the config file; anything else clears the value.
					if (isWholeNumber(v)) { fileSets[setIndex].paths[pathIndex].column = Number(v); } else { delete fileSets[setIndex].paths[pathIndex].column; }
					collisionCells = [];
					setStatus('', '');
					scheduleSave();
				});

				const rowInput = el('input', { type: 'number', min: '0', value: entry.row !== undefined ? String(entry.row) : '' });
				rowInput.addEventListener('input', () => {
					const v = rowInput.value.trim();
					if (isWholeNumber(v)) { fileSets[setIndex].paths[pathIndex].row = Number(v); } else { delete fileSets[setIndex].paths[pathIndex].row; }
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
		if (invalidMessage !== null) { return; }
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
			// The sets may have been replaced while the dialog was open; ignore a result whose target is gone.
			const target = fileSets.find((set) => set.id === message.setId);
			if (target && target.paths[message.pathIndex]) {
				target.paths[message.pathIndex].path = message.path;
				render();
				scheduleSave();
			}
		} else if (message.type === 'focusSet') {
			focusSet(message.id);
		} else if (message.type === 'saved') {
			// A confirmation for a save made before the path changed says nothing about the current file.
			if (message.configPath !== loadedPath) { return; }
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
		} else if (message.type === 'invalid') {
			clearTimeout(saveTimer);
			loadedPath = message.configPath;
			invalidMessage = message.message;
			render();
		} else if (message.type === 'pathChanged') {
			// The config path changed: drop pending edits (they belong to the old file) and show the new file.
			clearTimeout(saveTimer);
			editVersion = 0;
			savedVersion = 0;
			loadedPath = message.configPath;
			invalidMessage = null;
			fileSets = message.fileSets;
			collisionCells = [];
			missingPaths = new Set(message.missing);
			setStatus('The configuration path changed; showing the file at the new path.', '');
			render();
		} else if (message.type === 'reload') {
			const wasInvalid = invalidMessage !== null;
			if (message.configPath === loadedPath && !wasInvalid && (editVersion !== savedVersion || snapshot(message.fileSets) === snapshot(fileSets))) {
				return;
			}
			if (message.configPath !== loadedPath) {
				// Different file: pending edits are for the old path and must not be saved anywhere.
				clearTimeout(saveTimer);
				savedVersion = editVersion;
				loadedPath = message.configPath;
			}
			invalidMessage = null;
			editVersion = savedVersion;
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

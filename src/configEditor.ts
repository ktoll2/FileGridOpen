import * as path from 'path';
import * as vscode from 'vscode';
import { FileSet, ensureConfigFile, readFileSets, writeFileSets } from './config';
import { findCollisions } from './layout';

type InboundMessage =
	| { type: 'save'; fileSets: FileSet[] }
	| { type: 'browse'; setIndex: number; pathIndex: number }
	| { type: 'openJson' };

type OutboundMessage =
	| { type: 'browseResult'; setIndex: number; pathIndex: number; path: string }
	| { type: 'saved' }
	| { type: 'saveRejected'; messages: string[]; cells: { setIndex: number; pathIndex: number }[] };

let activePanel: vscode.WebviewPanel | undefined;

/**
 * Opens (or reveals) a form-based editor for the file sets in a config file, as an alternative to
 * hand-editing the JSON. Only one instance is kept open at a time since there's one config file
 * per workspace folder.
 */
export function openConfigEditor(
	folder: vscode.WorkspaceFolder,
	configPath: string,
	openJson: () => Promise<void>
): void {
	if (activePanel) {
		activePanel.reveal();
		return;
	}

	try {
		ensureConfigFile(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`FileGridOpen: could not create ${configPath}: ${(error as Error).message}`);
		return;
	}

	const panel = vscode.window.createWebviewPanel('fileGridOpenConfigEditor', 'FileGridOpen: Configuration', vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true
	});
	activePanel = panel;

	let fileSets: FileSet[];
	try {
		fileSets = readFileSets(configPath);
	} catch (error) {
		vscode.window.showErrorMessage(`FileGridOpen: ${(error as Error).message}`);
		fileSets = [];
	}

	panel.webview.html = getHtml(fileSets);

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
					vscode.window.showErrorMessage(
						`FileGridOpen: not saved - fix these column/row conflicts first:\n${collisionMessages.join('\n')}`
					);
					return;
				}

				try {
					writeFileSets(configPath, message.fileSets);
					vscode.window.setStatusBarMessage('FileGridOpen: configuration saved.', 2000);
					panel.webview.postMessage({ type: 'saved' } satisfies OutboundMessage);
				} catch (error) {
					vscode.window.showErrorMessage(`FileGridOpen: could not save: ${(error as Error).message}`);
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
			case 'openJson':
				await openJson();
				return;
		}
	});

	panel.onDidDispose(() => {
		activePanel = undefined;
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

function getHtml(fileSets: FileSet[]): string {
	const nonce = getNonce();
	const initialState = JSON.stringify(fileSets).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>FileGridOpen Configuration</title>
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
	<div class="hint">Column/row are optional. No column/row: files open left to right. A shared column with different rows creates a vertical split within that column.</div>
	<div class="toolbar">
		<button id="addSet">+ Add File Set</button>
		<button id="save">Save</button>
		<button id="openJson" class="secondary">Edit as JSON</button>
	</div>
	<div id="status" class="status"></div>
	<div id="sets"></div>
<script nonce="${nonce}">
(function () {
	const vscode = acquireVsCodeApi();
	let fileSets = ${initialState};
	let collisionCells = [];

	function cellKey(setIndex, pathIndex) { return setIndex + ':' + pathIndex; }

	function setStatus(text, kind) {
		const status = document.getElementById('status');
		status.textContent = text;
		status.className = 'status' + (kind ? ' ' + kind : '');
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

		if (fileSets.length === 0) {
			container.appendChild(el('div', { className: 'empty', textContent: 'No file sets yet. Click "Add File Set" to create one.' }));
		}

		fileSets.forEach((set, setIndex) => {
			const nameInput = el('input', { type: 'text', value: set.name, placeholder: 'Set name' });
			nameInput.addEventListener('input', () => { fileSets[setIndex].name = nameInput.value; });

			const removeSetBtn = el('button', { className: 'secondary', textContent: 'Remove Set' });
			removeSetBtn.addEventListener('click', () => { fileSets.splice(setIndex, 1); render(); });

			const header = el('div', { className: 'set-header' }, [nameInput, removeSetBtn]);
			const setEl = el('div', { className: 'set' }, [header]);

			set.paths.forEach((entry, pathIndex) => {
				const pathInput = el('input', { type: 'text', value: entry.path, placeholder: 'relative/or/absolute/path' });
				pathInput.style.flex = '1';
				pathInput.addEventListener('input', () => { fileSets[setIndex].paths[pathIndex].path = pathInput.value; });

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
				});

				const rowInput = el('input', { type: 'number', min: '0', value: entry.row !== undefined ? String(entry.row) : '' });
				rowInput.addEventListener('input', () => {
					const v = rowInput.value.trim();
					fileSets[setIndex].paths[pathIndex].row = v === '' ? undefined : Number(v);
					collisionCells = [];
					setStatus('', '');
				});

				const removePathBtn = el('button', { className: 'secondary icon', textContent: '✕', title: 'Remove file' });
				removePathBtn.addEventListener('click', () => { fileSets[setIndex].paths.splice(pathIndex, 1); render(); });

				const isColliding = collisionCells.indexOf(cellKey(setIndex, pathIndex)) !== -1;
				const row = el('div', { className: 'path-row' + (isColliding ? ' collision' : '') }, [
					pathInput,
					browseBtn,
					el('label', { textContent: 'col' }),
					colInput,
					el('label', { textContent: 'row' }),
					rowInput,
					removePathBtn
				]);
				setEl.appendChild(row);
			});

			const addPathBtn = el('button', { className: 'add-path', textContent: '+ Add File' });
			addPathBtn.addEventListener('click', () => { fileSets[setIndex].paths.push({ path: '' }); render(); });
			setEl.appendChild(addPathBtn);

			container.appendChild(setEl);
		});
	}

	document.getElementById('addSet').addEventListener('click', () => {
		fileSets.push({ name: 'New set', paths: [] });
		render();
	});

	document.getElementById('save').addEventListener('click', () => {
		vscode.postMessage({ type: 'save', fileSets });
	});

	document.getElementById('openJson').addEventListener('click', () => {
		vscode.postMessage({ type: 'openJson' });
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message.type === 'browseResult') {
			fileSets[message.setIndex].paths[message.pathIndex].path = message.path;
			render();
		} else if (message.type === 'saved') {
			collisionCells = [];
			setStatus('Saved.', 'success');
			render();
		} else if (message.type === 'saveRejected') {
			collisionCells = message.cells.map((c) => cellKey(c.setIndex, c.pathIndex));
			setStatus(message.messages.join('\\n'), 'error');
			render();
		}
	});

	render();
})();
</script>
</body>
</html>`;
}

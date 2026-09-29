import * as vscode from 'vscode';
import { getDefaultConfigPath, resolveConfiguredPath } from './core/configPaths';

export { FileSet, FileSetPathEntry, ensureConfigFile, readFileSets, writeFileSets } from './core/configFile';

/**
 * Resolves the on-disk location of a workspace folder's config file: the "fileGridOpen.configPath"
 * setting when set (expanding a leading "~" and resolving a relative path against the workspace
 * folder), otherwise the default per-user config directory.
 */
export function getConfigPath(folder: vscode.WorkspaceFolder): string {
	const override = vscode.workspace.getConfiguration('fileGridOpen', folder).get<string>('configPath', '').trim();
	return override ? resolveConfiguredPath(override, folder.uri.fsPath) : getDefaultConfigPath(folder.uri.fsPath);
}

/** The first workspace folder, which owns the config file. Undefined when no folder is open. */
export function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.[0];
}

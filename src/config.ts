import * as os from 'os';
import * as vscode from 'vscode';
import { getDefaultConfigPath, resolveConfiguredPath } from './core/configPaths';

export {
	FileSet,
	FileSetPathEntry,
	ensureConfigFile,
	newFileSetId,
	parseFileSets,
	readFileSets,
	readFileSetsEnsuringIds,
	serializeFileSet,
	withIds,
	writeFileSets
} from './core/configFile';

/*
 * Resolves the on-disk location of the one global config file: the "fileGridOpen.configPath" setting
 * when set (expanding a leading "~" and resolving a relative path against the home directory),
 * otherwise the default per-user config directory.
 */
export function getConfigPath(): string {
	const value: unknown = vscode.workspace.getConfiguration('fileGridOpen').get<unknown>('configPath', '');
	// A non-string setting value (bad settings.json) counts as unset.
	const override: string = typeof value === 'string' ? value.trim() : '';
	return override ? resolveConfiguredPath(override, os.homedir()) : getDefaultConfigPath();
}

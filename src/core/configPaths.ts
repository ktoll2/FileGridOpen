import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

/** The user-level directory file-grid-open stores its config under, independent of any project. */
export function getConfigDirectory(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
	if (platform === 'win32') {
		return path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'file-grid-open');
	}

	if (platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', 'file-grid-open');
	}

	return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'file-grid-open');
}

/**
 * The default on-disk location of a workspace folder's config file, under the user's config
 * directory rather than inside the project itself. Named from the folder's basename plus a short
 * hash of its full path, so same-named folders in different locations don't collide.
 */
export function getDefaultConfigPath(folderPath: string): string {
	const slug = path.basename(folderPath).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'workspace';
	const hash = crypto.createHash('sha256').update(folderPath).digest('hex').slice(0, 12);
	return path.join(getConfigDirectory(), 'workspaces', `${slug}-${hash}.json`);
}

/** Expands a leading "~" and resolves a relative path against a workspace folder. */
export function resolveConfiguredPath(configuredPath: string, folderPath: string): string {
	const expanded = configuredPath.startsWith('~') ? path.join(os.homedir(), configuredPath.slice(1)) : configuredPath;
	return path.isAbsolute(expanded) ? expanded : path.join(folderPath, expanded);
}

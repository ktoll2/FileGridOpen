import * as os from 'os';
import * as path from 'path';

/* The env value if it is a non-empty absolute path (per the XDG spec, anything else is ignored). */
function absoluteEnvPath(value: string | undefined, isAbsolute: (p: string) => boolean): string | undefined {
	return value !== undefined && value !== '' && isAbsolute(value) ? value : undefined;
}

/* The user-level directory File Grid Open stores its config under, independent of any project. */
export function getConfigDirectory(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
	if (platform === 'win32') {
		// Judged by Windows rules whatever the host, since the value is a Windows path.
		const appData: string | undefined = absoluteEnvPath(env.APPDATA, path.win32.isAbsolute);
		return path.join(appData ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'FileGridOpen');
	}

	if (platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', 'FileGridOpen');
	}

	const xdgConfigHome: string | undefined = absoluteEnvPath(env.XDG_CONFIG_HOME, path.isAbsolute);
	return path.join(xdgConfigHome ?? path.join(os.homedir(), '.config'), 'FileGridOpen');
}

/* The default on-disk location of the single, global config file. */
export function getDefaultConfigPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
	return path.join(getConfigDirectory(platform, env), 'sets.json');
}

/* Expands "~" (alone, or followed by "/" or "\\") to the home directory; any other path is returned unchanged. */
export function expandHome(filePath: string): string {
	if (filePath === '~' || filePath.startsWith('~/') || filePath.startsWith('~\\')) {
		return path.join(os.homedir(), filePath.slice(1));
	}
	return filePath;
}

/* Expands a leading "~" and resolves a relative path against baseDir. */
export function resolveConfiguredPath(configuredPath: string, baseDir: string): string {
	const expanded: string = expandHome(configuredPath);
	return path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded);
}

import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { expandHome, getConfigDirectory, getDefaultConfigPath, resolveConfiguredPath } from '../core/configPaths';

// getConfigDirectory joins with the platform-native `path` module, so expectations below are
// built with the same `path.join` rather than hardcoded separators - this suite only checks which
// base directory and env var get chosen, not the host OS's own separator convention.

test('getConfigDirectory: Linux uses XDG_CONFIG_HOME when set', () => {
	const dir = getConfigDirectory('linux', { XDG_CONFIG_HOME: '/custom/config' });
	assert.equal(dir, path.join('/custom/config', 'FileGridOpen'));
});

test('getConfigDirectory: Linux falls back to ~/.config', () => {
	const dir = getConfigDirectory('linux', {});
	assert.equal(dir, path.join(os.homedir(), '.config', 'FileGridOpen'));
});

test('getConfigDirectory: macOS uses Application Support', () => {
	const dir = getConfigDirectory('darwin', {});
	assert.equal(dir, path.join(os.homedir(), 'Library', 'Application Support', 'FileGridOpen'));
});

test('getConfigDirectory: Windows uses APPDATA when set', () => {
	const dir = getConfigDirectory('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });
	assert.equal(dir, path.join('C:\\Users\\me\\AppData\\Roaming', 'FileGridOpen'));
});

// New contract (spec 3.1): getDefaultConfigPath(platform?, env?) takes no folder. Cast so the
// file compiles regardless of the declared signature.
const defaultConfigPath = getDefaultConfigPath as unknown as (platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv) => string;

test('getDefaultConfigPath: Linux with XDG_CONFIG_HOME is <configDir>/sets.json', () => {
	const p: string = defaultConfigPath('linux', { XDG_CONFIG_HOME: '/custom/config' });
	assert.equal(p, path.join('/custom/config', 'FileGridOpen', 'sets.json'));
});

test('getDefaultConfigPath: Linux fallback is ~/.config/FileGridOpen/sets.json', () => {
	const p: string = defaultConfigPath('linux', {});
	assert.equal(p, path.join(os.homedir(), '.config', 'FileGridOpen', 'sets.json'));
});

test('getDefaultConfigPath: macOS is under Application Support', () => {
	const p: string = defaultConfigPath('darwin', {});
	assert.equal(p, path.join(os.homedir(), 'Library', 'Application Support', 'FileGridOpen', 'sets.json'));
});

test('getDefaultConfigPath: Windows uses APPDATA', () => {
	const p: string = defaultConfigPath('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });
	assert.equal(p, path.join('C:\\Users\\me\\AppData\\Roaming', 'FileGridOpen', 'sets.json'));
});

test('getDefaultConfigPath: equals getConfigDirectory joined with sets.json and has no workspaces part', () => {
	const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: '/x' };
	const p: string = defaultConfigPath('linux', env);
	assert.equal(p, path.join(getConfigDirectory('linux', env), 'sets.json'));
	assert.doesNotMatch(p, /workspaces/);
});

test('getDefaultConfigPath: is deterministic and the same single file every call', () => {
	assert.equal(defaultConfigPath('linux', { XDG_CONFIG_HOME: '/x' }), defaultConfigPath('linux', { XDG_CONFIG_HOME: '/x' }));
});

test('resolveConfiguredPath: an absolute path is used as-is', () => {
	assert.equal(resolveConfiguredPath('/custom/sets.json', '/home/me'), '/custom/sets.json');
});

test('resolveConfiguredPath: a leading "~" expands to the home directory', () => {
	assert.equal(resolveConfiguredPath('~/my-configs/sets.json', '/home/me'), `${os.homedir()}/my-configs/sets.json`);
});

test('expandHome: a lone "~" is the home directory', () => {
	assert.equal(expandHome('~'), os.homedir());
});

test('expandHome: "~/" and "~\\" prefixes expand to the home directory', () => {
	assert.equal(expandHome('~/a/b.txt'), path.join(os.homedir(), 'a', 'b.txt'));
	const backslash: string = expandHome('~\\a\\b.txt');
	assert.ok(backslash.startsWith(os.homedir()));
	assert.ok(!backslash.includes('~'));
});

test('expandHome: "~foo", "a~b", "~~" and ordinary paths are returned unchanged', () => {
	for (const p of ['~foo', '~foo/sets.json', 'a~b', '~~', '~~/x', '/abs/path', 'rel/path', '']) {
		assert.equal(expandHome(p), p);
	}
});

test('resolveConfiguredPath: "~foo/sets.json" is relative and resolves against baseDir', () => {
	assert.equal(resolveConfiguredPath('~foo/sets.json', '/base'), path.join('/base', '~foo', 'sets.json'));
});

test('resolveConfiguredPath: "~/sets.json" resolves against the home directory, not baseDir', () => {
	assert.equal(resolveConfiguredPath('~/sets.json', '/base'), path.join(os.homedir(), 'sets.json'));
});

test('resolveConfiguredPath: "~~" and "a~b" are relative to baseDir', () => {
	assert.equal(resolveConfiguredPath('~~', '/base'), path.join('/base', '~~'));
	assert.equal(resolveConfiguredPath('a~b/sets.json', '/base'), path.join('/base', 'a~b', 'sets.json'));
});

test('resolveConfiguredPath: a lone "~" is the home directory', () => {
	assert.equal(resolveConfiguredPath('~', '/base'), os.homedir());
});

// XDG Base Directory: an empty or non-absolute environment value must be ignored.
test('getConfigDirectory: Linux ignores an empty XDG_CONFIG_HOME', () => {
	assert.equal(getConfigDirectory('linux', { XDG_CONFIG_HOME: '' }), path.join(os.homedir(), '.config', 'FileGridOpen'));
});

test('getConfigDirectory: Linux ignores a relative XDG_CONFIG_HOME', () => {
	assert.equal(getConfigDirectory('linux', { XDG_CONFIG_HOME: 'relative/dir' }), path.join(os.homedir(), '.config', 'FileGridOpen'));
});

test('getConfigDirectory: Linux still uses a valid absolute XDG_CONFIG_HOME', () => {
	const abs: string = path.resolve(path.sep, 'xdg', 'cfg');
	assert.equal(getConfigDirectory('linux', { XDG_CONFIG_HOME: abs }), path.join(abs, 'FileGridOpen'));
});

test('getConfigDirectory: Windows ignores an empty APPDATA', () => {
	assert.equal(getConfigDirectory('win32', { APPDATA: '' }), path.join(os.homedir(), 'AppData', 'Roaming', 'FileGridOpen'));
});

test('getConfigDirectory: Windows ignores a relative APPDATA', () => {
	assert.equal(getConfigDirectory('win32', { APPDATA: 'relative\\dir' }), path.join(os.homedir(), 'AppData', 'Roaming', 'FileGridOpen'));
});

test('getConfigDirectory: Windows still uses a valid absolute APPDATA', () => {
	const abs: string = path.resolve(path.sep, 'appdata', 'roaming');
	assert.equal(getConfigDirectory('win32', { APPDATA: abs }), path.join(abs, 'FileGridOpen'));
});

test('getConfigDirectory: macOS ignores XDG_CONFIG_HOME and APPDATA', () => {
	const abs: string = path.resolve(path.sep, 'somewhere');
	assert.equal(
		getConfigDirectory('darwin', { XDG_CONFIG_HOME: abs, APPDATA: abs }),
		path.join(os.homedir(), 'Library', 'Application Support', 'FileGridOpen')
	);
});

test('getDefaultConfigPath: ends with sets.json and applies the same env validation', () => {
	const abs: string = path.resolve(path.sep, 'xdg', 'cfg');
	const fallbackLinux: string = path.join(os.homedir(), '.config', 'FileGridOpen', 'sets.json');
	const cases: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; expected: string }[] = [
		{ platform: 'linux', env: { XDG_CONFIG_HOME: '' }, expected: fallbackLinux },
		{ platform: 'linux', env: { XDG_CONFIG_HOME: 'relative/dir' }, expected: fallbackLinux },
		{ platform: 'linux', env: { XDG_CONFIG_HOME: abs }, expected: path.join(abs, 'FileGridOpen', 'sets.json') },
		{ platform: 'win32', env: { APPDATA: '' }, expected: path.join(os.homedir(), 'AppData', 'Roaming', 'FileGridOpen', 'sets.json') },
		{ platform: 'win32', env: { APPDATA: abs }, expected: path.join(abs, 'FileGridOpen', 'sets.json') },
		{
			platform: 'darwin',
			env: { XDG_CONFIG_HOME: abs, APPDATA: abs },
			expected: path.join(os.homedir(), 'Library', 'Application Support', 'FileGridOpen', 'sets.json')
		}
	];
	for (const c of cases) {
		const p: string = defaultConfigPath(c.platform, c.env);
		assert.equal(p, c.expected);
		assert.ok(p.endsWith('sets.json'));
	}
});

test('resolveConfiguredPath: a relative path resolves against the given baseDir', () => {
	assert.equal(resolveConfiguredPath('.file-grid-open/sets.json', '/home/me'), path.resolve('/home/me', '.file-grid-open/sets.json'));
	assert.equal(resolveConfiguredPath('sets.json', '/other/base'), path.resolve('/other/base', 'sets.json'));
});

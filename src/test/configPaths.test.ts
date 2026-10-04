import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getConfigDirectory, getDefaultConfigPath, resolveConfiguredPath } from '../core/configPaths';

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

test('getDefaultConfigPath: different folder paths never collide', () => {
	const a = getDefaultConfigPath('/home/me/project');
	const b = getDefaultConfigPath('/home/me/other-project');
	assert.notEqual(a, b);
});

test('getDefaultConfigPath: same-named folders in different locations do not collide', () => {
	const a = getDefaultConfigPath('/home/me/project');
	const b = getDefaultConfigPath('/home/you/project');
	assert.notEqual(a, b);
});

test('getDefaultConfigPath: is deterministic for the same folder path', () => {
	const a = getDefaultConfigPath('/home/me/project');
	const b = getDefaultConfigPath('/home/me/project');
	assert.equal(a, b);
});

test('getDefaultConfigPath: lands under a "workspaces" subdirectory as a .json file', () => {
	const p = getDefaultConfigPath('/home/me/project');
	assert.match(p, /[/\\]workspaces[/\\]project-[0-9a-f]{12}\.json$/);
});

test('resolveConfiguredPath: an absolute path is used as-is', () => {
	assert.equal(resolveConfiguredPath('/custom/sets.json', '/home/me/project'), '/custom/sets.json');
});

test('resolveConfiguredPath: a leading "~" expands to the home directory', () => {
	assert.equal(resolveConfiguredPath('~/my-configs/sets.json', '/home/me/project'), `${os.homedir()}/my-configs/sets.json`);
});

test('resolveConfiguredPath: a relative path resolves against the workspace folder', () => {
	assert.equal(resolveConfiguredPath('.file-grid-open/sets.json', '/home/me/project'), '/home/me/project/.file-grid-open/sets.json');
});

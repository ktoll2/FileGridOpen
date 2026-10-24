import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import * as configFileModule from '../core/configFile';
import { FileSet, ensureConfigFile, parseFileSets, readFileSets, readFileSetsEnsuringIds, writeFileSets } from '../core/configFile';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'file-grid-open-test-'));
let configPath: string;

beforeEach(() => {
	configPath = path.join(tmpRoot, `${Math.random().toString(36).slice(2)}`, 'sets.json');
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('readFileSets: a missing file returns an empty list rather than throwing', () => {
	assert.deepEqual(readFileSets(configPath), []);
});

test('readFileSets: accepts a plain string path entry', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify([{ name: 'Set', paths: ['a.ts'] }]));
	assert.deepEqual(readFileSets(configPath), [{ name: 'Set', paths: [{ path: 'a.ts' }] }]);
});

test('readFileSets: accepts an object path entry with column/row', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify([{ name: 'Set', paths: [{ path: 'a.ts', column: 1, row: 2 }] }]));
	assert.deepEqual(readFileSets(configPath), [{ name: 'Set', paths: [{ path: 'a.ts', column: 1, row: 2 }] }]);
});

test('readFileSets: rejects a non-array top level', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({ not: 'an array' }));
	assert.throws(() => readFileSets(configPath), /must contain a JSON array/);
});

test('readFileSets: rejects a set missing "name" or "paths"', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify([{ paths: ['a.ts'] }]));
	assert.throws(() => readFileSets(configPath), /must be an object with "name" and "paths"/);
});

test('readFileSets: rejects a path entry that is neither a string nor an object with "path"', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify([{ name: 'Set', paths: [42] }]));
	assert.throws(() => readFileSets(configPath), /must be a string or an object with a "path" string/);
});

test('readFileSets: accepts column/row 0', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify([{ name: 'Set', paths: [{ path: 'a.ts', column: 0, row: 0 }] }]));
	assert.deepEqual(readFileSets(configPath), [{ name: 'Set', paths: [{ path: 'a.ts', column: 0, row: 0 }] }]);
});

test('readFileSets: rejects a negative or non-integer column or row', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify([{ name: 'Set', paths: [{ path: 'a.ts', column: -1 }] }]));
	assert.throws(() => readFileSets(configPath), /"column" must be a non-negative integer/);
});

test('ensureConfigFile: creates the file and its parent directory as an empty array', () => {
	assert.equal(fs.existsSync(path.dirname(configPath)), false);
	assert.equal(fs.existsSync(configPath), false);
	ensureConfigFile(configPath);
	assert.equal(fs.existsSync(path.dirname(configPath)), true);
	assert.equal(fs.existsSync(configPath), true);
	const text: string = fs.readFileSync(configPath, 'utf8');
	assert.deepEqual(JSON.parse(text), []);
	assert.ok(text.endsWith('\n'));
	assert.deepEqual(readFileSets(configPath), []);
});

test('ensureConfigFile: calling it twice leaves the file unchanged', () => {
	ensureConfigFile(configPath);
	const first: string = fs.readFileSync(configPath, 'utf8');
	ensureConfigFile(configPath);
	const second: string = fs.readFileSync(configPath, 'utf8');
	assert.equal(second, first);
	assert.deepEqual(JSON.parse(second), []);
});

test('ensureConfigFile: does not overwrite an existing file', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify([{ name: 'Mine', paths: ['keep.ts'] }]));
	ensureConfigFile(configPath);
	assert.deepEqual(readFileSets(configPath), [{ name: 'Mine', paths: [{ path: 'keep.ts' }] }]);
});

test('writeFileSets then readFileSets round-trips, omitting unset column/row', () => {
	writeFileSets(configPath, [
		{
			name: 'Set',
			paths: [{ path: 'a.ts', column: 1, row: 2 }, { path: 'b.ts' }]
		}
	]);
	assert.deepEqual(readFileSets(configPath), [
		{
			name: 'Set',
			paths: [{ path: 'a.ts', column: 1, row: 2 }, { path: 'b.ts' }]
		}
	]);

	const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
	assert.deepEqual(Object.keys(onDisk[0].paths[1]), ['path']);
});

test('ensureConfigFile: new file content is exactly "[]" plus a newline', () => {
	ensureConfigFile(configPath);
	assert.equal(fs.readFileSync(configPath, 'utf8'), '[]\n');
});

test('ensureConfigFile: repeated calls never overwrite an existing file with content', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	const original: string = '[ {"name":"Mine","paths":["keep.ts"]} ]';
	fs.writeFileSync(configPath, original);
	for (let i = 0; i < 3; i++) {
		ensureConfigFile(configPath);
	}
	assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

test('writeFileSets: leaves only the target file in the directory (no temp files)', () => {
	writeFileSets(configPath, [{ id: 'a', name: 'A', paths: [{ path: 'a.ts' }] }]);
	writeFileSets(configPath, [{ id: 'b', name: 'B', paths: [] }]);
	assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['sets.json']);
});

test('writeFileSets: writing over an existing file replaces its content completely', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify([{ name: 'Old', paths: ['x'.repeat(5000)] }], null, 2));
	writeFileSets(configPath, [{ id: 'n', name: 'New', paths: [] }]);
	assert.deepEqual(readFileSets(configPath), [{ id: 'n', name: 'New', paths: [] }]);
	assert.equal(fs.readFileSync(configPath, 'utf8'), JSON.stringify([{ id: 'n', name: 'New', paths: [] }], null, 2) + '\n');
});

test('writeFileSets: output is 2-space JSON with a trailing newline and spec key order', () => {
	writeFileSets(configPath, [
		{
			id: 'i',
			name: 'N',
			group: 'G',
			closeOthers: true,
			openOnStartup: true,
			pinned: true,
			paths: [{ path: 'p', column: 1, row: 2, newest: 3 }]
		}
	]);
	const text: string = fs.readFileSync(configPath, 'utf8');
	assert.ok(text.endsWith('}\n]\n'));
	assert.ok(text.startsWith('[\n  {\n    "id": "i",\n    "name": "N",'));
	const onDisk = JSON.parse(text);
	assert.deepEqual(Object.keys(onDisk[0]), ['id', 'name', 'group', 'closeOthers', 'openOnStartup', 'pinned', 'paths']);
	assert.deepEqual(Object.keys(onDisk[0].paths[0]), ['path', 'column', 'row', 'newest']);
	assert.equal(text, JSON.stringify(onDisk, null, 2) + '\n');
});

test('writeFileSets: an empty list is written as "[]" plus a newline', () => {
	writeFileSets(configPath, []);
	assert.equal(fs.readFileSync(configPath, 'utf8'), '[]\n');
});

test('writeFileSets: creates a missing (nested) parent directory', () => {
	const nested: string = path.join(path.dirname(configPath), 'deep', 'er', 'sets.json');
	assert.equal(fs.existsSync(path.dirname(nested)), false);
	writeFileSets(nested, [{ id: 'a', name: 'A', paths: [] }]);
	assert.deepEqual(readFileSets(nested), [{ id: 'a', name: 'A', paths: [] }]);
	assert.deepEqual(fs.readdirSync(path.dirname(nested)), ['sets.json']);
});

test('writeFileSets: writing the same content twice yields identical files', () => {
	const sets = [{ id: 'a', name: 'A', group: 'G', paths: [{ path: 'a.ts', column: 0 }, { path: 'b.ts' }] }];
	writeFileSets(configPath, sets);
	const first: string = fs.readFileSync(configPath, 'utf8');
	writeFileSets(configPath, sets);
	const second: string = fs.readFileSync(configPath, 'utf8');
	assert.equal(second, first);
	assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['sets.json']);
});

test('writeFileSets then readFileSets preserves a set id', () => {
	writeFileSets(configPath, [{ id: 'abc', name: 'Set', paths: [] }]);
	assert.deepEqual(readFileSets(configPath), [{ id: 'abc', name: 'Set', paths: [] }]);
});

test('readFileSetsEnsuringIds: generates unique ids for sets without one and persists them', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify([{ id: 'keep', name: 'A', paths: [] }, { name: 'B', paths: [] }, { name: 'B', paths: [] }]));

	const first = readFileSetsEnsuringIds(configPath);
	assert.equal(first[0].id, 'keep');
	assert.ok(first[1].id && first[2].id && first[1].id !== first[2].id);

	// A second read returns the same ids, i.e. they were written back to disk.
	assert.deepEqual(readFileSetsEnsuringIds(configPath), first);
});

test('closeOthers / openOnStartup / pinned: round-trip when true, are omitted when false or unset', () => {
	writeFileSets(configPath, [
		{ name: 'On', closeOthers: true, openOnStartup: true, pinned: true, paths: [] },
		{ name: 'Off', closeOthers: false, paths: [] }
	]);
	assert.deepEqual(readFileSets(configPath), [
		{ name: 'On', closeOthers: true, openOnStartup: true, pinned: true, paths: [] },
		{ name: 'Off', paths: [] }
	]);

	const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
	assert.deepEqual(Object.keys(onDisk[1]), ['name', 'paths']);
});

test('readFileSets: rejects a non-boolean closeOthers or openOnStartup', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify([{ name: 'Set', openOnStartup: 'yes', paths: [] }]));
	assert.throws(() => readFileSets(configPath), /"openOnStartup" must be true or false/);
});

/* Creates a symlink at linkPath pointing to targetPath; returns false if the platform forbids symlinks. */
function trySymlink(targetPath: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(targetPath, linkPath, 'file');
		return true;
	} catch {
		return false;
	}
}

test('writeFileSets: through a symlinked config path keeps the symlink and updates the real file', (t) => {
	const base: string = path.dirname(configPath);
	const realDir: string = path.join(base, 'real');
	const linkDir: string = path.join(base, 'link');
	fs.mkdirSync(realDir, { recursive: true });
	fs.mkdirSync(linkDir, { recursive: true });
	const realPath: string = path.join(realDir, 'sets.json');
	const linkPath: string = path.join(linkDir, 'sets.json');
	fs.writeFileSync(realPath, JSON.stringify([{ name: 'Old', paths: [] }]));
	if (!trySymlink(realPath, linkPath)) {
		t.skip('symlinks are not supported on this platform');
		return;
	}

	const sets = [{ id: 'n', name: 'New', paths: [{ path: 'a.ts', column: 1 }] }];
	writeFileSets(linkPath, sets);

	assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
	assert.equal(fs.readFileSync(realPath, 'utf8'), JSON.stringify(sets, null, 2) + '\n');
	assert.deepEqual(readFileSets(linkPath), sets);
	assert.deepEqual(fs.readdirSync(realDir), ['sets.json']);
	assert.deepEqual(fs.readdirSync(linkDir), ['sets.json']);
});

test('writeFileSets: through a symlink into another directory leaves only the real file in the target directory', (t) => {
	const base: string = path.dirname(configPath);
	const realDir: string = path.join(base, 'synced', 'dotfiles');
	const linkDir: string = path.join(base, 'config');
	fs.mkdirSync(realDir, { recursive: true });
	fs.mkdirSync(linkDir, { recursive: true });
	const realPath: string = path.join(realDir, 'real-sets.json');
	const linkPath: string = path.join(linkDir, 'sets.json');
	fs.writeFileSync(realPath, '[]\n');
	if (!trySymlink(realPath, linkPath)) {
		t.skip('symlinks are not supported on this platform');
		return;
	}

	writeFileSets(linkPath, [{ id: 'x', name: 'X', paths: [] }]);

	assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
	assert.deepEqual(fs.readdirSync(realDir), ['real-sets.json']);
	assert.deepEqual(fs.readdirSync(linkDir), ['sets.json']);
	assert.deepEqual(JSON.parse(fs.readFileSync(realPath, 'utf8')), [{ id: 'x', name: 'X', paths: [] }]);
});

test('writeFileSets: over a plain existing file leaves a regular file and no temp files', () => {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, '[]\n');
	writeFileSets(configPath, [{ id: 'p', name: 'P', paths: [] }]);
	assert.equal(fs.lstatSync(configPath).isSymbolicLink(), false);
	assert.equal(fs.lstatSync(configPath).isFile(), true);
	assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['sets.json']);
	assert.deepEqual(readFileSets(configPath), [{ id: 'p', name: 'P', paths: [] }]);
});

test('writeFileSets: through a dangling symlink keeps the symlink and creates the target', (t) => {
	const base: string = path.dirname(configPath);
	const realDir: string = path.join(base, 'real');
	const linkDir: string = path.join(base, 'link');
	fs.mkdirSync(realDir, { recursive: true });
	fs.mkdirSync(linkDir, { recursive: true });
	const realPath: string = path.join(realDir, 'sets.json');
	const linkPath: string = path.join(linkDir, 'sets.json');
	if (!trySymlink(realPath, linkPath)) {
		t.skip('symlinks are not supported on this platform');
		return;
	}
	assert.equal(fs.existsSync(realPath), false);

	const sets = [{ id: 'd', name: 'Dangling', paths: [] }];
	writeFileSets(linkPath, sets);

	assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
	assert.deepEqual(readFileSets(linkPath), sets);
});

// parseFileSetsPayload is new (spec 3.3); accessed through a cast so the file compiles before it exists.
type PayloadResult = { fileSets: FileSet[] } | { error: string };
const parseFileSetsPayload: (payload: unknown) => PayloadResult = (
	configFileModule as unknown as { parseFileSetsPayload: (payload: unknown) => PayloadResult }
).parseFileSetsPayload;

function assertPayloadError(payload: unknown): void {
	const result: PayloadResult = parseFileSetsPayload(payload);
	assert.ok('error' in result, `expected an error for ${String(JSON.stringify(payload))}`);
	assert.ok(result.error.length > 0);
	assert.ok(result.error.startsWith('File Grid Open config'), result.error);
}

test('parseFileSetsPayload: an empty array is valid', () => {
	assert.deepEqual(parseFileSetsPayload([]), { fileSets: [] });
});

test('parseFileSetsPayload: valid input equals what parseFileSets returns', () => {
	const input: unknown[] = [
		{
			id: 'a',
			name: 'A',
			group: '  G  ',
			closeOthers: true,
			openOnStartup: false,
			pinned: true,
			unknown: 'dropped',
			paths: ['x.ts', { path: 'logs/*.log', column: 0, row: 2, newest: 3, extra: 1 }]
		},
		{ name: 'B', paths: [] }
	];
	const result: PayloadResult = parseFileSetsPayload(input);
	assert.deepEqual(result, { fileSets: parseFileSets(input) });
});

test('parseFileSetsPayload: normalizes strings to objects and drops unknown fields', () => {
	const result: PayloadResult = parseFileSetsPayload([{ name: 'S', junk: 1, paths: ['a.ts', { path: 'b.ts', junk: 2 }] }]);
	assert.deepEqual(result, { fileSets: [{ name: 'S', paths: [{ path: 'a.ts' }, { path: 'b.ts' }] }] });
});

test('parseFileSetsPayload: rejects non-array payloads without throwing', () => {
	for (const payload of [{ name: 'S', paths: [] }, 'text', null, undefined, 42]) {
		assertPayloadError(payload);
	}
});

test('parseFileSetsPayload: rejects a set that is not an object', () => {
	assertPayloadError(['str']);
	assertPayloadError([null]);
	assertPayloadError([42]);
});

test('parseFileSetsPayload: rejects a set lacking a string name', () => {
	assertPayloadError([{ paths: [] }]);
	assertPayloadError([{ name: 5, paths: [] }]);
});

test('parseFileSetsPayload: rejects a set lacking an array paths', () => {
	assertPayloadError([{ name: 'S' }]);
	assertPayloadError([{ name: 'S', paths: 'a.ts' }]);
});

test('parseFileSetsPayload: rejects an entry that is neither a string nor an object with a string path', () => {
	assertPayloadError([{ name: 'S', paths: [42] }]);
	assertPayloadError([{ name: 'S', paths: [null] }]);
	assertPayloadError([{ name: 'S', paths: [{}] }]);
	assertPayloadError([{ name: 'S', paths: [{ path: 5 }] }]);
});

test('parseFileSetsPayload: rejects an invalid column', () => {
	for (const column of [-1, 1.5, NaN, Infinity]) {
		assertPayloadError([{ name: 'S', paths: [{ path: 'a', column }] }]);
	}
});

test('parseFileSetsPayload: rejects an invalid row', () => {
	for (const row of [-1, 1.5, NaN, Infinity]) {
		assertPayloadError([{ name: 'S', paths: [{ path: 'a', row }] }]);
	}
});

test('parseFileSetsPayload: rejects an invalid newest', () => {
	for (const newest of [0, -1, 1.5, NaN, Infinity]) {
		assertPayloadError([{ name: 'S', paths: [{ path: 'a', newest }] }]);
	}
});

test('parseFileSetsPayload: rejects a non-string group', () => {
	assertPayloadError([{ name: 'S', group: 5, paths: [] }]);
	assertPayloadError([{ name: 'S', group: true, paths: [] }]);
});

test('parseFileSetsPayload: rejects a non-boolean flag', () => {
	for (const flag of ['closeOthers', 'openOnStartup', 'pinned']) {
		assertPayloadError([{ name: 'S', [flag]: 'yes', paths: [] }]);
		assertPayloadError([{ name: 'S', [flag]: 1, paths: [] }]);
	}
});

test('parseFileSetsPayload: accepts column/row 0 and newest 1', () => {
	assert.deepEqual(parseFileSetsPayload([{ name: 'S', paths: [{ path: 'a', column: 0, row: 0, newest: 1 }] }]), {
		fileSets: [{ name: 'S', paths: [{ path: 'a', column: 0, row: 0, newest: 1 }] }]
	});
});

test('path "newest" and set "group": round-trip, and invalid values are rejected', () => {
	writeFileSets(configPath, [{ name: 'S', group: 'G', paths: [{ path: 'logs/*.log', newest: 2 }] }]);
	assert.deepEqual(readFileSets(configPath), [{ name: 'S', group: 'G', paths: [{ path: 'logs/*.log', newest: 2 }] }]);

	fs.writeFileSync(configPath, JSON.stringify([{ name: 'S', paths: [{ path: 'a', newest: 0 }] }]));
	assert.throws(() => readFileSets(configPath), /"newest" must be a positive integer/);
	fs.writeFileSync(configPath, JSON.stringify([{ name: 'S', group: 5, paths: [] }]));
	assert.throws(() => readFileSets(configPath), /"group" must be a string/);
	fs.writeFileSync(configPath, JSON.stringify([{ name: 'S', group: '  ', paths: [] }]));
	assert.deepEqual(readFileSets(configPath), [{ name: 'S', paths: [] }]);
});

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { ensureConfigFile, readFileSets, writeFileSets } from '../core/configFile';

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

test('ensureConfigFile: creates the file and its parent directory with a starter example', () => {
	assert.equal(fs.existsSync(configPath), false);
	ensureConfigFile(configPath);
	assert.equal(fs.existsSync(configPath), true);
	const sets = readFileSets(configPath);
	assert.equal(sets.length, 1);
	assert.ok(sets[0].paths.length > 0);
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

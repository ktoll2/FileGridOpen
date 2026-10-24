import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { FileSet } from '../core/configFile';
import * as setLogicModule from '../core/setLogic';
import {
	duplicateFileSet,
	exportFileSet,
	addPathsToSet,
	assignGroup,
	groupNames,
	moveSetsIntoGroup,
	renameGroup,
	selectNewest,
	expandDateTokens,
	expandGlobEntry,
	findMissingPaths,
	importFileSets,
	isGlobPattern,
	moveFiles,
	naturalCompare,
	moveSets,
	layoutToPositions,
	moveItem,
	positionsToEntries,
	uniqueName
} from '../core/setLogic';

test('uniqueName: returns the base name when free, else the lowest free number from 2', () => {
	assert.equal(uniqueName('New set', []), 'New set');
	assert.equal(uniqueName('New set', ['New set']), 'New set 2');
	assert.equal(uniqueName('New set', ['New set', 'New set 3']), 'New set 2');
	assert.equal(uniqueName('New set', ['New set 2']), 'New set');
	assert.equal(uniqueName('New set', ['New set', 'New set 2', 'New set 3']), 'New set 4');
});

test('moveItem: moves within bounds without mutating, ignores out-of-range moves', () => {
	const items: string[] = ['a', 'b', 'c'];
	assert.deepEqual(moveItem(items, 0, 1), ['b', 'a', 'c']);
	assert.deepEqual(moveItem(items, 2, 0), ['c', 'a', 'b']);
	assert.deepEqual(moveItem(items, 0, -1), ['a', 'b', 'c']);
	assert.deepEqual(moveItem(items, 2, 3), ['a', 'b', 'c']);
	assert.deepEqual(items, ['a', 'b', 'c']);
});

test('duplicateFileSet: new id, unique name, deep copy, no startup flag', () => {
	const original: FileSet = { id: 'one', name: 'Set', openOnStartup: true, closeOthers: true, paths: [{ path: 'a.ts', column: 1 }] };
	const copy: FileSet = duplicateFileSet(original, [original]);
	assert.notEqual(copy.id, 'one');
	assert.ok(copy.id);
	assert.equal(copy.name, 'Set 2');
	assert.equal(copy.closeOthers, true);
	assert.equal(copy.openOnStartup, undefined);
	copy.paths[0].path = 'changed.ts';
	assert.equal(original.paths[0].path, 'a.ts');
});

test('exportFileSet / importFileSets: round-trips with a fresh id and a non-colliding name', () => {
	const original: FileSet = { id: 'one', name: 'Set', openOnStartup: true, paths: [{ path: 'a.ts', column: 0 }, { path: 'b.ts' }] };
	const text: string = exportFileSet(original);
	assert.equal('id' in JSON.parse(text), false);
	assert.equal('openOnStartup' in JSON.parse(text), false);

	const [imported] = importFileSets(text, [original]);
	assert.equal(imported.name, 'Set 2');
	assert.ok(imported.id && imported.id !== 'one');
	assert.deepEqual(imported.paths, original.paths);
});

test('importFileSets: accepts an array, numbers duplicates among themselves, rejects bad input', () => {
	const text: string = JSON.stringify([
		{ name: 'X', paths: [] },
		{ name: 'X', paths: [] }
	]);
	assert.deepEqual(importFileSets(text, []).map((set) => set.name), ['X', 'X 2']);
	assert.throws(() => importFileSets('not json', []), /valid JSON/);
	assert.throws(() => importFileSets('[]', []), /no file sets/);
	assert.throws(() => importFileSets('{"name": 1}', []), /must be an object/);
});

test('findMissingPaths: unique, skips blank paths', () => {
	const sets: FileSet[] = [
		{ name: 'A', paths: [{ path: 'gone.ts' }, { path: 'here.ts' }, { path: '' }] },
		{ name: 'B', paths: [{ path: 'gone.ts' }] }
	];
	assert.deepEqual(findMissingPaths(sets, (p: string) => p === 'gone.ts' || p === ''), ['gone.ts']);
});

test('layoutToPositions: columns with stacked rows, flat columns, vertical and irregular layouts', () => {
	assert.deepEqual(layoutToPositions({ orientation: 0, groups: [{ size: 1 }] }), [{ viewColumn: 1, column: 0 }]);

	assert.deepEqual(layoutToPositions({ orientation: 0, groups: [{ size: 0.5, groups: [{ size: 0.5 }, { size: 0.5 }] }, { size: 0.5 }] }), [
		{ viewColumn: 1, column: 0, row: 0 },
		{ viewColumn: 2, column: 0, row: 1 },
		{ viewColumn: 3, column: 1 }
	]);

	assert.deepEqual(layoutToPositions({ orientation: 1, groups: [{ size: 0.5 }, { size: 0.5 }] }), [
		{ viewColumn: 1, column: 0, row: 0 },
		{ viewColumn: 2, column: 0, row: 1 }
	]);

	assert.deepEqual(layoutToPositions({ orientation: 1, groups: [{ size: 0.5, groups: [{}, {}] }, { size: 0.5 }] }), [
		{ viewColumn: 1, column: 0 },
		{ viewColumn: 2, column: 1 },
		{ viewColumn: 3, column: 2 }
	]);
});

test('positionsToEntries: skips groups without a file and keeps row only where set', () => {
	const entries = positionsToEntries(
		[
			{ viewColumn: 1, column: 0, row: 0 },
			{ viewColumn: 2, column: 0, row: 1 },
			{ viewColumn: 3, column: 1 }
		],
		new Map<number, string>([
			[1, 'a.ts'],
			[3, 'c.ts']
		])
	);
	assert.deepEqual(entries, [
		{ path: 'a.ts', column: 0, row: 0 },
		{ path: 'c.ts', column: 1 }
	]);
});

const named = (id: string, ...paths: string[]): FileSet => ({ id, name: id, paths: paths.map((p: string) => ({ path: p })) });
const ids = (sets: FileSet[]): (string | undefined)[] => sets.map((set: FileSet) => set.id);
const pathsOf = (set: FileSet): string[] => set.paths.map((entry) => entry.path);

test('isGlobPattern: * ? { are globs, brackets in names are not', () => {
	assert.equal(isGlobPattern('src/*.ts'), true);
	assert.equal(isGlobPattern('src/a?.ts'), true);
	assert.equal(isGlobPattern('src/{a,b}.ts'), true);
	assert.equal(isGlobPattern('pages/[id].tsx'), false);
	assert.equal(isGlobPattern('src/a.ts'), false);
});

test('expandGlobEntry: columns fan out without a column, rows stack with one', () => {
	assert.deepEqual(expandGlobEntry({ path: 'x*' }, ['a', 'b']), [{ path: 'a' }, { path: 'b' }]);
	assert.deepEqual(expandGlobEntry({ path: 'x*', row: 1 }, ['a', 'b']), [{ path: 'a', row: 1 }, { path: 'b', row: 1 }]);
	assert.deepEqual(expandGlobEntry({ path: 'x*', column: 2 }, ['a']), [{ path: 'a', column: 2 }]);
	assert.deepEqual(expandGlobEntry({ path: 'x*', column: 2 }, ['a', 'b']), [
		{ path: 'a', column: 2, row: 0 },
		{ path: 'b', column: 2, row: 1 }
	]);
	assert.deepEqual(expandGlobEntry({ path: 'x*', column: 0, row: 3 }, ['a', 'b']), [
		{ path: 'a', column: 0, row: 3 },
		{ path: 'b', column: 0, row: 4 }
	]);
	assert.deepEqual(expandGlobEntry({ path: 'x*' }, []), []);
});

test('findMissingPaths: glob patterns are never reported missing', () => {
	assert.deepEqual(findMissingPaths([named('a', 'src/*.ts')], () => true), []);
});

test('moveSets: takes the target slot going up or down, keeps block order, ignores bad targets', () => {
	const sets: FileSet[] = [named('a'), named('b'), named('c'), named('d')];
	assert.deepEqual(ids(moveSets(sets, ['d'], 'b')), ['a', 'd', 'b', 'c']);
	assert.deepEqual(ids(moveSets(sets, ['a'], 'c')), ['b', 'c', 'a', 'd']);
	assert.deepEqual(ids(moveSets(sets, ['a', 'b'], 'd')), ['c', 'd', 'a', 'b']);
	assert.deepEqual(ids(moveSets(sets, ['c', 'd'], 'a')), ['c', 'd', 'a', 'b']);
	assert.deepEqual(ids(moveSets(sets, ['a'], 'a')), ['a', 'b', 'c', 'd']);
	assert.deepEqual(ids(moveSets(sets, ['a'], 'zzz')), ['a', 'b', 'c', 'd']);
});

test('moveFiles: reorders within a set and moves between sets without mutating the input', () => {
	const sets: FileSet[] = [named('s1', 'a', 'b', 'c'), named('s2', 'x')];

	const reordered: FileSet[] = moveFiles(sets, [{ setId: 's1', index: 2 }], 's1', 0);
	assert.deepEqual(pathsOf(reordered[0]), ['c', 'a', 'b']);

	const down: FileSet[] = moveFiles(sets, [{ setId: 's1', index: 0 }], 's1', 2);
	assert.deepEqual(pathsOf(down[0]), ['b', 'a', 'c']);

	const across: FileSet[] = moveFiles(sets, [{ setId: 's1', index: 0 }, { setId: 's1', index: 2 }], 's2', 0);
	assert.deepEqual(pathsOf(across[0]), ['b']);
	assert.deepEqual(pathsOf(across[1]), ['a', 'c', 'x']);

	const toEnd: FileSet[] = moveFiles(sets, [{ setId: 's1', index: 1 }], 's2');
	assert.deepEqual(pathsOf(toEnd[1]), ['x', 'b']);

	assert.deepEqual(pathsOf(sets[0]), ['a', 'b', 'c']);
	assert.deepEqual(pathsOf(moveFiles(sets, [{ setId: 's1', index: 9 }], 's2')[1]), ['x']);
});

test('addPathsToSet: skips duplicates, inserts before an index, returns the added count', () => {
	const set: FileSet = named('s', 'a', 'b');
	assert.equal(addPathsToSet(set, ['b', 'c', 'c', 'd'], 1), 2);
	assert.deepEqual(pathsOf(set), ['a', 'c', 'd', 'b']);
	assert.equal(addPathsToSet(set, ['e']), 1);
	assert.deepEqual(pathsOf(set), ['a', 'c', 'd', 'b', 'e']);
});

test('expandDateTokens: fills date-only brace groups with a zero-padded local date', () => {
	const now: Date = new Date(2026, 0, 5);
	assert.equal(expandDateTokens('All_{YYYY-MM-DD}*.log', now), 'All_2026-01-05*.log');
	assert.equal(expandDateTokens('{YYYYMMDD}.log', now), '20260105.log');
	assert.equal(expandDateTokens('{YYYY}/{MM}/{DD}.log', now), '2026/01/05.log');
	assert.equal(expandDateTokens('x_{YYYY_MM}.log', now), 'x_2026_01.log');
});

test('expandDateTokens: leaves other brace groups and non-token text alone', () => {
	const now: Date = new Date(2026, 9, 3);
	assert.equal(expandDateTokens('src/{a,b}.ts', now), 'src/{a,b}.ts');
	assert.equal(expandDateTokens('src/{YYYY,x}.ts', now), 'src/{YYYY,x}.ts');
	assert.equal(expandDateTokens('src/{Y}.ts', now), 'src/{Y}.ts');
	assert.equal(expandDateTokens('src/YYYY.ts', now), 'src/YYYY.ts');
	assert.equal(expandDateTokens('All_{YYYY-MM-DD}{,.*}.log', now), 'All_2026-10-03{,.*}.log');
});

test('naturalCompare: orders embedded numbers by value', () => {
	const sorted: string[] = ['a.10.log', 'a.2.log', 'a.1.log'].sort(naturalCompare);
	assert.deepEqual(sorted, ['a.1.log', 'a.2.log', 'a.10.log']);
});

test('expandDateTokens: day offsets move the date, crossing month and year boundaries', () => {
	const now: Date = new Date(2026, 0, 1);
	assert.equal(expandDateTokens('All_{YYYY-MM-DD-1}.log', now), 'All_2025-12-31.log');
	assert.equal(expandDateTokens('All_{YYYYMMDD+30}.log', now), 'All_20260131.log');
	assert.equal(expandDateTokens('{MM-1}', new Date(2026, 2, 1)), '02');
	assert.equal(expandDateTokens('{YYYY-MM-DD-1}{,.*}', new Date(2026, 2, 1)), '2026-02-28{,.*}');
	assert.equal(expandDateTokens('{.-1}', now), '{.-1}');
});

test('selectNewest: newest N by mtime, returned in natural order', () => {
	const files = [
		{ path: 'a.1.log', mtime: 100 },
		{ path: 'a.10.log', mtime: 300 },
		{ path: 'a.2.log', mtime: 200 }
	];
	assert.deepEqual(selectNewest(files, 1), ['a.10.log']);
	assert.deepEqual(selectNewest(files, 2), ['a.2.log', 'a.10.log']);
	assert.deepEqual(selectNewest(files, 9), ['a.1.log', 'a.2.log', 'a.10.log']);
});

test('assignGroup / renameGroup / groupNames', () => {
	const sets: FileSet[] = [{ id: 'a', name: 'A', paths: [] }, { id: 'b', name: 'B', group: 'G', paths: [] }];
	const grouped: FileSet[] = assignGroup(sets, ['a'], 'G');
	assert.deepEqual(groupNames(grouped), ['G']);
	assert.equal(grouped[0].group, 'G');
	assert.equal(sets[0].group, undefined);
	assert.equal(assignGroup(grouped, ['a'], undefined)[0].group, undefined);
	assert.deepEqual(groupNames(renameGroup(grouped, 'G', 'H')), ['H']);
	assert.equal('group' in renameGroup(grouped, 'G', '')[1], false);
});

// New contract (spec 3.5): resolveFilePath(baseDir, filePath); callers pass the home directory.
const resolveFilePath = (setLogicModule as unknown as { resolveFilePath: (baseDir: string, filePath: string) => string }).resolveFilePath;

test('resolveFilePath: a lone "~" is the home directory', () => {
	assert.equal(resolveFilePath('/base', '~'), os.homedir());
});

test('resolveFilePath: "~/" and "~\\" prefixes expand to the home directory', () => {
	assert.equal(resolveFilePath('/base', '~/docs/a.txt'), path.join(os.homedir(), 'docs', 'a.txt'));
	assert.equal(resolveFilePath('/base', '~\\docs\\a.txt').startsWith(os.homedir()), true);
	assert.equal(resolveFilePath('/base', '~\\docs\\a.txt').includes('~'), false);
});

test('resolveFilePath: an absolute path is returned as is', () => {
	assert.equal(resolveFilePath('/base', '/etc/hosts'), '/etc/hosts');
});

test('resolveFilePath: a relative path is joined to baseDir', () => {
	assert.equal(resolveFilePath('/base', 'src/a.ts'), path.join('/base', 'src', 'a.ts'));
	assert.equal(resolveFilePath('/other', 'a.ts'), path.join('/other', 'a.ts'));
});

test('resolveFilePath: "~user/x" and "a~b" are not home paths', () => {
	assert.equal(resolveFilePath('/base', '~user/x'), path.join('/base', '~user', 'x'));
	assert.equal(resolveFilePath('/base', 'a~b'), path.join('/base', 'a~b'));
});

test('resolveFilePath: "~~" is relative, not a home path', () => {
	assert.equal(resolveFilePath('/base', '~~'), path.join('/base', '~~'));
	assert.equal(resolveFilePath('/base', '~~/x'), path.join('/base', '~~', 'x'));
});

test('resolveFilePath: a Windows-style "~\\x" expands to the home directory', () => {
	const resolved: string = resolveFilePath('/base', '~\\x');
	assert.ok(resolved.startsWith(os.homedir()));
	assert.ok(!resolved.includes('~'));
	assert.ok(!resolved.startsWith('/base'));
});

const excludeExistingPaths = (
	setLogicModule as unknown as {
		excludeExistingPaths: (fileSet: FileSet, paths: string[], homeDir: string, caseInsensitive: boolean) => string[];
	}
).excludeExistingPaths;

test('excludeExistingPaths: returns all paths when the set is empty', () => {
	assert.deepEqual(excludeExistingPaths(named('s'), ['/a/x.ts', '/a/y.ts'], '/home/me', false), ['/a/x.ts', '/a/y.ts']);
});

test('excludeExistingPaths: drops paths already present as absolute entries, preserving order', () => {
	const set: FileSet = named('s', '/a/y.ts');
	assert.deepEqual(excludeExistingPaths(set, ['/a/z.ts', '/a/y.ts', '/a/x.ts'], '/home/me', false), ['/a/z.ts', '/a/x.ts']);
});

test('excludeExistingPaths: a relative entry matches its absolute form resolved against homeDir', () => {
	const set: FileSet = named('s', 'src/a.ts');
	const abs: string = path.join('/home/me', 'src', 'a.ts');
	assert.deepEqual(excludeExistingPaths(set, [abs, '/other/b.ts'], '/home/me', false), ['/other/b.ts']);
});

test('excludeExistingPaths: a "~/x.ts" entry matches the absolute path under the home directory', () => {
	const set: FileSet = named('s', '~/x.ts');
	const abs: string = path.join(os.homedir(), 'x.ts');
	assert.deepEqual(excludeExistingPaths(set, [abs, '/other/x.ts'], os.homedir(), false), ['/other/x.ts']);
});

test('excludeExistingPaths: "~foo" entries are relative to homeDir, not the real home', () => {
	const set: FileSet = named('s', '~foo/x.ts');
	const abs: string = path.join('/home/me', '~foo', 'x.ts');
	assert.deepEqual(excludeExistingPaths(set, [abs], '/home/me', false), []);
});

test('excludeExistingPaths: comparison is case-sensitive when caseInsensitive is false', () => {
	const set: FileSet = named('s', '/A/File.ts');
	assert.deepEqual(excludeExistingPaths(set, ['/a/file.ts'], '/home/me', false), ['/a/file.ts']);
});

test('excludeExistingPaths: comparison ignores case when caseInsensitive is true', () => {
	const set: FileSet = named('s', '/A/File.ts');
	assert.deepEqual(excludeExistingPaths(set, ['/a/file.ts', '/a/other.ts'], '/home/me', true), ['/a/other.ts']);
});

test('excludeExistingPaths: returns nothing when every path is already in the set, and does not mutate the set', () => {
	const set: FileSet = named('s', '/a/x.ts', '/a/y.ts');
	assert.deepEqual(excludeExistingPaths(set, ['/a/y.ts', '/a/x.ts'], '/home/me', false), []);
	assert.deepEqual(pathsOf(set), ['/a/x.ts', '/a/y.ts']);
});

test('moveSetsIntoGroup: lands after the last set of the group, or at the end for a new group', () => {
	const sets: FileSet[] = [
		{ id: 'a', name: 'A', paths: [] },
		{ id: 'b', name: 'B', group: 'G', paths: [] },
		{ id: 'c', name: 'C', paths: [] },
		{ id: 'd', name: 'D', group: 'G', paths: [] },
		{ id: 'e', name: 'E', paths: [] }
	];
	const intoG: FileSet[] = moveSetsIntoGroup(sets, ['a'], 'G');
	assert.deepEqual(ids(intoG), ['b', 'c', 'd', 'a', 'e']);
	assert.equal(intoG[3].group, 'G');

	const intoNew: FileSet[] = moveSetsIntoGroup(sets, ['b', 'c'], 'New');
	assert.deepEqual(ids(intoNew), ['a', 'd', 'e', 'b', 'c']);
});

// parseDragPayload is new (spec 6.5); accessed through a cast so the file compiles before it exists.
type DragPayloadShape = { kind: 'sets'; ids: string[] } | { kind: 'files'; refs: { setId: string; index: number }[] };
const parseDragPayload: (text: string) => DragPayloadShape | undefined = (
	setLogicModule as unknown as { parseDragPayload: (text: string) => DragPayloadShape | undefined }
).parseDragPayload;

test('parseDragPayload: a valid sets payload is returned with only known fields', () => {
	assert.deepEqual(parseDragPayload(JSON.stringify({ kind: 'sets', ids: ['a', 'b'], extra: 1 })), { kind: 'sets', ids: ['a', 'b'] });
});

test('parseDragPayload: a valid files payload is returned with only known fields', () => {
	const text: string = JSON.stringify({ kind: 'files', refs: [{ setId: 's1', index: 0, extra: true }, { setId: 's2', index: 3 }], extra: 1 });
	assert.deepEqual(parseDragPayload(text), {
		kind: 'files',
		refs: [{ setId: 's1', index: 0 }, { setId: 's2', index: 3 }]
	});
});

test('parseDragPayload: empty ids and refs arrays are valid', () => {
	assert.deepEqual(parseDragPayload('{"kind":"sets","ids":[]}'), { kind: 'sets', ids: [] });
	assert.deepEqual(parseDragPayload('{"kind":"files","refs":[]}'), { kind: 'files', refs: [] });
});

test('parseDragPayload: invalid JSON returns undefined without throwing', () => {
	assert.equal(parseDragPayload('not json'), undefined);
	assert.equal(parseDragPayload(''), undefined);
	assert.equal(parseDragPayload('{"kind":'), undefined);
});

test('parseDragPayload: JSON that is not an object returns undefined', () => {
	for (const text of ['null', '42', '"sets"', 'true', '[]', '[{"kind":"sets","ids":[]}]']) {
		assert.equal(parseDragPayload(text), undefined, text);
	}
});

test('parseDragPayload: an unknown or missing kind returns undefined', () => {
	assert.equal(parseDragPayload('{"kind":"other","ids":[]}'), undefined);
	assert.equal(parseDragPayload('{"kind":5,"ids":[]}'), undefined);
	assert.equal(parseDragPayload('{"ids":[]}'), undefined);
	assert.equal(parseDragPayload('{}'), undefined);
});

test('parseDragPayload: ids that is missing or not an array returns undefined', () => {
	assert.equal(parseDragPayload('{"kind":"sets"}'), undefined);
	assert.equal(parseDragPayload('{"kind":"sets","ids":"a"}'), undefined);
	assert.equal(parseDragPayload('{"kind":"sets","ids":{"0":"a"}}'), undefined);
});

test('parseDragPayload: ids containing a non-string returns undefined', () => {
	assert.equal(parseDragPayload('{"kind":"sets","ids":["a",1]}'), undefined);
	assert.equal(parseDragPayload('{"kind":"sets","ids":["a",null]}'), undefined);
});

test('parseDragPayload: ids containing an empty string returns undefined', () => {
	assert.equal(parseDragPayload('{"kind":"sets","ids":["a",""]}'), undefined);
});

test('parseDragPayload: refs that is missing or not an array returns undefined', () => {
	assert.equal(parseDragPayload('{"kind":"files"}'), undefined);
	assert.equal(parseDragPayload('{"kind":"files","refs":"x"}'), undefined);
	assert.equal(parseDragPayload('{"kind":"files","refs":{"setId":"a","index":0}}'), undefined);
});

test('parseDragPayload: a null or non-object ref returns undefined', () => {
	assert.equal(parseDragPayload('{"kind":"files","refs":[null]}'), undefined);
	assert.equal(parseDragPayload('{"kind":"files","refs":["a"]}'), undefined);
	assert.equal(parseDragPayload('{"kind":"files","refs":[5]}'), undefined);
});

test('parseDragPayload: a ref with a missing or non-string setId returns undefined', () => {
	assert.equal(parseDragPayload('{"kind":"files","refs":[{"index":0}]}'), undefined);
	assert.equal(parseDragPayload('{"kind":"files","refs":[{"setId":1,"index":0}]}'), undefined);
	assert.equal(parseDragPayload('{"kind":"files","refs":[{"setId":null,"index":0}]}'), undefined);
});

test('parseDragPayload: a ref index that is not a non-negative integer returns undefined', () => {
	assert.equal(parseDragPayload('{"kind":"files","refs":[{"setId":"a","index":-1}]}'), undefined);
	assert.equal(parseDragPayload('{"kind":"files","refs":[{"setId":"a","index":1.5}]}'), undefined);
	assert.equal(parseDragPayload('{"kind":"files","refs":[{"setId":"a","index":"1"}]}'), undefined);
	assert.equal(parseDragPayload('{"kind":"files","refs":[{"setId":"a","index":null}]}'), undefined);
	assert.equal(parseDragPayload('{"kind":"files","refs":[{"setId":"a"}]}'), undefined);
	// NaN and Infinity are not representable in JSON; they arrive as null, which is also rejected.
	assert.equal(parseDragPayload('{"kind":"files","refs":[{"setId":"a","index":NaN}]}'), undefined);
});

test('parseDragPayload: one bad ref invalidates the whole payload', () => {
	assert.equal(parseDragPayload('{"kind":"files","refs":[{"setId":"a","index":0},{"setId":"b","index":-2}]}'), undefined);
});

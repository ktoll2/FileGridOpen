import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

interface WalkOptions {
	maxMatches?: number;
	maxEntries?: number;
	caseSensitive?: boolean;
}
interface WalkResult {
	matches: string[];
	truncated: boolean;
}
interface GlobWalkModule {
	walkGlob(pattern: string, options?: WalkOptions): WalkResult;
}

// Loaded lazily so the suite compiles before the module exists and fails at runtime instead.
function walk(pattern: string, options?: WalkOptions): WalkResult {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mod: GlobWalkModule = require('../core/globWalk') as GlobWalkModule;
	return mod.walkGlob(pattern, options);
}

const roots: string[] = [];

function makeTree(files: string[], dirs: string[] = []): string {
	const root: string = fs.mkdtempSync(path.join(os.tmpdir(), 'fgo-walk-'));
	roots.push(root);
	for (const d of dirs) {
		fs.mkdirSync(path.join(root, d), { recursive: true });
	}
	for (const f of files) {
		const full: string = path.join(root, f);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, 'x');
	}
	return root;
}

function sortedMatches(root: string, relPattern: string, options?: WalkOptions): string[] {
	return walk(path.join(root, relPattern), options).matches.slice().sort();
}

function abs(root: string, ...rels: string[]): string[] {
	return rels.map((r) => path.join(root, r)).sort();
}

after(() => {
	for (const r of roots) {
		fs.rmSync(r, { recursive: true, force: true });
	}
});

test('walkGlob: * matches files in the base directory only', () => {
	const root: string = makeTree(['a.log', 'b.log', 'c.txt', 'sub/d.log']);
	const res: WalkResult = walk(path.join(root, '*.log'));
	assert.deepEqual(res.matches.slice().sort(), abs(root, 'a.log', 'b.log'));
	assert.equal(res.truncated, false);
});

test('walkGlob: returns absolute paths', () => {
	const root: string = makeTree(['a.log']);
	const res: WalkResult = walk(path.join(root, '*.log'));
	assert.ok(res.matches.every((m) => path.isAbsolute(m)));
});

test('walkGlob: ? matches exactly one character', () => {
	const root: string = makeTree(['x1.txt', 'x2.txt', 'x.txt', 'x12.txt']);
	assert.deepEqual(sortedMatches(root, 'x?.txt'), abs(root, 'x1.txt', 'x2.txt'));
});

test('walkGlob: ** descends into nested directories and matches zero segments', () => {
	const root: string = makeTree(['a.txt', 'one/a.txt', 'one/two/a.txt', 'one/two/b.txt']);
	assert.deepEqual(sortedMatches(root, '**/a.txt'), abs(root, 'a.txt', 'one/a.txt', 'one/two/a.txt'));
});

test('walkGlob: {a,b} alternatives', () => {
	const root: string = makeTree(['b1/c.txt', 'b2/c.txt', 'b3/c.txt']);
	assert.deepEqual(sortedMatches(root, 'b{1,2}/c.txt'), abs(root, 'b1/c.txt', 'b2/c.txt'));
});

test('walkGlob: a nested directory in the base part of the pattern', () => {
	const root: string = makeTree(['logs/app/a.log', 'logs/app/b.txt', 'logs/other/a.log']);
	assert.deepEqual(sortedMatches(root, 'logs/app/*.log'), abs(root, 'logs/app/a.log'));
});

test('walkGlob: glob in a middle directory segment', () => {
	const root: string = makeTree(['p1/src/a.ts', 'p2/src/a.ts', 'p2/lib/a.ts']);
	assert.deepEqual(sortedMatches(root, '*/src/*.ts'), abs(root, 'p1/src/a.ts', 'p2/src/a.ts'));
});

test('walkGlob: returns files only, never directories', () => {
	const root: string = makeTree(['file.d'], ['dir.d', 'dir.d/inner']);
	assert.deepEqual(sortedMatches(root, '*.d'), abs(root, 'file.d'));
});

test('walkGlob: * matches dotfiles', () => {
	const root: string = makeTree(['.env', 'a.env', '.hidden/x']);
	assert.deepEqual(sortedMatches(root, '*.env'), abs(root, '.env', 'a.env'));
	assert.deepEqual(sortedMatches(root, '*'), abs(root, '.env', 'a.env'));
});

test('walkGlob: date-expanded style names', () => {
	const root: string = makeTree([
		'All_2026-10-03.log',
		'All_2026-10-03.1.log',
		'All_2026-10-03.10.log',
		'All_2026-10-02.log',
		'All_2026-10-03.txt'
	]);
	assert.deepEqual(
		sortedMatches(root, 'All_2026-10-03*.log'),
		abs(root, 'All_2026-10-03.log', 'All_2026-10-03.1.log', 'All_2026-10-03.10.log')
	);
	assert.deepEqual(
		sortedMatches(root, 'All_2026-10-03{,.*}.log'),
		abs(root, 'All_2026-10-03.log', 'All_2026-10-03.1.log', 'All_2026-10-03.10.log')
	);
});

test('walkGlob: case-sensitive by default, case-insensitive on request', () => {
	const root: string = makeTree(['a.log', 'B.LOG']);
	assert.deepEqual(sortedMatches(root, '*.LOG'), abs(root, 'B.LOG'));
	assert.deepEqual(sortedMatches(root, '*.LOG', { caseSensitive: false }), abs(root, 'a.log', 'B.LOG'));
});

test('walkGlob: does not follow symbolic links to directories', (t) => {
	const root: string = makeTree(['real/a.txt']);
	try {
		fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
	} catch {
		t.skip('cannot create symlinks on this platform');
		return;
	}
	assert.deepEqual(sortedMatches(root, '**/a.txt'), abs(root, 'real/a.txt'));
});

test('walkGlob: skips .git and node_modules for ** patterns', () => {
	const root: string = makeTree(['a.js', 'src/b.js', 'node_modules/pkg/c.js', '.git/d.js', 'src/node_modules/e.js']);
	assert.deepEqual(sortedMatches(root, '**/*.js'), abs(root, 'a.js', 'src/b.js'));
});

test('walkGlob: skips node_modules for a single * segment as well', () => {
	const root: string = makeTree(['node_modules/index.js', 'lib/index.js']);
	assert.deepEqual(sortedMatches(root, '*/index.js'), abs(root, 'lib/index.js'));
});

test('walkGlob: descends into node_modules when the remainder names it literally', () => {
	const root: string = makeTree(['node_modules/a/index.js', 'node_modules/b/index.js', 'other/a/index.js']);
	assert.deepEqual(sortedMatches(root, 'node_modules/*/index.js'), abs(root, 'node_modules/a/index.js', 'node_modules/b/index.js'));
});

test('walkGlob: descends into .git when the remainder names it literally', () => {
	const root: string = makeTree(['.git/config', '.git/HEAD', 'x/config']);
	assert.deepEqual(sortedMatches(root, '.git/*'), abs(root, '.git/HEAD', '.git/config'));
});

test('walkGlob: stops at maxMatches without marking truncated', () => {
	const files: string[] = [];
	for (let i: number = 0; i < 10; i++) {
		files.push(`f${i}.txt`);
	}
	const root: string = makeTree(files);
	const res: WalkResult = walk(path.join(root, '*.txt'), { maxMatches: 3 });
	assert.equal(res.matches.length, 3);
	assert.equal(res.truncated, false);
});

test('walkGlob: default maxMatches is 100', () => {
	const files: string[] = [];
	for (let i: number = 0; i < 120; i++) {
		files.push(`f${i}.txt`);
	}
	const root: string = makeTree(files);
	const res: WalkResult = walk(path.join(root, '*.txt'));
	assert.equal(res.matches.length, 100);
	assert.equal(res.truncated, false);
});

test('walkGlob: stops after maxEntries directory entries and reports truncated', () => {
	const files: string[] = [];
	for (let i: number = 0; i < 20; i++) {
		files.push(`f${i}.txt`);
	}
	const root: string = makeTree(files);
	const res: WalkResult = walk(path.join(root, '*.txt'), { maxEntries: 5 });
	assert.equal(res.truncated, true);
	assert.ok(res.matches.length <= 5);
});

test('walkGlob: maxEntries cap applies across nested directories', () => {
	const files: string[] = [];
	for (let d: number = 0; d < 10; d++) {
		for (let i: number = 0; i < 10; i++) {
			files.push(`d${d}/f${i}.txt`);
		}
	}
	const root: string = makeTree(files);
	const res: WalkResult = walk(path.join(root, '**/*.txt'), { maxEntries: 15 });
	assert.equal(res.truncated, true);
	assert.ok(res.matches.length <= 15);
});

test('walkGlob: not truncated when the tree is within maxEntries', () => {
	const root: string = makeTree(['a.txt', 'b.txt']);
	const res: WalkResult = walk(path.join(root, '*.txt'), { maxEntries: 1000 });
	assert.equal(res.truncated, false);
	assert.equal(res.matches.length, 2);
});

test('walkGlob: a missing base directory returns no matches without throwing', () => {
	const root: string = makeTree([]);
	const res: WalkResult = walk(path.join(root, 'does-not-exist', '*.log'));
	assert.deepEqual(res, { matches: [], truncated: false });
});

test('walkGlob: no glob character returns the path when it is an existing file', () => {
	const root: string = makeTree(['a.txt']);
	const file: string = path.join(root, 'a.txt');
	assert.deepEqual(walk(file), { matches: [file], truncated: false });
});

test('walkGlob: no glob character and no such file returns no matches', () => {
	const root: string = makeTree(['a.txt']);
	assert.deepEqual(walk(path.join(root, 'nope.txt')), { matches: [], truncated: false });
});

test('walkGlob: no glob character and the path is a directory returns no matches', () => {
	const root: string = makeTree([], ['adir']);
	assert.deepEqual(walk(path.join(root, 'adir')).matches, []);
});

test('walkGlob: pattern matching nothing returns empty, not truncated', () => {
	const root: string = makeTree(['a.txt']);
	assert.deepEqual(walk(path.join(root, '*.zzz')), { matches: [], truncated: false });
});

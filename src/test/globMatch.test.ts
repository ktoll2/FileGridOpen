import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

interface GlobMatchModule {
	splitGlobPattern(pattern: string): { baseDir: string; remainder: string };
	matchesGlob(remainder: string, relativePath: string, caseSensitive?: boolean): boolean;
	compileGlob(remainder: string, caseSensitive?: boolean): (relativePath: string) => boolean;
}

// Loaded lazily so the suite compiles before the module exists and fails at runtime instead.
function mod(): GlobMatchModule {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('../core/globMatch') as GlobMatchModule;
}

const m = (remainder: string, rel: string, cs?: boolean): boolean => mod().matchesGlob(remainder, rel, cs);

test('splitGlobPattern: splits at the first segment with a glob character', () => {
	const r = mod().splitGlobPattern('/var/log/app/All_*.log');
	assert.equal(r.baseDir, path.join('/var', 'log', 'app'));
	assert.equal(r.remainder, 'All_*.log');
});

test('splitGlobPattern: ** and ? segments', () => {
	const r = mod().splitGlobPattern('/data/**/x?.txt');
	assert.equal(r.baseDir, path.join('/data'));
	assert.equal(r.remainder, '**/x?.txt');
});

test('splitGlobPattern: glob in the first segment gives the root as baseDir', () => {
	const r = mod().splitGlobPattern('/*.log');
	assert.equal(r.baseDir, path.parse(path.resolve('/')).root);
	assert.equal(r.remainder, '*.log');
});

test('splitGlobPattern: brace group counts as a glob segment', () => {
	const r = mod().splitGlobPattern('/a/b{1,2}/c.txt');
	assert.equal(r.baseDir, path.join('/a'));
	assert.equal(r.remainder, 'b{1,2}/c.txt');
});

test('splitGlobPattern: no glob character returns whole pattern and empty remainder', () => {
	const r = mod().splitGlobPattern('/a/b/c.txt');
	assert.equal(r.baseDir, path.join('/a', 'b', 'c.txt'));
	assert.equal(r.remainder, '');
});

test('splitGlobPattern: brackets are not glob characters', () => {
	const r = mod().splitGlobPattern('/pages/[id].tsx');
	assert.equal(r.remainder, '');
});

test('splitGlobPattern: remainder keeps / separators after several segments', () => {
	const r = mod().splitGlobPattern('/a/b*/c/d?.txt');
	assert.equal(r.baseDir, path.join('/a'));
	assert.equal(r.remainder, 'b*/c/d?.txt');
});

test('matchesGlob: * matches any run of characters within a segment, including empty', () => {
	assert.equal(m('All_*.log', 'All_2026-10-03.log'), true);
	assert.equal(m('All_*.log', 'All_.log'), true);
	assert.equal(m('All_*.log', 'All_2026-10-03.1.log'), true);
	assert.equal(m('All_*.log', 'Other.log'), false);
});

test('matchesGlob: * does not cross a separator', () => {
	assert.equal(m('*.txt', 'a/b.txt'), false);
	assert.equal(m('a/*.txt', 'a/b/c.txt'), false);
	assert.equal(m('a/*.txt', 'a/c.txt'), true);
});

test('matchesGlob: * matches dotfiles', () => {
	assert.equal(m('*', '.hidden'), true);
	assert.equal(m('*.env', '.env'), true);
	assert.equal(m('dir/*', 'dir/.gitignore'), true);
});

test('matchesGlob: ? matches exactly one character, not a separator', () => {
	assert.equal(m('x?.txt', 'x1.txt'), true);
	assert.equal(m('x?.txt', 'x.txt'), false);
	assert.equal(m('x?.txt', 'x12.txt'), false);
	assert.equal(m('x?y', 'x/y'), false);
});

test('matchesGlob: ** matches zero or more whole segments', () => {
	assert.equal(m('**/a.txt', 'a.txt'), true);
	assert.equal(m('**/a.txt', 'x/a.txt'), true);
	assert.equal(m('**/a.txt', 'x/y/a.txt'), true);
	assert.equal(m('**/a.txt', 'x/y/b.txt'), false);
	assert.equal(m('a/**/b.txt', 'a/b.txt'), true);
	assert.equal(m('a/**/b.txt', 'a/x/y/b.txt'), true);
	assert.equal(m('a/**/b.txt', 'c/x/b.txt'), false);
});

test('matchesGlob: trailing ** matches files at any depth below', () => {
	assert.equal(m('a/**', 'a/b/c.txt'), true);
	assert.equal(m('a/**', 'a/b.txt'), true);
	assert.equal(m('a/**', 'z/b.txt'), false);
});

test('matchesGlob: {a,b} matches any alternative', () => {
	assert.equal(m('b{1,2}/c.txt', 'b1/c.txt'), true);
	assert.equal(m('b{1,2}/c.txt', 'b2/c.txt'), true);
	assert.equal(m('b{1,2}/c.txt', 'b3/c.txt'), false);
	assert.equal(m('*.{ts,js}', 'x.ts'), true);
	assert.equal(m('*.{ts,js}', 'x.js'), true);
	assert.equal(m('*.{ts,js}', 'x.md'), false);
});

test('matchesGlob: an empty alternative is allowed', () => {
	assert.equal(m('All{,.*}.log', 'All.log'), true);
	assert.equal(m('All{,.*}.log', 'All.1.log'), true);
	assert.equal(m('All{,.*}.log', 'All1.log'), false);
});

test('matchesGlob: alternatives may contain * and ?', () => {
	assert.equal(m('{a*,b?}.txt', 'abc.txt'), true);
	assert.equal(m('{a*,b?}.txt', 'bz.txt'), true);
	assert.equal(m('{a*,b?}.txt', 'bzz.txt'), false);
});

test('matchesGlob: regex-special characters are literal', () => {
	assert.equal(m('a.b', 'a.b'), true);
	assert.equal(m('a.b', 'axb'), false);
	assert.equal(m('(x)+.txt', '(x)+.txt'), true);
	assert.equal(m('(x)+.txt', 'xx.txt'), false);
	assert.equal(m('[id].tsx', '[id].tsx'), true);
	assert.equal(m('[id].tsx', 'i.tsx'), false);
	assert.equal(m('a$^|b*', 'a$^|bz'), true);
});

test('matchesGlob: a match must cover the entire path', () => {
	assert.equal(m('a.txt', 'xa.txt'), false);
	assert.equal(m('a.txt', 'a.txtx'), false);
	assert.equal(m('a.txt', 'dir/a.txt'), false);
	assert.equal(m('*.log', 'a.log.bak'), false);
});

test('matchesGlob: a pattern without glob characters matches only itself', () => {
	assert.equal(m('dir/a.txt', 'dir/a.txt'), true);
	assert.equal(m('dir/a.txt', 'dir/b.txt'), false);
});

test('matchesGlob: case-sensitive by default and when requested', () => {
	assert.equal(m('*.LOG', 'a.log'), false);
	assert.equal(m('*.LOG', 'a.log', true), false);
	assert.equal(m('*.log', 'a.log'), true);
});

test('matchesGlob: case-insensitive mode ignores case in literals, classes of alternatives', () => {
	assert.equal(m('*.LOG', 'a.log', false), true);
	assert.equal(m('Dir/*.txt', 'dIR/A.TXT', false), true);
	assert.equal(m('{Foo,Bar}.txt', 'bar.TXT', false), true);
	assert.equal(m('a.txt', 'b.txt', false), false);
});

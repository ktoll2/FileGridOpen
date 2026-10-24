import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileGlob, matchesGlob } from '../core/globMatch';

interface GlobCase {
	pattern: string;
	paths: string[];
}

const CASES: GlobCase[] = [
	{ pattern: '*.log', paths: ['a.log', '.log', 'a.log.bak', 'x/a.log', 'a.LOG'] },
	{ pattern: '**/a.txt', paths: ['a.txt', 'x/a.txt', 'x/y/a.txt', 'x/y/b.txt', 'xa.txt'] },
	{ pattern: 'a/**', paths: ['a/b.txt', 'a/b/c.txt', 'z/b.txt', 'a'] },
	{ pattern: 'x?.txt', paths: ['x1.txt', 'x.txt', 'x12.txt', 'x/.txt'] },
	{ pattern: 'b{1,2}/c.txt', paths: ['b1/c.txt', 'b2/c.txt', 'b3/c.txt', 'b/c.txt'] },
	{ pattern: 'All{,.*}.log', paths: ['All.log', 'All.1.log', 'All1.log', 'all.log'] },
	{ pattern: '(x)+.[id]$^|b', paths: ['(x)+.[id]$^|b', 'xx.i$^|b', '(x)+.[id]$^|c'] },
	{ pattern: 'Dir/*.TXT', paths: ['Dir/a.TXT', 'dir/a.txt', 'DIR/A.Txt', 'Dir/sub/a.TXT'] },
	{ pattern: '{Foo,Bar}.md', paths: ['Foo.md', 'bar.MD', 'Baz.md'] }
];

for (const caseSensitive of [true, false]) {
	test(`compileGlob agrees with matchesGlob for a table of patterns (caseSensitive=${caseSensitive})`, () => {
		for (const { pattern, paths } of CASES) {
			const matcher: (relativePath: string) => boolean = compileGlob(pattern, caseSensitive);
			for (const p of paths) {
				assert.equal(matcher(p), matchesGlob(pattern, p, caseSensitive), `${pattern} vs ${p} (caseSensitive=${caseSensitive})`);
			}
		}
	});
}

test('compileGlob: returns a function', () => {
	assert.equal(typeof compileGlob('*.ts'), 'function');
});

test('compileGlob: specific results for *, **, ?, {a,b} and {,.*}', () => {
	assert.equal(compileGlob('*.ts')('a.ts'), true);
	assert.equal(compileGlob('*.ts')('a/b.ts'), false);
	assert.equal(compileGlob('**/a.txt')('x/y/a.txt'), true);
	assert.equal(compileGlob('x?.txt')('x1.txt'), true);
	assert.equal(compileGlob('x?.txt')('x.txt'), false);
	assert.equal(compileGlob('*.{ts,js}')('a.js'), true);
	assert.equal(compileGlob('*.{ts,js}')('a.md'), false);
	assert.equal(compileGlob('All{,.*}.log')('All.1.log'), true);
	assert.equal(compileGlob('All{,.*}.log')('All1.log'), false);
});

test('compileGlob: regex-special characters are literal', () => {
	const matcher: (relativePath: string) => boolean = compileGlob('a.b(c)+[d]$^|');
	assert.equal(matcher('a.b(c)+[d]$^|'), true);
	assert.equal(matcher('axb(c)+[d]$^|'), false);
});

test('compileGlob: case-sensitive by default, case-insensitive when caseSensitive is false', () => {
	assert.equal(compileGlob('*.LOG')('a.log'), false);
	assert.equal(compileGlob('*.LOG', true)('a.log'), false);
	assert.equal(compileGlob('*.LOG', false)('a.log'), true);
	assert.equal(compileGlob('Dir/*.txt', false)('dIR/A.TXT'), true);
});

test('compileGlob: one matcher gives consistent results when reused for many paths', () => {
	const matcher: (relativePath: string) => boolean = compileGlob('src/**/*.{ts,js}');
	const paths: string[] = ['src/a.ts', 'src/x/y/b.js', 'src/c.md', 'lib/a.ts', 'src/a.ts', 'src/x/y/b.js'];
	const expected: boolean[] = [true, true, false, false, true, true];
	// Repeated passes and interleaved matches/non-matches must not change any outcome (no stateful regex).
	for (let pass = 0; pass < 3; pass++) {
		assert.deepEqual(
			paths.map((p) => matcher(p)),
			expected
		);
	}
});

test('compileGlob: independent matchers do not affect one another', () => {
	const ts: (relativePath: string) => boolean = compileGlob('*.ts');
	const js: (relativePath: string) => boolean = compileGlob('*.js');
	assert.equal(ts('a.ts'), true);
	assert.equal(js('a.ts'), false);
	assert.equal(ts('a.ts'), true);
	assert.equal(js('a.js'), true);
});

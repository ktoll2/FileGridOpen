import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCollisions, planLayout, resolvePositions } from '../core/layout';
import { FileSetPathEntry } from '../core/configFile';

test('resolvePositions: no hints assigns sequential 0-based columns, row 0', () => {
	const resolved = resolvePositions([{ path: 'a' }, { path: 'b' }, { path: 'c' }]);
	assert.deepEqual(
		resolved.map((r) => ({ path: r.entry.path, column: r.column, row: r.row })),
		[
			{ path: 'a', column: 0, row: 0 },
			{ path: 'b', column: 1, row: 0 },
			{ path: 'c', column: 2, row: 0 }
		]
	);
});

test('resolvePositions: explicit column continues auto-numbering past the highest seen', () => {
	const entries: FileSetPathEntry[] = [{ path: 'a' }, { path: 'b', column: 0, row: 2 }, { path: 'c' }];
	const resolved = resolvePositions(entries);
	assert.equal(resolved[0].column, 0); // auto
	assert.equal(resolved[1].column, 0); // explicit
	assert.equal(resolved[2].column, 1); // auto continues after highest explicit (0), not index-based (2)
});

test('planLayout: sequential entries need no grid rebuild and map 1:1 to columns', () => {
	const plan = planLayout([{ path: 'a' }, { path: 'b' }, { path: 'c' }]);
	assert.equal(plan.rebuildsGrid, false);
	assert.deepEqual(
		plan.placements.map((p) => p.viewColumn),
		[1, 2, 3]
	);
});

test('planLayout: column is a sort key, not a literal slot (gaps collapse)', () => {
	const plan = planLayout([
		{ path: 'a', column: 2 },
		{ path: 'b', column: 0 }
	]);
	assert.equal(plan.rebuildsGrid, false);
	const byPath = Object.fromEntries(plan.placements.map((p) => [p.entry.path, p.viewColumn]));
	assert.deepEqual(byPath, { a: 2, b: 1 });
});

test('planLayout: a column with more than one row rebuilds the grid with a vertical split', () => {
	const plan = planLayout([
		{ path: 'a', column: 0, row: 0 },
		{ path: 'b', column: 0, row: 1 },
		{ path: 'c', column: 1 }
	]);
	assert.equal(plan.rebuildsGrid, true);
	assert.deepEqual(plan.groups, [{ orientation: 1, groups: [{}, {}] }, {}]);
	const byPath = Object.fromEntries(plan.placements.map((p) => [p.entry.path, p.viewColumn]));
	assert.deepEqual(byPath, { a: 1, b: 2, c: 3 });
});

test('planLayout: every column with exactly one row never rebuilds, even with explicit row: 0', () => {
	const plan = planLayout([
		{ path: 'a', column: 0, row: 0 },
		{ path: 'b', column: 1, row: 0 }
	]);
	assert.equal(plan.rebuildsGrid, false);
});

test('findCollisions: distinct columns never collide', () => {
	assert.deepEqual(findCollisions([{ path: 'a' }, { path: 'b' }]), []);
});

test('findCollisions: same explicit column and row collide', () => {
	const collisions = findCollisions([
		{ path: 'a', column: 0, row: 0 },
		{ path: 'b', column: 0, row: 0 }
	]);
	assert.equal(collisions.length, 1);
	assert.deepEqual(collisions[0].paths, ['a', 'b']);
	assert.deepEqual(collisions[0].indexes, [0, 1]);
});

test('findCollisions: an omitted row (defaults to 0) collides with an explicit row: 0 in the same column', () => {
	const collisions = findCollisions([
		{ path: 'a', column: 0 },
		{ path: 'b', column: 0, row: 0 }
	]);
	assert.equal(collisions.length, 1);
	assert.deepEqual(collisions[0].paths, ['a', 'b']);
});

test('findCollisions: different rows in the same column is a valid split, not a collision', () => {
	assert.deepEqual(
		findCollisions([
			{ path: 'a', column: 0, row: 0 },
			{ path: 'b', column: 0, row: 1 }
		]),
		[]
	);
});

test('findCollisions: reports every entry in a three-way collision', () => {
	const collisions = findCollisions([
		{ path: 'a', column: 1, row: 2 },
		{ path: 'b', column: 1, row: 2 },
		{ path: 'c', column: 1, row: 2 }
	]);
	assert.equal(collisions.length, 1);
	assert.deepEqual(collisions[0].paths, ['a', 'b', 'c']);
	assert.deepEqual(collisions[0].indexes, [0, 1, 2]);
});

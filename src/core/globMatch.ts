import * as path from 'path';

/*
 * Glob syntax used in set paths: "*" (any run of characters except a separator), "**" (zero or more
 * whole segments), "?" (one character except a separator) and "{a,b}" (alternatives, no nesting).
 * Everything else, including "[", is literal.
 */

const IS_WINDOWS: boolean = path.sep === '\\';

function hasGlobCharacter(segment: string): boolean {
	return /[*?{]/.test(segment);
}

/*
 * Splits a resolved absolute pattern at its first segment containing a glob character. The segments
 * before it form the base directory to walk; the rest (joined with "/") is matched against paths
 * relative to it. A pattern without glob characters is returned whole as the base directory.
 */
export function splitGlobPattern(pattern: string): { baseDir: string; remainder: string } {
	const segments: string[] = pattern.split(IS_WINDOWS ? /[\\/]/ : '/');
	const firstGlob: number = segments.findIndex(hasGlobCharacter);
	if (firstGlob === -1) {
		return { baseDir: path.normalize(segments.join('/')), remainder: '' };
	}

	let prefix: string = segments.slice(0, firstGlob).join('/');
	if (prefix === '' || /^[A-Za-z]:$/.test(prefix)) {
		prefix += '/';
	}
	return { baseDir: path.normalize(prefix), remainder: segments.slice(firstGlob).join('/') };
}

function escapeLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/* Translates glob text to regex source; `inAlternative` disables "**" segment handling. */
function translate(text: string, inAlternative: boolean): string {
	let source: string = '';
	let i: number = 0;
	while (i < text.length) {
		const c: string = text[i];
		if (c === '*') {
			let end: number = i;
			while (text[end] === '*') {
				end++;
			}

			const wholeSegment: boolean = !inAlternative && end - i === 2 && (i === 0 || text[i - 1] === '/') && (end === text.length || text[end] === '/');
			if (wholeSegment && end === text.length) {
				source += '.+';
			} else if (wholeSegment) {
				source += '(?:[^/]+/)*';
				end++;
			} else {
				source += '[^/]*';
			}
			i = end;
		} else if (c === '?') {
			source += '[^/]';
			i++;
		} else if (c === '{' && !inAlternative && text.indexOf('}', i) !== -1) {
			const close: number = text.indexOf('}', i);
			const alternatives: string[] = text
				.slice(i + 1, close)
				.split(',')
				.map((alternative) => translate(alternative, true));
			source += '(?:' + alternatives.join('|') + ')';
			i = close + 1;
		} else {
			source += escapeLiteral(c);
			i++;
		}
	}
	return source;
}

/* Compiles a remainder once into a function testing "/"-separated paths relative to the base directory. */
export function compileGlob(remainder: string, caseSensitive: boolean = true): (relativePath: string) => boolean {
	const normalizedRemainder: string = IS_WINDOWS ? remainder.replace(/\\/g, '/') : remainder;
	const regex: RegExp = new RegExp('^' + translate(normalizedRemainder, false) + '$', caseSensitive ? '' : 'i');
	return (relativePath: string): boolean => regex.test(IS_WINDOWS ? relativePath.replace(/\\/g, '/') : relativePath);
}

/* Whether a path relative to the base directory (using "/" separators) matches the whole remainder. */
export function matchesGlob(remainder: string, relativePath: string, caseSensitive: boolean = true): boolean {
	return compileGlob(remainder, caseSensitive)(relativePath);
}

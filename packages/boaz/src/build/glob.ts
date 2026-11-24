/**
 * A deliberately small glob matcher: `*`, `?`, `**`, and `{a,b}`. Build tools
 * only need these, and one less dependency is one less install to explain.
 */
export interface GlobMatcher {
  pattern: string;
  test(path: string): boolean;
}

function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{');
  if (start === -1) return [pattern];
  let depth = 0;
  for (let i = start; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const head = pattern.slice(0, start);
        const tail = pattern.slice(i + 1);
        const options: string[] = [];
        let current = '';
        let inner = 0;
        for (const innerChar of pattern.slice(start + 1, i)) {
          if (innerChar === ',') {
            if (inner === 0) {
              options.push(current);
              current = '';
            } else {
              current += innerChar;
            }
            continue;
          }
          if (innerChar === '{') inner += 1;
          if (innerChar === '}') inner -= 1;
          current += innerChar;
        }
        options.push(current);
        return options.flatMap((option) => expandBraces(`${head}${option}${tail}`));
      }
    }
  }
  return [pattern];
}

function toRegExpSource(pattern: string): string {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*') {
      if (next === '*') {
        // "**/" matches zero or more directories; a bare "**" matches anything.
        if (pattern[i + 2] === '/') {
          source += '(?:[^/]+/)*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char !== undefined && '.+^$()[]|\\'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return source;
}

export function compileGlob(pattern: string): RegExp {
  return new RegExp(`^${toRegExpSource(pattern)}$`);
}

export function createMatcher(patterns: string[]): GlobMatcher {
  const expanded = patterns.flatMap(expandBraces);
  const regexps = expanded.map((pattern) => ({ pattern, regexp: compileGlob(pattern) }));
  return {
    pattern: patterns.join(', '),
    test(candidate: string): boolean {
      return regexps.some(({ regexp }) => regexp.test(candidate));
    },
  };
}

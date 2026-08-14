/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Just enough of a JavaScript lexer to tell a function literal from an
// expression, for callers that must decide from the source form alone. A parser
// would be more exact, but the repo ships no runtime one and reaching into
// Playwright's bundled Babel would add a deep private import for one question.

const whitespace = /\s/;
const identifierStart = /^[\p{ID_Start}$_][\p{ID_Continue}$]*/u;

/**
 * Whether `source` is a function literal -- `() => {}`, `function () {}`,
 * `async x => x` -- as opposed to an expression that may merely evaluate to one.
 */
export function isFunctionSource(source: string): boolean {
  let body = source.slice(skipTrivia(source, 0));
  for (;;) {
    const afterAsync = body.slice(skipAsyncKeyword(body));
    if (/^function\b/.test(afterAsync) || hasArrowHead(afterAsync))
      return true;
    // `(() => 1)` and `(function () {})` are function literals inside grouping
    // parentheses. Look inside before concluding this is an expression.
    const inner = stripEnclosingParens(body);
    if (inner === null)
      return false;
    body = inner.slice(skipTrivia(inner, 0));
  }
}

function skipAsyncKeyword(source: string): number {
  const keyword = /^async\b/.exec(source)?.[0];
  return keyword ? skipTrivia(source, keyword.length) : 0;
}

/**
 * Matches the head of an arrow function -- `x =>`, `(a, b) =>` -- without
 * matching a parenthesised expression such as `(a + b)`. The `async` keyword is
 * already stripped by the caller.
 */
function hasArrowHead(source: string): boolean {
  let offset = 0;
  if (source[0] === '(') {
    const end = matchingParen(source, 0);
    // The scanner does not model every parameter-list construct. When the match
    // cannot be found, call it a function: passing a function through is the
    // conservative answer, since a wrongly wrapped function fails silently
    // while a wrongly passed-through expression fails loudly.
    if (end === -1)
      return true;
    offset = end + 1;
  } else {
    const identifier = identifierStart.exec(source)?.[0];
    if (!identifier)
      return false;
    offset = identifier.length;
  }
  return source.startsWith('=>', skipTrivia(source, offset));
}

function stripEnclosingParens(source: string): string | null {
  if (source[0] !== '(')
    return null;
  const end = matchingParen(source, 0);
  // Only a group that wraps the whole source: `(a) => a` closes early and its
  // parentheses are a parameter list, not a group.
  if (end === -1 || skipTrivia(source, end + 1) !== source.length)
    return null;
  return source.slice(1, end);
}

function matchingParen(source: string, start: number): number {
  return matchingDelimiter(source, start, '(', ')');
}

/**
 * Finds the delimiter closing the one at `start`, stepping over comments,
 * strings, template substitutions and regular expression literals so that a
 * bracket inside any of them is not counted.
 */
function matchingDelimiter(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let offset = start; offset < source.length; offset++) {
    const char = source[offset];
    if (char === '/' && (source[offset + 1] === '/' || source[offset + 1] === '*')) {
      const end = skipTrivia(source, offset);
      if (end === offset)
        return -1;
      offset = end - 1;
    } else if (char === '"' || char === '\'' || char === '`') {
      const end = endOfString(source, offset);
      if (end === -1)
        return -1;
      offset = end;
    } else if (char === '/' && startsRegex(source, offset)) {
      const end = endOfRegex(source, offset);
      if (end === -1)
        return -1;
      offset = end;
    } else if (char === open) {
      depth++;
    } else if (char === close) {
      depth--;
      if (!depth)
        return offset;
    }
  }
  return -1;
}

function endOfString(source: string, start: number): number {
  const quote = source[start];
  for (let offset = start + 1; offset < source.length; offset++) {
    const char = source[offset];
    if (char === '\\') {
      offset++;
    } else if (quote === '`' && char === '$' && source[offset + 1] === '{') {
      // A substitution can hold anything, including another template.
      const end = matchingDelimiter(source, offset + 1, '{', '}');
      if (end === -1)
        return -1;
      offset = end;
    } else if (char === quote) {
      return offset;
    }
  }
  return -1;
}

// A slash directly after a value is division; anywhere else it opens a regular
// expression. Parameter defaults are the case that matters here: `(a = /)/)`.
function startsRegex(source: string, offset: number): boolean {
  let index = offset - 1;
  while (index >= 0 && whitespace.test(source[index]))
    index--;
  return index < 0 || !/[\w$)\]]/.test(source[index]);
}

function endOfRegex(source: string, start: number): number {
  let inCharacterClass = false;
  for (let offset = start + 1; offset < source.length; offset++) {
    const char = source[offset];
    if (char === '\\')
      offset++;
    else if (char === '\n')
      return -1;
    else if (inCharacterClass)
      inCharacterClass = char !== ']';
    else if (char === '[')
      inCharacterClass = true;
    else if (char === '/')
      return offset;
  }
  return -1;
}

/** Offset of the first character at or after `offset` that is not whitespace or a comment. */
function skipTrivia(source: string, offset: number): number {
  for (;;) {
    while (offset < source.length && whitespace.test(source[offset]))
      offset++;
    if (source.startsWith('//', offset)) {
      const lineEnd = source.indexOf('\n', offset);
      if (lineEnd === -1)
        return source.length;
      offset = lineEnd + 1;
    } else if (source.startsWith('/*', offset)) {
      const commentEnd = source.indexOf('*/', offset + 2);
      if (commentEnd === -1)
        return source.length;
      offset = commentEnd + 2;
    } else {
      return offset;
    }
  }
}

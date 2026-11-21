/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import path from 'node:path';

import { definePlugin, defineRule } from '@oxlint/plugins';

import type { Comment } from '@oxlint/plugins';

type Options = [{ baseline?: Record<string, number> }?];

const directive = /^\s*(?:eslint|oxlint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck)/;
const annotation = /^\*\s*@(?:public|internal)\s*$/;

function isExempt(comment: Comment, sourceText: string): boolean {
  if (comment.type === 'Shebang' || directive.test(comment.value) || annotation.test(comment.value) || comment.value.startsWith('/ <reference'))
    return true;
  return comment.type === 'Block' && comment.value.includes('Copyright') && !sourceText.slice(0, comment.start).replace(/^#!.*/, '').trim();
}

const noComments = defineRule({
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow comments. Record decisions in docs/decisions/, file issues for workarounds, and delete the rest (/delete-comment).',
    },
    messages: {
      banned: 'Comments are not allowed here. Delete a tautology or stale note, move a decision into docs/decisions/, or file an issue for a workaround (/delete-comment).',
      overBaseline: 'This file has {{count}} comments; the ratchet allows {{allowed}}. Remove the new ones with /delete-comment.',
      lowerBaseline: 'This file now has {{count}} comments; lower its comments/no-comments baseline in .oxlintrc.json from {{allowed}} to {{count}}.',
    },
    schema: [{
      type: 'object',
      properties: { baseline: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } } },
      additionalProperties: false,
    }],
  },
  create(context) {
    const [{ baseline = {} } = {}] = context.options as Options;
    const file = path.relative(context.cwd, context.filename).split(path.sep).join('/');
    const allowed = baseline[file] ?? 0;
    return {
      Program(program) {
        const prose = context.sourceCode.getAllComments().filter(comment => !isExempt(comment, context.sourceCode.text));
        const data = { count: prose.length, allowed };
        if (allowed === 0) {
          for (const comment of prose)
            context.report({ node: comment, messageId: 'banned' });
        } else if (prose.length > allowed) {
          context.report({ node: prose[0], messageId: 'overBaseline', data });
        } else if (prose.length < allowed) {
          context.report({ node: program, messageId: 'lowerBaseline', data });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: 'comments' },
  rules: { 'no-comments': noComments },
});

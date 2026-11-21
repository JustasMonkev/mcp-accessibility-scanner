/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import { definePlugin, defineRule } from '@oxlint/plugins';

import type { Comment } from '@oxlint/plugins';

type Options = [{ allowed?: number }?];

const directive = /^\s*(?:eslint|oxlint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck)/;
const annotation = /^\*\s*@(?:public|internal)\s*$/;
const licenceNotice = /Copyright|SPDX-License-Identifier|@license/i;

function isExempt(comment: Comment, firstStatementStart: number): boolean {
  if (comment.type === 'Shebang' || directive.test(comment.value) || annotation.test(comment.value) || comment.value.startsWith('/ <reference'))
    return true;
  return comment.end <= firstStatementStart && licenceNotice.test(comment.value);
}

const noComments = defineRule({
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow comments: record decisions in docs/decisions/, file issues for workarounds, and delete the rest.',
    },
    messages: {
      banned: 'Comments are not allowed here. Delete a tautology or stale note, move a decision into docs/decisions/, or file an issue for a workaround.',
      overAllowance: 'This file has {{count}} comments; its comments/no-comments override allows {{allowed}}. Remove the new ones.',
      lowerAllowance: 'This file now has {{count}} comments; lower its comments/no-comments "allowed" in .oxlintrc.json from {{allowed}} to {{count}}.',
    },
    schema: [{
      type: 'object',
      properties: { allowed: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    }],
  },
  create(context) {
    const [{ allowed = 0 } = {}] = context.options as Options;
    return {
      Program(program) {
        const firstStatementStart = program.body[0]?.start ?? Infinity;
        const prose = context.sourceCode.getAllComments().filter(comment => !isExempt(comment, firstStatementStart));
        const data = { count: prose.length, allowed };
        if (allowed === 0) {
          for (const comment of prose)
            context.report({ node: comment, messageId: 'banned' });
        } else if (prose.length > allowed) {
          context.report({ node: prose[0], messageId: 'overAllowance', data });
        } else if (prose.length < allowed) {
          context.report({ node: program, messageId: 'lowerAllowance', data });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: 'comments' },
  rules: { 'no-comments': noComments },
});

import { z } from 'zod';
import AxeBuilder from '@axe-core/playwright';

import { defineTool } from './tool.js';
import { tagValues } from './snapshot.js';

const scanHtmlSchema = z.object({
  html: z.string().describe('HTML content to scan'),
  elementSelector: z.string().optional().describe('CSS selector of the element to scan. Scans entire document if not provided.'),
  violationsTag: z
      .array(z.enum(tagValues))
      .min(1)
      .optional()
      .describe('Array of tags to filter violations by. If not specified, all violations are returned.'),
});

const scanHtml = defineTool({
  capability: 'core',
  schema: {
    name: 'scan_html',
    title: 'Scan provided HTML for accessibility violations',
    description: 'Scan provided HTML snippet for accessibility violations using Axe',
    inputSchema: scanHtmlSchema,
    type: 'readOnly',
  },

  handle: async (context, params) => {
    const tab = await context.newTab();
    await tab.page.setContent(params.html);

    let builder = new AxeBuilder({ page: tab.page });
    if (params.elementSelector)
      builder = builder.include(params.elementSelector);
    if (params.violationsTag)
      builder = builder.withTags(params.violationsTag);

    const results = await builder.analyze();
    await tab.page.close();

    return {
      code: [`// Scan provided HTML${params.elementSelector ? ` for selector: ${params.elementSelector}` : ''}`],
      captureSnapshot: false,
      waitForNetwork: false,
      resultOverride: {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      },
    };
  },
});

export default [scanHtml];

import { z } from 'zod';
import { defineTool, type ToolFactory } from './tool.js';

const htmlScan: ToolFactory = captureSnapshot => defineTool({
  capability: 'core',

  schema: {
    name: 'html_scan',
    title: 'Scan HTML',
    description: 'Scan HTML content with a selector and return the outer HTML of the matching element.',
    inputSchema: z.object({
      html: z.string().describe('The HTML content to scan.'),
      selector: z.string().describe('The selector to find the element.'),
    }),
    type: 'readOnly',
  },

  handle: async (context, params) => {
    const tab = await context.ensureTab();
    await tab.page.setContent(params.html);
    const locator = tab.page.locator(params.selector);
    const outerHTML = await locator.evaluate(element => element.outerHTML);

    return {
      code: [],
      captureSnapshot: false,
      waitForNetwork: false,
      resultOverride: {
        content: [{
          type: 'text',
          text: outerHTML,
        }]
      }
    };
  },
});

export default (captureSnapshot: boolean) => [
  htmlScan(captureSnapshot),
];

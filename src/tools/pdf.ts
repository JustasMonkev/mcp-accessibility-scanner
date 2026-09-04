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

import { z } from 'zod';
import { defineTabTool } from './tool.js';

import * as javascript from '../utils/codegen.js';
import { safeIsoTimestampForFileName } from '../utils/fileUtils.js';

const pdfSchema = z.object({
  filename: z.string().optional().describe('File name to save the pdf to. Existing files are never overwritten. Defaults to `page-{timestamp}-{token}.pdf` if not specified.'),
});

const pdf = defineTabTool({
  capability: 'pdf',

  schema: {
    name: 'browser_pdf_save',
    title: 'Save as PDF',
    description: 'Save page as PDF',
    inputSchema: pdfSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    // Random token besides the timestamp: see browser_take_screenshot — two
    // sessions saving a PDF in the same millisecond must not collide.
    const fileName = await tab.context.outputFile(params.filename ?? `page-${safeIsoTimestampForFileName()}.pdf`, params.filename !== undefined);
    if (params.filename !== undefined)
      response.deleteFileOnError(fileName);
    response.addCode(`await page.pdf(${javascript.formatObject({ path: fileName })});`);
    response.addResult(`Saved page as ${fileName}`);
    await tab.page.pdf({ path: fileName });
  },
});

export default [
  pdf,
];

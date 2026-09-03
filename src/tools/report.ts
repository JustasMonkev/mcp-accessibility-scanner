import fs from 'node:fs';
import { sanitizeForFilePath } from '../utils/fileUtils.js';
import type { Response } from '../response.js';

export type JsonReportResource = {
  path: string;
  uri: string;
  name: string;
  title: string | null;
  mimeType: string | null;
};

/**
 * Every audit tool ends its run the same way: sanitize the report file name,
 * resolve it through the context's output directory, write the JSON payload,
 * link the file into the response, and mirror the link as the structured
 * `report` field. The returned object is exactly that field, so the four
 * copies of this epilogue cannot drift apart.
 */
export async function writeJsonReport(
  context: { outputFile: (fileName: string) => Promise<string> },
  response: Response,
  fileName: string,
  report: unknown,
  resource: { name: string; title: string; description: string }
): Promise<JsonReportResource> {
  const path = await context.outputFile(sanitizeForFilePath(fileName));
  await fs.promises.writeFile(path, JSON.stringify(report, null, 2), 'utf-8');
  const link = response.addFileResourceLink(path, { ...resource, mimeType: 'application/json' });
  return {
    path,
    uri: link.uri,
    name: link.name,
    title: link.title ?? null,
    mimeType: link.mimeType ?? null,
  };
}

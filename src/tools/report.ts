import fs from 'node:fs';
import { safeIsoTimestampForFileName } from '../utils/fileUtils.js';

import type { Context } from '../context.js';
import type { Response } from '../response.js';

export type JsonReportResource = {
  path: string;
  uri: string;
  name: string;
  title: string | null;
  mimeType: string | null;
};

export async function reserveReportPath(context: Context, response: Response, reportFile: string | undefined, defaultPrefix: string): Promise<string> {
  const userChoseName = reportFile !== undefined;
  const reportPath = await context.outputFile(reportFile ?? `${defaultPrefix}-${safeIsoTimestampForFileName()}.json`, userChoseName);
  if (userChoseName)
    response.deleteFileOnError(reportPath);
  return reportPath;
}

export function fileResource(
  response: Response,
  path: string,
  resource: { name: string; title: string; description: string; mimeType: string }
): JsonReportResource {
  const link = response.addFileResourceLink(path, resource);
  return {
    path: response.formatFilePath(path),
    uri: link.uri,
    name: link.name,
    title: link.title ?? null,
    mimeType: link.mimeType ?? null,
  };
}

export async function writeJsonReport(
  response: Response,
  path: string,
  report: unknown,
  resource: { name: string; title: string; description: string }
): Promise<JsonReportResource> {
  await fs.promises.writeFile(path, JSON.stringify(report, null, 2), 'utf-8');
  return fileResource(response, path, { ...resource, mimeType: 'application/json' });
}

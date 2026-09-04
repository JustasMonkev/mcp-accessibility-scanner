import fs from 'node:fs';
import type { Response } from '../response.js';

export type JsonReportResource = {
  path: string;
  uri: string;
  name: string;
  title: string | null;
  mimeType: string | null;
};

export async function writeJsonReport(
  response: Response,
  path: string,
  report: unknown,
  resource: { name: string; title: string; description: string }
): Promise<JsonReportResource> {
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

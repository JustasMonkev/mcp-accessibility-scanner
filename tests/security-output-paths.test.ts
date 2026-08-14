import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outputFile } from '../src/config.js';
import { sanitizeForFilePath } from '../src/utils/fileUtils.js';
import type { FullConfig } from '../src/config.js';

// Report and screenshot names come straight from a tool argument. Containment
// inside the output directory is what stops a prompt-injected filename from
// writing anywhere on the host.

let outputDir: string;
let config: FullConfig;

beforeAll(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-output-paths-'));
  config = { outputDir } as unknown as FullConfig;
});

afterAll(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

const traversalAttempts = [
  '../../../etc/passwd',
  '..\\..\\..\\Windows\\System32\\drivers\\etc\\hosts',
  '/etc/passwd',
  '/../../etc/shadow',
  'C:\\Windows\\system32\\config\\sam',
  'a/../../b.json',
  '....//....//etc/x',
  '..%2f..%2fetc%2fpasswd',
  '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '..;/etc/passwd',
  'report.json\u0000.png',
  '\u0000/etc/passwd',
  'x/./y.json',
  '..',
  '.',
  './.',
  'nested/dir/report.json',
  '~/secrets.json',
  '$HOME/secrets.json',
  '\uFF0E\uFF0E\uFF0Fetc\uFF0Fpasswd',
  'a\nb/../c.json',
  'a\r\n/etc/passwd',
  'con.json',
  'report.json ',
  ' ../report.json',
];

describe('output path containment', () => {
  it.each(traversalAttempts)('keeps %j inside the output directory', async candidate => {
    const resolved = await outputFile(config, candidate);
    const relative = path.relative(outputDir, resolved);

    // Either the file sits directly in outputDir, or it collapsed onto the
    // directory itself — never outside it, and never in a subdirectory.
    expect(path.isAbsolute(relative)).toBe(false);
    expect(relative.startsWith('..')).toBe(false);
    expect(relative).not.toContain(path.sep);
  });

  it('reduces every candidate to a single path component', () => {
    for (const candidate of traversalAttempts) {
      const sanitized = sanitizeForFilePath(candidate);
      expect(sanitized, candidate).not.toContain('/');
      expect(sanitized, candidate).not.toContain('\\');
      expect(sanitized, candidate).not.toContain('\u0000');
      // At most one dot survives, at the extension boundary, so ".." can never
      // be reconstructed from a sanitized name.
      expect((sanitized.match(/\./g) ?? []).length, candidate).toBeLessThanOrEqual(1);
    }
  });

  it('is idempotent, because tools sanitize once and outputFile sanitizes again', () => {
    for (const candidate of [...traversalAttempts, 'audit-site-2026-01-01T00-00-00.000Z-abcd1234.json'])
      expect(sanitizeForFilePath(sanitizeForFilePath(candidate)), candidate).toBe(sanitizeForFilePath(candidate));
  });

  it('actually writes inside the output directory for a traversal attempt', async () => {
    const resolved = await outputFile(config, '../../escaped.json');
    await fs.promises.writeFile(resolved, '{}', 'utf-8');

    expect(fs.existsSync(resolved)).toBe(true);
    expect(path.dirname(resolved)).toBe(outputDir);
    // Nothing appeared beside the output directory.
    expect(fs.existsSync(path.join(outputDir, '..', 'escaped.json'))).toBe(false);
  });

  it('preserves an ordinary name unchanged', async () => {
    const resolved = await outputFile(config, 'audit-report.json');
    expect(path.basename(resolved)).toBe('audit-report.json');
  });
});

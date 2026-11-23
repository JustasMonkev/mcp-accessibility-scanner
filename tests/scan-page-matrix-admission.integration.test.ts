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

import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { BrowserServerBackend } from '../src/browserServerBackend.js';
import { contextFactory } from '../src/browserContextFactory.js';
import { resolveCLIConfig, resolveConfig } from '../src/config.js';
import { wrapInProcess } from '../src/mcp/server.js';

const resizeWaiters: (() => void)[] = [];
const darkWaiters: (() => void)[] = [];
// The image without alt text is only rendered at narrow widths, so a variant
// scanned at the wrong viewport changes the finding.
const server = http.createServer((request, response) => {
  if (request.url === '/resized') {
    for (const wake of resizeWaiters.splice(0))
      wake();
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.url === '/dark-applied') {
    for (const wake of darkWaiters.splice(0))
      wake();
    response.writeHead(204);
    response.end();
    return;
  }
  // The image without alt text is only rendered in dark mode, so a dark
  // variant scanned in light mode loses the finding.
  if (request.url === '/dark-mode') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html lang="en"><title>Dark</title>
      <style>img { display: none } @media (prefers-color-scheme: dark) { img { display: block } }</style>
      <main><h1>Dark</h1><img src="/missing.png" width="10" height="10"></main>
      <script>matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => { if (event.matches) fetch('/dark-applied'); });</script></html>`);
    return;
  }
  if (request.url === '/dialog') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html lang="en"><title>Dialog</title><main><h1>Dialog</h1></main>
      <script>addEventListener('resize', () => { if (innerWidth < 500) alert('narrow layout'); });</script></html>`);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><html lang="en"><title>Matrix</title>
    <style>img { display: none } @media (max-width: 500px) { img { display: block } }</style>
    <main><h1>Matrix</h1><img src="/missing.png" width="10" height="10"></main>
    <script>addEventListener('resize', () => { if (innerWidth < 500) fetch('/resized'); });</script></html>`);
});
let client: Client;
let directory: string;
let origin: string;

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

function withinMs<T>(promise: Promise<T>, ms: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} did not return within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function evaluateUntil(target: Client, expression: string, expected: string): Promise<string> {
  let last = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    last = text(await target.callTool({ name: 'browser_evaluate', arguments: { function: expression } }));
    if (last.includes(expected))
      return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return last;
}

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP fixture server');
  origin = `http://127.0.0.1:${address.port}`;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-page-matrix-admission-'));
  const config = await resolveCLIConfig({ browser: 'chromium', headless: true, isolated: true, outputDir: directory, viewportSize: '1280,720' });
  client = new Client({ name: 'scan-page-matrix-admission-test', version: '1' });
  await client.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));
  const navigated = await client.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/` } });
  expect(navigated.isError, text(navigated)).not.toBe(true);
});

afterAll(async () => {
  try {
    await client?.callTool({ name: 'browser_close', arguments: {} });
  } finally {
    await client?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory)
      await fs.rm(directory, { recursive: true, force: true });
  }
});

it('rejects an overlapping matrix scan so neither call measures or restores the other\'s variant', async () => {
  const mobileApplied = new Promise<void>(resolve => resizeWaiters.push(resolve));
  const first = client.callTool({ name: 'scan_page_matrix', arguments: {
    reportFile: 'first.json', waitAfterApplyMs: 1500, withRules: ['image-alt'],
    variants: [{ name: 'baseline' }, { name: 'mobile', viewport: { width: 375, height: 812 } }],
  } });
  await mobileApplied;

  // Started while the first call holds the mobile viewport: admitted, it would
  // capture 375px as the original, switch the first call's mobile scan to
  // 1280px, and restore 375px after the first call finished.
  const overlapping = await client.callTool({ name: 'scan_page_matrix', arguments: {
    reportFile: 'overlapping.json', waitAfterApplyMs: 3000, withRules: ['image-alt'],
    variants: [{ name: 'desktop', viewport: { width: 1280, height: 720 } }],
  } });
  expect(overlapping.isError).toBe(true);
  expect(text(overlapping)).toContain('is busy');

  const firstResult = await first;
  expect(firstResult.isError, text(firstResult)).not.toBe(true);
  const report = JSON.parse(await fs.readFile(path.join(directory, 'first.json'), 'utf8'));
  expect(report.variants.map((variant: { name: string, nodeCountByRuleId: Record<string, number> }) => [variant.name, variant.nodeCountByRuleId])).toEqual([
    ['baseline', {}],
    ['mobile', { 'image-alt': 1 }],
  ]);

  const viewport = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => `${innerWidth}x${innerHeight}`' } });
  expect(text(viewport)).toContain('1280x720');
});

it('reports a dialog opened by a variant and restores the original state once it is answered', async () => {
  const navigated = await client.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/dialog` } });
  expect(navigated.isError, text(navigated)).not.toBe(true);
  const state = '() => `${innerWidth}x${innerHeight} zoom=${document.documentElement.style.zoom || "none"} dark=${matchMedia("(prefers-color-scheme: dark)").matches}`';
  expect(text(await client.callTool({ name: 'browser_evaluate', arguments: { function: state } }))).toContain('1280x720 zoom=none dark=false');

  // The alert pauses the page, so every later page command waits on it; the
  // scan must not hold the context until something answers the dialog.
  const scan = await withinMs(client.callTool({ name: 'scan_page_matrix', arguments: {
    reportFile: 'dialog.json', waitAfterApplyMs: 1000, withRules: ['image-alt'],
    variants: [{ name: 'baseline' }, { name: 'narrow', viewport: { width: 375, height: 812 }, media: { colorScheme: 'dark' }, zoomPercent: 150 }],
  } }), 15_000, 'scan_page_matrix');
  expect(scan.isError).toBe(true);
  expect(text(scan)).toContain('opened a dialog during variant "narrow"');
  expect(text(scan)).toContain('narrow layout');
  await expect(fs.access(path.join(directory, 'dialog.json'))).rejects.toThrow();

  // The restore is still pending, so a page change now would be overwritten by it.
  const resize = await withinMs(client.callTool({ name: 'browser_resize', arguments: { width: 900, height: 600 } }), 15_000, 'browser_resize');
  expect(resize.isError).toBe(true);
  expect(text(resize)).toContain('busy because "scan_page_matrix" requires exclusive access');

  const answered = await withinMs(client.callTool({ name: 'browser_handle_dialog', arguments: { accept: true } }), 15_000, 'browser_handle_dialog');
  expect(answered.isError, text(answered)).not.toBe(true);
  expect(await evaluateUntil(client, state, '1280x720 zoom=none dark=false')).toContain('1280x720 zoom=none dark=false');

  // The page claim is released after the restore, so the page can be scanned again.
  const again = await client.callTool({ name: 'scan_page_matrix', arguments: {
    reportFile: 'after-dialog.json', withRules: ['image-alt'], variants: [{ name: 'baseline' }],
  } });
  expect(again.isError, text(again)).not.toBe(true);

  // Once restored, page changes are admitted and survive.
  const resized = await client.callTool({ name: 'browser_resize', arguments: { width: 900, height: 600 } });
  expect(resized.isError, text(resized)).not.toBe(true);
  expect(await evaluateUntil(client, state, '900x600')).toContain('900x600 zoom=none dark=false');
  await client.callTool({ name: 'browser_resize', arguments: { width: 1280, height: 720 } });
});

it('rejects page changes from another client sharing the browser context while a matrix scan holds the page', async () => {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const config = await resolveConfig({ browser: { cdpEndpoint: `http://127.0.0.1:${port}`, cdpTimeout: 5000 }, outputDir: directory });
  // One server, two connections: each gets its own MCP context, but both
  // attach to the browser's existing context and so share its page.
  const factory = contextFactory(config);
  const clients = [new Client({ name: 'matrix-client-a', version: '1' }), new Client({ name: 'matrix-client-b', version: '1' })];
  try {
    for (const each of clients)
      await each.connect(await wrapInProcess(new BrowserServerBackend(config, factory)));
    const [first, second] = clients;
    const navigated = await first.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/dark-mode` } });
    expect(navigated.isError, text(navigated)).not.toBe(true);
    const attached = await second.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
    expect(text(attached)).toContain(`${origin}/dark-mode`);

    const darkApplied = new Promise<void>(resolve => darkWaiters.push(resolve));
    const firstScan = first.callTool({ name: 'scan_page_matrix', arguments: {
      reportFile: 'shared-first.json', waitAfterApplyMs: 2000, withRules: ['image-alt'],
      variants: [{ name: 'dark', media: { colorScheme: 'dark' } }],
    } });
    await darkApplied;

    // Admitted, this would switch the page back to light mode while the first
    // client's report still records the variant as dark.
    const lightened = await second.callTool({ name: 'browser_emulate_media', arguments: { colorScheme: 'light' } });
    expect(lightened.isError).toBe(true);
    expect(text(lightened)).toContain('busy because "scan_page_matrix"');

    // Admitted, this scan would record dark mode as the original state and
    // restore it after the first scan had already put the page back.
    const overlapping = await second.callTool({ name: 'scan_page_matrix', arguments: {
      reportFile: 'shared-second.json', waitAfterApplyMs: 3000, withRules: ['image-alt'],
      variants: [{ name: 'zoom-200', zoomPercent: 200 }],
    } });
    expect(overlapping.isError).toBe(true);
    expect(text(overlapping)).toContain('busy because "scan_page_matrix"');

    const firstResult = await firstScan;
    expect(firstResult.isError, text(firstResult)).not.toBe(true);
    const report = JSON.parse(await fs.readFile(path.join(directory, 'shared-first.json'), 'utf8'));
    expect(report.variants.map((variant: { name: string, nodeCountByRuleId: Record<string, number> }) => [variant.name, variant.nodeCountByRuleId])).toEqual([
      ['dark', { 'image-alt': 1 }],
    ]);

    // The claim ends with the scan, so the other client's page changes are admitted again.
    const dark = '() => `dark=${matchMedia("(prefers-color-scheme: dark)").matches}`';
    expect(text(await second.callTool({ name: 'browser_evaluate', arguments: { function: dark } }))).toContain('dark=false');
    const emulated = await second.callTool({ name: 'browser_emulate_media', arguments: { colorScheme: 'dark' } });
    expect(emulated.isError, text(emulated)).not.toBe(true);
    expect(text(await second.callTool({ name: 'browser_evaluate', arguments: { function: dark } }))).toContain('dark=true');
  } finally {
    for (const each of clients)
      await each.close();
    await browser.close();
  }
});

it('lets browser_close tear down a restore left waiting on a dialog when browser_handle_dialog is blocked', async () => {
  const config = await resolveCLIConfig({ browser: 'chromium', headless: true, isolated: true, outputDir: directory, viewportSize: '1280,720', blockedTools: ['browser_handle_dialog'] });
  const blocked = new Client({ name: 'scan-page-matrix-blocked-dialog-test', version: '1' });
  await blocked.connect(await wrapInProcess(new BrowserServerBackend(config, contextFactory(config))));
  try {
    const navigated = await blocked.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/dialog` } });
    expect(navigated.isError, text(navigated)).not.toBe(true);

    const scan = await withinMs(blocked.callTool({ name: 'scan_page_matrix', arguments: {
      reportFile: 'blocked-dialog.json', waitAfterApplyMs: 1000, withRules: ['image-alt'],
      variants: [{ name: 'baseline' }, { name: 'narrow', viewport: { width: 375, height: 812 } }],
    } }), 15_000, 'scan_page_matrix');
    expect(scan.isError).toBe(true);
    expect(text(scan)).toContain('opened a dialog during variant "narrow"');
    // The guidance must not send the client to a tool this server rejects.
    expect(text(scan)).toContain('would be handled by the "browser_handle_dialog" tool, but this server blocks it (blockedTools)');
    expect(text(scan)).not.toMatch(/answer it with browser_handle_dialog|can be handled by/);

    // Ordinary page changes still wait for the restore, but teardown cancels it.
    const resize = await withinMs(blocked.callTool({ name: 'browser_resize', arguments: { width: 900, height: 600 } }), 15_000, 'browser_resize');
    expect(text(resize)).toContain('busy because "scan_page_matrix" requires exclusive access');
    const closed = await withinMs(blocked.callTool({ name: 'browser_close', arguments: {} }), 15_000, 'browser_close');
    expect(closed.isError, text(closed)).not.toBe(true);

    const reopened = await blocked.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/` } });
    expect(reopened.isError, text(reopened)).not.toBe(true);
    const state = '() => `${innerWidth}x${innerHeight} zoom=${document.documentElement.style.zoom || "none"}`';
    expect(text(await blocked.callTool({ name: 'browser_evaluate', arguments: { function: state } }))).toContain('1280x720 zoom=none');
  } finally {
    await blocked.callTool({ name: 'browser_close', arguments: {} }).catch(() => {});
    await blocked.close();
  }
});

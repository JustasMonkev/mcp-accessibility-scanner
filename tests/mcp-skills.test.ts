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

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { SKILLS_EXTENSION_ID } from '@modelcontextprotocol/server/ext/skills';

import { createServer } from '../src/mcp/server.js';
import { InProcessTransport } from '../src/mcp/inProcessTransport.js';
import { allTools } from '../src/tools.js';
import { loadBundledSkills } from '../src/skills.js';

import type { SkillsExtension } from '@modelcontextprotocol/server/ext/skills';

const bundledSkillsRoot = path.join(import.meta.dirname, '..', 'skills');
const skillUri = 'skill://accessibility-audit/SKILL.md';
const anyResult = z.looseObject({});

function createBackend() {
  return {
    listTools: vi.fn(async () => [{ name: 'scan_page', inputSchema: { type: 'object' as const } }]),
    callTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
  };
}

async function connectClient(skills?: SkillsExtension) {
  const backend = createBackend();
  const server = createServer('Test', '1.0.0', backend, false, { skills });
  const client = new Client({ name: 'skills-test', version: '1' });
  await client.connect(new InProcessTransport(server));
  return { client, backend };
}

describe('bundled skills', () => {
  it('ships every skill folder as a valid catalog entry', async () => {
    const catalog = await loadBundledSkills();
    const folders = fs.readdirSync(bundledSkillsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
    expect(catalog.entries.map(skill => skill.uri).sort()).toEqual(folders.map(name => `skill://${name}/SKILL.md`).sort());
    for (const skill of catalog.entries)
      expect(skill.uri).toBe(`skill://${skill.frontmatter.name}/SKILL.md`);
  });

  it('publishes every file a skill links to', async () => {
    const catalog = await loadBundledSkills();
    for (const skill of catalog.entries) {
      expect(Array.isArray(skill.resources)).toBe(true);
      const published = new Set((skill.resources as { uri: string }[]).map(resource => resource.uri));
      const skillDir = path.join(bundledSkillsRoot, String(skill.frontmatter.name));
      const markdown = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      for (const [, target] of markdown.matchAll(/\]\(([^)#]+)\)/g)) {
        if (/^[a-z]+:/i.test(target))
          continue;
        expect(published, `${skill.uri} links to ${target}`).toContain(new URL(target, skill.uri).href);
      }
    }
  });

  it('names only tools the server defines', async () => {
    const toolNames = new Set(allTools.map(tool => tool.schema.name));
    const files = fs.readdirSync(bundledSkillsRoot, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.md'));
    for (const file of files) {
      const text = fs.readFileSync(path.join(bundledSkillsRoot, file), 'utf8');
      for (const [, name] of text.matchAll(/`((?:browser|scan|audit|get)_[a-z_]+)`/g))
        expect(toolNames, `${file} mentions ${name}`).toContain(name);
    }
  });
});

describe('skills over MCP', () => {
  it('declares the skills extension next to tools and serves skills/list, skills/get and resources/read', async () => {
    const { client, backend } = await connectClient(await loadBundledSkills());
    try {
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.tools).toEqual({ listChanged: true });
      expect(capabilities?.resources).toBeDefined();
      expect(capabilities?.extensions?.[SKILLS_EXTENSION_ID]).toBeDefined();

      const listed = await client.request({ method: 'skills/list', params: {} }, anyResult) as { skills: { uri: string, frontmatter: { name: string } }[] };
      expect(listed.skills).toEqual(expect.arrayContaining([expect.objectContaining({ uri: skillUri, frontmatter: expect.objectContaining({ name: 'accessibility-audit' }) })]));

      const got = await client.request({ method: 'skills/get', params: { uri: skillUri } }, anyResult) as { skill: { uri: string } };
      expect(got.skill.uri).toBe(skillUri);

      const read = await client.readResource({ uri: skillUri });
      expect(read.contents[0]).toMatchObject({ uri: skillUri, mimeType: 'text/markdown' });
      expect((read.contents[0] as { text: string }).text).toBe(fs.readFileSync(path.join(bundledSkillsRoot, 'accessibility-audit', 'SKILL.md'), 'utf8'));

      const reference = await client.readResource({ uri: 'skill://accessibility-audit/references/manual-checks.md' });
      expect((reference.contents[0] as { text: string }).text).toContain('# Checks automation cannot make');

      const resources = await client.listResources();
      expect(resources.resources.map(resource => resource.uri)).toContain(skillUri);

      // Tools keep going through the backend, not McpServer's own tool registry.
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['scan_page']);
      expect(await client.callTool({ name: 'scan_page', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
      expect(backend.callTool).toHaveBeenCalledWith('scan_page', {}, expect.anything());
    } finally {
      await client.close();
    }
  });

  it('rejects an unknown skill with invalid params', async () => {
    const { client } = await connectClient(await loadBundledSkills());
    try {
      await expect(client.request({ method: 'skills/get', params: { uri: 'skill://missing/SKILL.md' } }, anyResult)).rejects.toMatchObject({ code: -32602 });
    } finally {
      await client.close();
    }
  });

  it('declares neither resources nor skills when none are configured', async () => {
    const { client } = await connectClient();
    try {
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.tools).toEqual({ listChanged: true });
      expect(capabilities?.resources).toBeUndefined();
      expect(capabilities?.extensions?.[SKILLS_EXTENSION_ID]).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});

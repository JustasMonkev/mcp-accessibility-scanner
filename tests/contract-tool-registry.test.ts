import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { allTools, filteredTools } from '../src/tools.js';

// Contract tests over the REAL registry. tool-definitions.test.ts only
// exercises the defineTool helper with synthetic tools, so nothing checked
// what the server actually advertises.

function inputJsonSchema(tool: (typeof allTools)[number]): any {
  return z.toJSONSchema(tool.schema.inputSchema as any, { io: 'input' });
}

// Silently dropping a tool breaks every client that calls it, so a name only
// leaves this list through a deliberate edit.
const expectedToolNames = [
  'audit_keyboard',
  'audit_screen_reader',
  'audit_site',
  'browser_click',
  'browser_close',
  'browser_console_messages',
  'browser_default_timeout',
  'browser_drag',
  'browser_drop',
  'browser_evaluate',
  'browser_file_upload',
  'browser_fill_form',
  'browser_find',
  'browser_handle_dialog',
  'browser_hover',
  'browser_install',
  'browser_mouse_click_xy',
  'browser_mouse_drag_xy',
  'browser_mouse_move_xy',
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigation_timeout',
  'browser_network_request',
  'browser_network_requests',
  'browser_pdf_save',
  'browser_press_key',
  'browser_resize',
  'browser_select_option',
  'browser_session_close',
  'browser_session_open',
  'browser_snapshot',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_type',
  'browser_verify_element_visible',
  'browser_verify_list_visible',
  'browser_verify_text_visible',
  'browser_verify_value',
  'browser_wait_for',
  'scan_page',
  'scan_page_matrix',
];

describe('tool registry contract', () => {
  it('advertises exactly the documented tool set', () => {
    expect(allTools.map(t => t.schema.name).sort()).toEqual([...expectedToolNames].sort());
  });

  it('has no duplicate tool names', () => {
    const names = allTools.map(t => t.schema.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a name, title and description a client can render', () => {
    for (const tool of allTools) {
      expect(tool.schema.name, 'tool name').toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.schema.title?.trim(), `${tool.schema.name} title`).toBeTruthy();
      expect(tool.schema.description.trim().length, `${tool.schema.name} description`).toBeGreaterThan(10);
    }
  });

  it('declares only known capabilities and annotation types', () => {
    const knownCapabilities = new Set(['core', 'core-install', 'core-tabs', 'vision', 'pdf', 'verify', 'files']);
    // The three hints in ToolSchema (src/mcp/tool.ts) drive the MCP
    // readOnlyHint/destructiveHint/idempotentHint a client uses to decide
    // whether a retry is safe, so an unknown value here is not cosmetic.
    const knownTypes = new Set(['readOnly', 'stateChanging', 'destructive']);
    for (const tool of allTools) {
      expect(knownCapabilities, `${tool.schema.name} capability`).toContain(tool.capability);
      expect(knownTypes, `${tool.schema.name} type`).toContain(tool.schema.type);
    }
  });

  it('exposes every core tool by default and gates the opt-in capabilities', () => {
    const defaultNames = filteredTools({ capabilities: undefined } as any).map(t => t.schema.name);
    // `startsWith('core')` means core, core-install and core-tabs are always on.
    for (const tool of allTools.filter(t => t.capability.startsWith('core')))
      expect(defaultNames).toContain(tool.schema.name);
    for (const tool of allTools.filter(t => !t.capability.startsWith('core')))
      expect(defaultNames).not.toContain(tool.schema.name);

    const withVerify = filteredTools({ capabilities: ['verify'] } as any).map(t => t.schema.name);
    expect(withVerify).toContain('browser_verify_value');
    expect(withVerify).not.toContain('browser_pdf_save');
  });

  // Hands the page any absolute path on the server, so it must not be
  // reachable unless an operator asked for it. It used to be `core`.
  it('keeps browser_file_upload behind the opt-in files capability', () => {
    const uploadTool = allTools.find(t => t.schema.name === 'browser_file_upload')!;
    expect(uploadTool.capability).toBe('files');

    const defaultNames = filteredTools({ capabilities: undefined } as any).map(t => t.schema.name);
    expect(defaultNames).not.toContain('browser_file_upload');

    const withFiles = filteredTools({ capabilities: ['files'] } as any).map(t => t.schema.name);
    expect(withFiles).toContain('browser_file_upload');
  });

  it('produces a serializable JSON Schema for every tool', () => {
    for (const tool of allTools) {
      const json = inputJsonSchema(tool);
      expect(json, `${tool.schema.name} schema`).toBeTypeOf('object');
      expect(() => JSON.stringify(json), `${tool.schema.name} serializes`).not.toThrow();
    }
  });

  // Regression: both timeout tools enforced 30000-1200000 while advertising
  // "(0-300000ms)". The description is the only range a client sees.
  it('never advertises a numeric range that contradicts the enforced bounds', () => {
    const mismatches: string[] = [];
    for (const tool of allTools) {
      const json = inputJsonSchema(tool);
      for (const [field, prop] of Object.entries<any>(json.properties ?? {})) {
        if (prop?.type !== 'number' && prop?.type !== 'integer')
          continue;
        const range = /(\d[\d_]*)\s*-\s*(\d[\d_]*)/.exec(String(prop.description ?? ''));
        if (!range)
          continue;
        const [advertisedMin, advertisedMax] = [Number(range[1]), Number(range[2])];
        if (prop.minimum !== undefined && advertisedMin !== prop.minimum) {
          mismatches.push(
              `${tool.schema.name}.${field}: description says min ${advertisedMin}, schema enforces ${prop.minimum}`);
        }
        if (prop.maximum !== undefined && advertisedMax !== prop.maximum) {
          mismatches.push(
              `${tool.schema.name}.${field}: description says max ${advertisedMax}, schema enforces ${prop.maximum}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  // browser_find needs text-or-regex via a superRefine that JSON Schema
  // cannot carry, so its descriptions are all the client has to go on.
  it('explains cross-field requirements in the field descriptions', () => {
    for (const tool of allTools) {
      const json = inputJsonSchema(tool);
      if ((json.required ?? []).length)
        continue;
      if ((tool.schema.inputSchema as any).safeParse({}).success)
        continue;
      const descriptions = Object.values<any>(json.properties ?? {})
          .map(prop => String(prop?.description ?? '')).join(' ');
      expect(descriptions, `${tool.schema.name} rejects {} without saying why`)
          .toMatch(/either|required|provide|exactly one/i);
    }
  });

  // An empty reportFile resolves to the output directory itself, failing with
  // a bare EISDIR after the whole audit has run.
  it('rejects an empty reportFile rather than failing at write time', () => {
    const writers = allTools.filter(tool => 'reportFile' in (inputJsonSchema(tool).properties ?? {}));
    expect(writers.length).toBeGreaterThanOrEqual(4);
    for (const tool of writers) {
      const parsed = (tool.schema.inputSchema as any).safeParse({ reportFile: '' });
      expect(parsed.success, `${tool.schema.name} accepted an empty reportFile`).toBe(false);
    }
  });
});

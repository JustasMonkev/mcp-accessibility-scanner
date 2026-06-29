import { describe, expect, it, vi } from 'vitest';
import type { JSONSchema7 } from 'json-schema';
import snapshotTools from '../src/tools/snapshot.js';
import { toMcpTool } from '../src/mcp/tool.js';

describe('Snapshot Tools', () => {
  const snapshotTool = snapshotTools.find(tool => tool.schema.name === 'browser_snapshot')!;

  it('should expose browser_snapshot with optional compression', () => {
    const mcpTool = toMcpTool(snapshotTool.schema);
    const jsonSchema = mcpTool.inputSchema as JSONSchema7;
    const compressSchema = jsonSchema.properties?.compress as JSONSchema7;

    expect(snapshotTool).toBeDefined();
    expect(snapshotTool.schema.type).toBe('readOnly');
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.required ?? []).toEqual([]);
    expect(compressSchema.type).toBe('boolean');
    expect(snapshotTool.schema.inputSchema.parse({})).toEqual({});
    expect(snapshotTool.schema.inputSchema.parse({ compress: true })).toEqual({ compress: true });
    expect(snapshotTool.schema.inputSchema.parse({ compress: false })).toEqual({ compress: false });
  });

  it('should request the current snapshot flow with compression disabled by default', async () => {
    const context = {
      ensureTab: vi.fn().mockResolvedValue(undefined),
    };
    const response = {
      setIncludeSnapshot: vi.fn(),
    };

    await snapshotTool.handle(context as any, {}, response as any);

    expect(context.ensureTab).toHaveBeenCalled();
    expect(response.setIncludeSnapshot).toHaveBeenCalledWith(undefined);
  });

  it('should pass the compression option to the snapshot response', async () => {
    const context = {
      ensureTab: vi.fn().mockResolvedValue(undefined),
    };
    const response = {
      setIncludeSnapshot: vi.fn(),
    };

    await snapshotTool.handle(context as any, { compress: true }, response as any);

    expect(context.ensureTab).toHaveBeenCalled();
    expect(response.setIncludeSnapshot).toHaveBeenCalledWith(true);
  });

  it('should pass explicit compression opt-out to the snapshot response', async () => {
    const context = {
      ensureTab: vi.fn().mockResolvedValue(undefined),
    };
    const response = {
      setIncludeSnapshot: vi.fn(),
    };

    await snapshotTool.handle(context as any, { compress: false }, response as any);

    expect(context.ensureTab).toHaveBeenCalled();
    expect(response.setIncludeSnapshot).toHaveBeenCalledWith(false);
  });
});

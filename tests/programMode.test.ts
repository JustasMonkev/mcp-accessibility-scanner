import { describe, it, expect } from 'vitest';
import { resolveProgramMode } from '../src/programMode.js';

describe('resolveProgramMode', () => {
  it('defaults to standard mode', () => {
    expect(resolveProgramMode({})).toBe('default');
  });

  it('uses extension mode when extension flag is set', () => {
    expect(resolveProgramMode({ extension: true })).toBe('extension');
  });

  it('uses vscode mode when vscode flag is set', () => {
    expect(resolveProgramMode({ vscode: true })).toBe('vscode');
  });

  it('prioritizes extension mode over vscode mode', () => {
    expect(resolveProgramMode({ extension: true, vscode: true })).toBe('extension');
  });
});

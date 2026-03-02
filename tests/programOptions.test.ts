import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { configureProgramOptions } from '../src/programOptions.js';

describe('configureProgramOptions', () => {
  it('exposes --extension in help output', () => {
    const command = configureProgramOptions(new Command());
    const help = command.helpInformation();
    expect(help).toContain('--extension');
  });

  it('does not expose removed multi-agent options in help output', () => {
    const command = configureProgramOptions(new Command());
    const help = command.helpInformation();
    expect(help).not.toContain('--multi-agent');
    expect(help).not.toContain('--connect-tool');
  });

  it('parses --extension as an enabled option', () => {
    const command = configureProgramOptions(new Command());
    command.parse(['node', 'test', '--extension']);
    expect(command.opts().extension).toBe(true);
  });

  it('parses hidden --vscode option for compatibility', () => {
    const command = configureProgramOptions(new Command());
    command.parse(['node', 'test', '--vscode']);
    expect(command.opts().vscode).toBe(true);
  });
});

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

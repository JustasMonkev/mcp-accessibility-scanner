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

import type { z } from 'zod';
import type { Context } from '../context.js';
import type * as playwright from 'playwright';
import type { ToolCapability } from '../../config.js';
import type { Tab } from '../tab.js';
import type { Response } from '../response.js';
import type { ToolSchema } from '../mcp/tool.js';

type FileUploadModalState = {
  type: 'fileChooser';
  description: string;
  fileChooser: playwright.FileChooser;
};

type DialogModalState = {
  type: 'dialog';
  description: string;
  dialog: playwright.Dialog;
};

export type ModalState = FileUploadModalState | DialogModalState;

type ToolInputSchema = z.Schema<Record<string, unknown>>;

export type Tool<Input extends ToolInputSchema = ToolInputSchema> = {
  capability: ToolCapability;
  schema: ToolSchema<Input>;
  clearsModalState?: ModalState['type'];
  exclusive?: boolean;
  browserless?: boolean;
  handle: (context: Context, params: z.output<Input>, response: Response, signal?: AbortSignal) => Promise<void>;
};

export function defineTool<Input extends ToolInputSchema>(tool: Tool<Input>): Tool<Input> {
  return tool;
}

export type TabTool<Input extends ToolInputSchema = ToolInputSchema> = Omit<Tool<Input>, 'handle'> & {
  handle: (tab: Tab, params: z.output<Input>, response: Response, signal?: AbortSignal) => Promise<void>;
};

export function defineTabTool<Input extends ToolInputSchema>(tool: TabTool<Input>): Tool<Input> {
  return {
    ...tool,
    handle: async (context, params, response, signal) => {
      const tab = context.currentTabOrDie();
      const modalError = modalStateMismatchError(tool, tab);
      if (modalError)
        response.addError(`${modalError}\n${tab.modalStatesMarkdown().join('\n')}`);
      else
        await tool.handle(tab, params, response, signal);
    },
  };
}

function modalStateMismatchError<Input extends ToolInputSchema>(tool: TabTool<Input>, tab: Tab): string | undefined {
  const openModalTypes = tab.modalStates().map(state => state.type);
  if (tool.clearsModalState && !openModalTypes.includes(tool.clearsModalState))
    return `Error: The tool "${tool.schema.name}" can only be used when there is related modal state present.`;
  if (!tool.clearsModalState && openModalTypes.length)
    return `Error: Tool "${tool.schema.name}" does not handle the modal state.`;
  return undefined;
}

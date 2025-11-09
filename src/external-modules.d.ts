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
// Minimal type declarations for optional runtime dependencies.
declare module 'dotenv' {
  export interface DotenvConfigOptions {
    path?: string;
    encoding?: string;
    debug?: boolean;
    override?: boolean;
  }

  export interface DotenvConfigOutput {
    parsed?: Record<string, string>;
    error?: Error;
  }

  export function config(options?: DotenvConfigOptions): DotenvConfigOutput;

  const dotenv: {
    config: typeof config;
  };

  export default dotenv;
}

declare module 'openai' {
  namespace OpenAI {
    namespace Chat {
      namespace Completions {
        type Role = 'user' | 'assistant' | 'tool';

        interface ChatCompletionMessageToolCall {
          id: string;
          type: 'function';
          function: {
            name: string;
            arguments: string;
          };
        }

        interface ChatCompletionMessageParam {
          role: Role;
          content?: string | null;
          tool_calls?: ChatCompletionMessageToolCall[];
          tool_call_id?: string;
        }

        interface ChatCompletionAssistantMessageParam extends ChatCompletionMessageParam {
          role: 'assistant';
        }

        interface ChatCompletionTool {
          type: 'function';
          function: {
            name: string;
            description?: string;
            parameters?: any;
          };
        }
      }
    }
  }

  interface ChatCompletionsApi {
    create(request: {
      model: string;
      messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
      tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
      tool_choice?: 'auto' | 'none';
    }): Promise<{
      choices: Array<{
        message: {
          content?: string | null;
          tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
        };
      }>;
    }>;
  }

  class OpenAI {
    constructor(config?: Record<string, unknown>);
    chat: {
      completions: ChatCompletionsApi;
    };
  }

  export { OpenAI };
  export default OpenAI;
}

declare module '@anthropic-ai/sdk' {
  namespace Anthropic {
    namespace Messages {
      type Role = 'user' | 'assistant';

      interface BaseBlock {
        type: string;
      }

      interface TextBlock extends BaseBlock {
        type: 'text';
        text: string;
        citations?: any[];
      }

      interface ToolUseBlock extends BaseBlock {
        type: 'tool_use';
        id: string;
        name: string;
        input: unknown;
      }

      interface ToolResultBlock extends BaseBlock {
        type: 'tool_result';
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }

      type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
      type ToolResultBlockParam = ToolResultBlock;

      interface MessageParam {
        role: Role;
        content: string | ContentBlock[];
      }

      interface Tool {
        name: string;
        description?: string;
        input_schema: any;
      }
    }
  }

  class Anthropic {
    constructor(config?: Record<string, unknown>);
    messages: {
      create(request: {
        model: string;
        max_tokens: number;
        messages: Anthropic.Messages.MessageParam[];
        tools?: Anthropic.Messages.Tool[];
      }): Promise<{
        content: Anthropic.Messages.ContentBlock[];
      }>;
    };
  }

  export { Anthropic };
  export default Anthropic;
}

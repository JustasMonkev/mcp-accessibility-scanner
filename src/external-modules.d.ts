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

declare module 'playwright-core/lib/coreBundle' {
  interface ExecutableInfo {
    executablePath(): string | undefined;
  }
  interface Registry {
    findExecutable(channel: string): ExecutableInfo | undefined;
  }
  interface CdpProgress {
    readonly signal: AbortSignal;
    log(message: string): void;
    race<T>(pending: Promise<T> | Promise<T>[]): Promise<T>;
  }
  interface CdpTransport {
    onmessage?: (message: object) => void;
    onclose?: (reason?: string) => void;
    send(message: object): void;
    close(): void;
    closeAndWait(): Promise<void>;
  }
  interface CoreBundle {
    getUserAgent(): string;
    readonly utils: {
      isChromiumChannelName(channel: string): boolean;
      defaultUserDataDirForChannel(channel: string): string | undefined;
      httpRequest(options: { url: string; headers: Record<string, string> }, onResponse: (response: import('node:http').IncomingMessage) => void, onError: (error: Error) => void): { cancel(error?: Error): void };
    };
    readonly iso: {
      asLocator(lang: string, selector: string): string;
      urlMatches(baseURL: string | undefined, urlString: string, match: string): boolean;
      getMimeTypeForPath(path: string): string | null;
    };
    readonly registry: {
      readonly registryDirectory: string;
      readonly registry: Registry;
    };
    readonly server: {
      readonly nullProgress: CdpProgress;
      readonly WebSocketTransport: {
        connect(progress: CdpProgress, endpoint: string, options: { headers: Record<string, string>; followRedirects: boolean }): Promise<CdpTransport>;
      };
      startTraceViewerServer(options: { host?: string; allowedFileRoots: () => string[] }): Promise<{
        urlPrefix(type: 'precise' | 'human-readable'): string;
        stop(): Promise<void>;
      }>;
    };
  }
  const coreBundle: CoreBundle;
  export default coreBundle;
}

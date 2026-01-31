# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP Accessibility Scanner is a Model Context Protocol (MCP) server that provides automated web accessibility scanning and browser automation. It combines Playwright (browser automation) with Axe-core (WCAG compliance checking) to enable LLMs to perform accessibility audits and interact with web pages.

## Build & Development Commands

```bash
npm run build          # Compile TypeScript to lib/
npm run lint           # Run ESLint and type check
npm run test           # Run all tests once
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Run tests with coverage report
npm run watch          # TypeScript watch mode for development
npm run clean          # Remove compiled output
```

## Architecture

### Core Components

**Context (`src/context.ts`)** - Central orchestrator that manages Playwright browser instance, tab lifecycle, and tool execution. All tools receive Context to access browser state.

**Tab (`src/tab.ts`)** - Wraps a Playwright Page. Captures accessibility snapshots using Axe-core, tracks console messages, downloads, and modal states.

**Response (`src/response.ts`)** - Builder class that accumulates tool results, code snippets, images, and page snapshots. Formats output for MCP protocol.

**BrowserServerBackend (`src/browserServerBackend.ts`)** - Implements MCP ServerBackend interface. Coordinates tool execution and manages session logging.

**Config (`src/config.ts`)** - Zod-validated configuration schema covering browser launch options, timeouts, network rules, and tool capability filtering.

### Tool System

Tools are defined in `src/tools/` using the `defineTool()` or `defineTabTool()` pattern from `src/tools/tool.ts`:

```typescript
interface Tool {
  schema: { name, title, description, inputSchema: ZodSchema, type };
  capability: 'core' | 'tabs' | 'pdf' | 'vision' | ...;
  handle: (context, args, response) => Promise<void>;
}
```

**Tool Categories:**
- Navigation: `navigate.ts`, `tabs.ts`, `common.ts`
- Interaction: `mouse.ts`, `keyboard.ts`, `form.ts`
- Information: `snapshot.ts` (accessibility), `console.ts`, `network.ts`
- Visual: `screenshot.ts`, `pdf.ts`, `evaluate.ts`
- Advanced: `files.ts`, `dialogs.ts`, `wait.ts`, `verify.ts`

### Accessibility Scanning (`src/tools/snapshot.ts`)

Uses `@axe-core/playwright` AxeBuilder for WCAG compliance checking. Supports:
- WCAG 2.0/2.1/2.2 at all levels (A/AA/AAA)
- Section 508
- Specific categories (color, ARIA, forms, keyboard, etc.)

### MCP Protocol (`src/mcp/`)

- `server.ts` - MCP server core implementation
- `http.ts` - HTTP/SSE transport
- `tool.ts` - Converts Zod schemas to MCP tool schemas

### Browser Context Factory Pattern

`BrowserContextFactory` supports multiple browser sources:
- Standard Playwright (auto-launched)
- CDP endpoints (connect to existing browser)
- Browser extension mode
- Custom context getters for library usage

## Code Standards

**TypeScript**: Strict mode enabled. All code must pass `tsc --noEmit`.

**ESLint Rules** (see `eslint.config.mjs`):
- No floating promises
- Import extensions required (`.js` suffix for compiled output)
- 2-space indentation, semicolons, single quotes
- No console statements (except stderr)

**Test Coverage**: 90% threshold for lines, functions, branches, statements.

## Testing

Tests use Vitest in `tests/` directory. Most tests mock Playwright components since integration tests require real browsers.

Run a single test file:
```bash
npx vitest run tests/response.test.ts
```

Run tests matching a pattern:
```bash
npx vitest run -t "response"
```
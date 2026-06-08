# Graph Report - .  (2026-06-08)

## Corpus Check
- Corpus is ~48,937 words - fits in a single context window. You may not need a graph.

## Summary
- 813 nodes · 1413 edges · 61 communities (51 shown, 10 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Tool Definitions|Tool Definitions]]
- [[_COMMUNITY_Async Promise Scopes|Async Promise Scopes]]
- [[_COMMUNITY_HTTP Transport|HTTP Transport]]
- [[_COMMUNITY_Proxy Backend|Proxy Backend]]
- [[_COMMUNITY_CDP Relay Server|CDP Relay Server]]
- [[_COMMUNITY_Action Type Model|Action Type Model]]
- [[_COMMUNITY_Browser Tab Actions|Browser Tab Actions]]
- [[_COMMUNITY_Site Audit Crawler|Site Audit Crawler]]
- [[_COMMUNITY_Browser Context State|Browser Context State]]
- [[_COMMUNITY_Response Rendering|Response Rendering]]
- [[_COMMUNITY_Dev Dependencies|Dev Dependencies]]
- [[_COMMUNITY_External AI Types|External AI Types]]
- [[_COMMUNITY_Browser Context Factory|Browser Context Factory]]
- [[_COMMUNITY_Program Server Startup|Program Server Startup]]
- [[_COMMUNITY_Keyboard Audit Tests|Keyboard Audit Tests]]
- [[_COMMUNITY_Axe Scan Core|Axe Scan Core]]
- [[_COMMUNITY_Accessibility Tool Surface|Accessibility Tool Surface]]
- [[_COMMUNITY_Response Builder|Response Builder]]
- [[_COMMUNITY_Context Factory Types|Context Factory Types]]
- [[_COMMUNITY_Configuration Loading|Configuration Loading]]
- [[_COMMUNITY_Package Metadata|Package Metadata]]
- [[_COMMUNITY_Package Scripts|Package Scripts]]
- [[_COMMUNITY_Runtime Dependencies|Runtime Dependencies]]
- [[_COMMUNITY_Backend Tool Interface|Backend Tool Interface]]
- [[_COMMUNITY_Context Resolution Tests|Context Resolution Tests]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Extension CDP Context|Extension CDP Context]]
- [[_COMMUNITY_Session Log Storage|Session Log Storage]]
- [[_COMMUNITY_Validation Contract|Validation Contract]]
- [[_COMMUNITY_Server Registry Metadata|Server Registry Metadata]]
- [[_COMMUNITY_MCP Report Outputs|MCP Report Outputs]]
- [[_COMMUNITY_Docker Delivery|Docker Delivery]]
- [[_COMMUNITY_Browser Automation Surface|Browser Automation Surface]]
- [[_COMMUNITY_Repository Identity|Repository Identity]]
- [[_COMMUNITY_ESLint Configuration|ESLint Configuration]]
- [[_COMMUNITY_Playwright Attribution|Playwright Attribution]]
- [[_COMMUNITY_E2E Smoke Tests|E2E Smoke Tests]]
- [[_COMMUNITY_File Path Utilities|File Path Utilities]]
- [[_COMMUNITY_Dependency Overrides|Dependency Overrides]]
- [[_COMMUNITY_Tabs Tool Tests|Tabs Tool Tests]]
- [[_COMMUNITY_Package Exports|Package Exports]]
- [[_COMMUNITY_Input Recorder|Input Recorder]]
- [[_COMMUNITY_Program CLI Tests|Program CLI Tests]]
- [[_COMMUNITY_Artifact Hygiene|Artifact Hygiene]]
- [[_COMMUNITY_Config Types|Config Types]]
- [[_COMMUNITY_Glama Metadata|Glama Metadata]]
- [[_COMMUNITY_Binary Aliases|Binary Aliases]]
- [[_COMMUNITY_Repository URL|Repository URL]]
- [[_COMMUNITY_TS Node Runtime|TS Node Runtime]]
- [[_COMMUNITY_Docker Smoke Script|Docker Smoke Script]]
- [[_COMMUNITY_All TS Config|All TS Config]]
- [[_COMMUNITY_Connection Types|Connection Types]]
- [[_COMMUNITY_License Notice|License Notice]]

## God Nodes (most connected - your core abstractions)
1. `Tab` - 48 edges
2. `Context` - 44 edges
3. `Response` - 39 edges
4. `FullConfig` - 24 edges
5. `CDPRelayServer` - 21 edges
6. `defineTabTool()` - 19 edges
7. `BrowserContextFactory` - 17 edges
8. `BrowserServerBackend` - 17 edges
9. `ProxyBackend` - 15 edges
10. `scripts` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Axe Playwright Accessibility Core` --semantically_similar_to--> `Accessibility Scanning`  [INFERRED] [semantically similar]
  AGENTS.md → README.md
- `Browser Automation Tools` --semantically_similar_to--> `Browser Automation`  [INFERRED] [semantically similar]
  SKILL.md → README.md
- `Validation Commands` --semantically_similar_to--> `CI Workflow`  [INFERRED] [semantically similar]
  AGENTS.md → .github/workflows/ci.yml
- `Optional Capabilities` --semantically_similar_to--> `Vision Mode Tools`  [AMBIGUOUS] [semantically similar]
  SKILL.md → README.md
- `Development Setup` --semantically_similar_to--> `npm Dependency Install`  [INFERRED] [semantically similar]
  README.md → .github/workflows/ci.yml

## Import Cycles
- 3-file cycle: `src/context.ts -> src/sessionLog.ts -> src/response.ts -> src/context.ts`
- 3-file cycle: `src/context.ts -> src/tools/tool.ts -> src/response.ts -> src/context.ts`
- 3-file cycle: `src/response.ts -> src/tab.ts -> src/tools/tool.ts -> src/response.ts`
- 4-file cycle: `src/context.ts -> src/tab.ts -> src/tools/tool.ts -> src/response.ts -> src/context.ts`
- 5-file cycle: `src/context.ts -> src/sessionLog.ts -> src/tab.ts -> src/tools/tool.ts -> src/response.ts -> src/context.ts`

## Hyperedges (group relationships)
- **Accessibility Scanning Surface** — agents_accessibility_core, readme_scan_page_tool, readme_audit_site_tool, readme_scan_page_matrix_tool, readme_audit_keyboard_tool, skill_scan_page_tool, skill_audit_site_tool, skill_scan_page_matrix_tool, skill_audit_keyboard_tool [INFERRED 0.95]
- **Delivery Modes** — readme_mcp_server_default_mode, readme_interactive_repl_mode, readme_docker_installation, docker_compose_mcp_accessibility_scanner_service, skill_interactive_repl_required [INFERRED 0.85]
- **Validation Contract** — workflows_ci_ci_workflow, agents_validation_commands, workflows_ci_typecheck, workflows_ci_lint_check, workflows_ci_test_suite, workflows_ci_build_step, readme_development_setup [INFERRED 0.95]

## Communities (61 total, 10 thin omitted)

### Community 0 - "Tool Definitions"
Cohesion: 0.05
Nodes (49): allTools, dedupeAxeNodes(), close, resize, console, handleDialog, evaluate, evaluateSchema (+41 more)

### Community 1 - "Async Promise Scopes"
Cohesion: 0.07
Nodes (16): captureRawStack(), cloneError(), LongStandingScope, ManualPromise, errorsDebug, MDBBackend, mdbDebug, OnceTimeServerBackendWrapper (+8 more)

### Community 2 - "HTTP Transport"
Cohesion: 0.08
Nodes (27): allowedHostnamesForServer(), decorateServer(), formatAuthority(), handleStreamable(), httpAddressToString(), installHttpTransport(), isWildcardAddress(), normalizeHostname() (+19 more)

### Community 3 - "Proxy Backend"
Cohesion: 0.10
Nodes (14): errorsDebug, MCPProvider, ProxyBackend, CallToolRequestContext, ClientVersion, ServerBackend, ServerBackendContext, canonicalize() (+6 more)

### Community 4 - "CDP Relay Server"
Cohesion: 0.14
Nodes (5): CDPRelayServer, debugLogger, ExtensionConnection, ExtensionCommand, ExtensionEvents

### Community 5 - "Action Type Model"
Cohesion: 0.06
Nodes (30): ActionBase, ActionInContext, ActionName, ActionWithSelector, AssertAction, AssertCheckedAction, AssertSnapshotAction, AssertTextAction (+22 more)

### Community 6 - "Browser Tab Actions"
Cohesion: 0.10
Nodes (4): Action, Tab, ModalState, callOnPageNoTrace()

### Community 7 - "Site Audit Crawler"
Cohesion: 0.08
Nodes (13): auditSite, auditSiteSchema, CrawlItem, CrawlStrategy, crawlStrategySchema, defaultExcludePathPatterns, defaultIgnoreQueryParams, impactPriority (+5 more)

### Community 8 - "Browser Context State"
Cohesion: 0.12
Nodes (3): Context, ContextRegistry, testDebug

### Community 9 - "Response Rendering"
Cohesion: 0.12
Nodes (11): errorsDebug, ProgressUpdate, renderTabsMarkdown(), renderTabSnapshot(), trim(), ConsoleMessage, _pageTabMap, renderModalStates() (+3 more)

### Community 10 - "Dev Dependencies"
Cohesion: 0.09
Nodes (22): devDependencies, eslint, @eslint/eslintrc, @eslint/js, eslint-plugin-import, eslint-plugin-notice, happy-dom, @playwright/test (+14 more)

### Community 11 - "External AI Types"
Cohesion: 0.11
Nodes (21): Anthropic, BaseBlock, ChatCompletionAssistantMessageParam, ChatCompletionMessageParam, ChatCompletionMessageToolCall, ChatCompletionsApi, ChatCompletionTool, ContentBlock (+13 more)

### Community 12 - "Browser Context Factory"
Cohesion: 0.15
Nodes (9): cdpConnectOptions(), CdpLaunchContextFactory, findFreePort(), injectCdpPort(), PersistentContextFactory, startTraceServer(), createGuid(), createHash() (+1 more)

### Community 13 - "Program Server Startup"
Cohesion: 0.20
Nodes (11): ContextOptions, ProgramContext, setupExitWatchdog(), LogEntry, filteredTools(), errorsDebug, logUnhandledError(), __filename (+3 more)

### Community 14 - "Keyboard Audit Tests"
Cohesion: 0.14
Nodes (14): auditKeyboard, auditKeyboardSchema, buildFingerprint(), didUrlHashChange(), FocusPoint, FocusStop, isLikelySkipLink(), KeyboardAuditCallbacks (+6 more)

### Community 15 - "Axe Scan Core"
Cohesion: 0.13
Nodes (15): AxeNode, AxeScanResult, AxeTag, axeTagValues, AxeViolation, runAxeScan(), summarizeAxeViolations(), trimAxeResults() (+7 more)

### Community 16 - "Accessibility Tool Surface"
Cohesion: 0.13
Nodes (19): Axe Core Integration, Accessibility Scanning, audit_keyboard Tool, audit_site Tool, Browser Navigation Tools, Interactive REPL Mode, scan_page_matrix Tool, scan_page Tool (+11 more)

### Community 18 - "Context Factory Types"
Cohesion: 0.17
Nodes (5): BaseContextFactory, CdpContextFactory, IsolatedContextFactory, RemoteContextFactory, FullConfig

### Community 19 - "Configuration Loading"
Cohesion: 0.21
Nodes (15): BrowserUserConfig, CLIOptions, commaSeparatedList(), configFromCLIOptions(), configFromEnv(), defaultConfig, envToBoolean(), envToNumber() (+7 more)

### Community 20 - "Package Metadata"
Cohesion: 0.14
Nodes (13): author, description, engines, node, files, keywords, license, mcpName (+5 more)

### Community 21 - "Package Scripts"
Cohesion: 0.14
Nodes (14): scripts, build, clean, docker:build:multiarch, lint, npm-publish, run-server, test (+6 more)

### Community 22 - "Runtime Dependencies"
Cohesion: 0.15
Nodes (13): dependencies, @axe-core/playwright, @cfworker/json-schema, commander, debug, dotenv, mime, @modelcontextprotocol/sdk (+5 more)

### Community 23 - "Backend Tool Interface"
Cohesion: 0.21
Nodes (4): BrowserContextFactory, BrowserServerBackend, Tool, VSCodeBrowserContextFactory

### Community 24 - "Context Resolution Tests"
Cohesion: 0.19
Nodes (6): contextFactory(), resolveConfig(), createConnection(), SimpleBrowserContextFactory, resolveProgramContext(), { connectOverCDP, spawnMock }

### Community 25 - "TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, module, moduleResolution, outDir, resolveJsonModule, rootDir, sourceMap (+4 more)

### Community 26 - "Extension CDP Context"
Cohesion: 0.26
Nodes (6): CDPCommand, CDPResponse, ExtensionResponse, debugLogger, ExtensionContextFactory, ClientInfo

### Community 27 - "Session Log Storage"
Cohesion: 0.22
Nodes (3): IFileStorage, NodeFileStorage, SessionLog

### Community 28 - "Validation Contract"
Cohesion: 0.20
Nodes (10): Targeted Validation Policy, Validation Commands, Development Setup, Build Step, CI Workflow, Lint Check, Node 24 Matrix, npm Dependency Install (+2 more)

### Community 29 - "Server Registry Metadata"
Cohesion: 0.20
Nodes (9): description, name, packages, repository, source, url, $schema, status (+1 more)

### Community 30 - "MCP Report Outputs"
Cohesion: 0.22
Nodes (9): Output Report Compatibility, README Update Policy, JSON Reports, List Tools Mode, MCP Accessibility Scanner, MCP Server Default Mode, Model Context Protocol Server, Visual Annotations (+1 more)

### Community 31 - "Docker Delivery"
Cohesion: 0.25
Nodes (9): Chromium No Sandbox, HTTP Host Port, mcp-accessibility-scanner Service, Output Volume, Docker Installation, Installation Methods, VS Code Installation, Global CLI Options (+1 more)

### Community 32 - "Browser Automation Surface"
Cohesion: 0.22
Nodes (9): Browser Automation, Browser Tabs Tool Name Ambiguity, Console Network Tools, Page Interaction Tools, Screenshot Visual Tools, Tab Management Tools, Vision Mode Tools, Optional Capabilities (+1 more)

### Community 33 - "Repository Identity"
Cohesion: 0.29
Nodes (7): Axe Playwright Accessibility Core, MCP Tool Areas, Node TypeScript MCP Accessibility Server, Runtime Entrypoints, AGENTS.md Reference, Generic MCP Utils, No Dependencies

### Community 34 - "ESLint Configuration"
Cohesion: 0.33
Nodes (5): baseRules, __dirname, __filename, languageOptions, plugins

### Community 35 - "Playwright Attribution"
Cohesion: 0.33
Nodes (6): CommonJS Adaptation, Existing Playwright Instances, Microsoft Playwright MCP, Playwright MCP Attribution, Network Policy Configuration, Playwright Configuration

### Community 37 - "File Path Utilities"
Cohesion: 0.33
Nodes (4): safeIsoTimestampForFileName(), safeIsoTimestampForFileName(), safeIsoTimestampForFileName(), sanitizeForFilePath()

### Community 38 - "Dependency Overrides"
Cohesion: 0.40
Nodes (5): overrides, diff, minimatch, qs, rollup

### Community 39 - "Tabs Tool Tests"
Cohesion: 0.40
Nodes (3): browserTabs, defaultTimeout, navigationTimeout

### Community 40 - "Package Exports"
Cohesion: 0.50
Nodes (4): default, exports, ./package.json, types

### Community 45 - "Artifact Hygiene"
Cohesion: 0.67
Nodes (3): Generated Artifact Hygiene, Generated Artifacts Policy, Source Editing Policy

### Community 48 - "Binary Aliases"
Cohesion: 0.67
Nodes (3): bin, mcp-accessibility-scanner, mcp-server-playwright

### Community 49 - "Repository URL"
Cohesion: 0.67
Nodes (3): repository, type, url

### Community 50 - "TS Node Runtime"
Cohesion: 0.67
Nodes (3): ts-node, esm, transpileOnly

## Ambiguous Edges - Review These
- `Tab Management Tools` → `Browser Tabs Tool Name Ambiguity`  [AMBIGUOUS]
  README.md · relation: conceptually_related_to
- `Vision Mode Tools` → `Optional Capabilities`  [AMBIGUOUS]
  SKILL.md · relation: semantically_similar_to

## Knowledge Gaps
- **266 isolated node(s):** `ToolCapability`, `Config`, `__filename`, `__dirname`, `plugins` (+261 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Tab Management Tools` and `Browser Tabs Tool Name Ambiguity`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Vision Mode Tools` and `Optional Capabilities`?**
  _Edge tagged AMBIGUOUS (relation: semantically_similar_to) - confidence is low._
- **Why does `Tab` connect `Browser Tab Actions` to `Tool Definitions`, `Tabs Tool Tests`, `Browser Context State`, `Response Rendering`, `Response Tests`, `Program Server Startup`, `Session Log Storage`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Why does `Context` connect `Browser Context State` to `Tool Definitions`, `Proxy Backend`, `Browser Tab Actions`, `Tabs Tool Tests`, `Response Rendering`, `Response Tests`, `Browser Context Factory`, `Program Server Startup`, `Response Builder`, `Context Factory Types`, `Backend Tool Interface`, `Extension CDP Context`, `Session Log Storage`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Why does `Action` connect `Browser Tab Actions` to `Action Type Model`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **What connects `ToolCapability`, `Config`, `__filename` to the rest of the system?**
  _274 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Tool Definitions` be split into smaller, more focused modules?**
  _Cohesion score 0.0525879917184265 - nodes in this community are weakly interconnected._
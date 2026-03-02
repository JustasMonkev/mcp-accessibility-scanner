# Accessibility Scanner CLI Skill

Use the local CLI when you want direct automation without attaching an MCP client.

## Commands

List tools:

```bash
npx mcp-accessibility-scanner list-tools
```

Navigate:

```bash
npx mcp-accessibility-scanner call browser_navigate --input '{"url":"https://example.com"}'
```

Run accessibility scan:

```bash
npx mcp-accessibility-scanner call scan_page --input '{"violationsTag":["wcag2aa","wcag21aa","wcag22aa"]}'
```

Save JSON output to a file:

```bash
npx mcp-accessibility-scanner call scan_page --input '{"violationsTag":["wcag2aa"]}' > ./scan-result.json
```

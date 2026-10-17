import assert from 'node:assert/strict';
import fs from 'node:fs';

export function verifyScreenReader(result, fixture, origin) {
  assert.notEqual(result.isError, true);
  const { summary, findings, report: resource, reportUri, page, kind } = result.structuredContent;
  const expectedSelectors = Object.fromEntries(Object.entries(fixture.expected.selectors)
    .map(([check, selectors]) => [check, (check === 'reading-order-mismatch' ? fixture.options.checkReadingOrder : fixture.options.checkNames) ? selectors : []]));
  const countByCheck = Object.fromEntries(Object.entries(expectedSelectors).map(([check, selectors]) => [check, selectors.length]));
  const totalFindings = Object.values(countByCheck).reduce((sum, count) => sum + count, 0);
  const cap = fixture.options.maxFindingsPerCheck;
  const truncatedChecks = Object.keys(countByCheck).filter(check => countByCheck[check] > cap);
  assert.equal(kind, 'audit_screen_reader');
  assert.equal(page.url, `${origin}${fixture.path}`);
  assert.deepEqual(summary, {
    elementsTotal: fixture.expected.elements,
    elementsAnalyzed: fixture.expected.elements,
    elementsUnresolved: 0,
    elementsWithoutMeasuredName: 0,
    elementsTruncated: 0,
    totalFindings,
    countByCheck,
    truncatedChecks,
  });
  for (const [check, selectors] of Object.entries(expectedSelectors)) {
    const actual = findings.filter(finding => finding.check === check);
    assert.deepEqual(actual.map(finding => finding.selector), selectors.slice(0, cap));
    assert.equal(new Set(actual.map(finding => finding.ref)).size, actual.length);
    for (const finding of actual) {
      assert.ok(finding.ref);
      assert.ok(finding.problem);
      assert.ok(finding.fix);
      assert.ok(finding.wcag);
    }
  }
  assert.equal(findings.length, Object.values(countByCheck).reduce((sum, count) => sum + Math.min(count, cap), 0));
  assert.equal(resource.mimeType, 'application/json');
  assert.equal(reportUri, resource.uri);
  assert.ok(result.content.some(entry => entry.type === 'resource_link' && entry.uri === reportUri));
  const report = JSON.parse(fs.readFileSync(new URL(reportUri), 'utf8'));
  assert.equal(report.version, 'v1');
  assert.equal(report.metadata.url, page.url);
  assert.deepEqual(report.metadata.options, fixture.options);
  assert.ok(Number.isFinite(Date.parse(report.metadata.generatedAt)));
  assert.deepEqual(report.elements, {
    total: fixture.expected.elements,
    analyzed: fixture.expected.elements,
    unresolved: 0,
    unmeasuredNames: 0,
    truncated: false,
  });
  assert.deepEqual(report.countByCheck, countByCheck);
  assert.equal(report.totalFindings, totalFindings);
  assert.deepEqual(report.truncatedChecks, truncatedChecks);
  assert.deepEqual(report.findings, findings);
}

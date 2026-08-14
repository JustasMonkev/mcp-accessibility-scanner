import { chromium, type Browser } from 'playwright';

/**
 * One answer to "can this machine run a real browser?", shared by every suite
 * that needs one.
 *
 * Three different idioms existed before this: `fs.existsSync(executablePath())`
 * (which passes for an installed-but-unlaunchable browser and then hard-fails
 * the suite), a launch probe whose `catch {}` discarded the reason, and — for
 * the 28 real-DOM tests in tools-auditScreenReader.test.ts — no gate at all.
 * So on a machine without a working Chromium, some suites skipped silently,
 * others exploded, and the whole run could still report green with the only
 * end-to-end test never executed.
 *
 * Set MCP_REQUIRE_BROWSER=1 (CI does) to turn "no browser" into a loud
 * failure instead of a silent skip.
 */
let probe: { launchable: boolean; reason?: string } | undefined;

async function probeChromium(): Promise<{ launchable: boolean; reason?: string }> {
  if (probe)
    return probe;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: false });
    probe = { launchable: true };
  } catch (error) {
    // Keep the reason: "not installed" and "installed but missing a shared
    // library" need different fixes, and discarding the error made them
    // indistinguishable.
    probe = { launchable: false, reason: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  } finally {
    await browser?.close().catch(() => undefined);
  }
  return probe;
}

export async function canLaunchChromium(): Promise<boolean> {
  const result = await probeChromium();
  if (result.launchable)
    return true;

  const detail = `Chromium could not be launched: ${result.reason ?? 'unknown reason'}`;
  if (process.env.MCP_REQUIRE_BROWSER === '1')
    throw new Error(`${detail}. MCP_REQUIRE_BROWSER=1 forbids skipping browser-backed tests.`);
  // Announced rather than silent, so a green run that skipped the real-browser
  // coverage says so.
  process.emitWarning(`${detail}. Skipping browser-backed tests.`);
  return false;
}

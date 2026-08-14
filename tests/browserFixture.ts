import { chromium, type Browser } from 'playwright';

type Probe = { launchable: true } | { launchable: false; reason: string };

let probe: Probe | undefined;

async function probeChromium(): Promise<Probe> {
  if (probe)
    return probe;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: false });
    probe = { launchable: true };
  } catch (error) {
    // "not installed" and "installed but missing a shared library" need
    // different fixes, so keep the reason rather than swallowing it.
    probe = { launchable: false, reason: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  } finally {
    await browser?.close().catch(() => undefined);
  }
  return probe;
}

/**
 * One answer to "can this machine run a real browser?", shared by every suite
 * that needs one. Replaces three idioms that disagreed: an existsSync check
 * that hard-failed on an unlaunchable browser, a probe that swallowed the
 * reason, and no gate at all.
 *
 * MCP_REQUIRE_BROWSER=1 turns "no browser" into a failure rather than a silent
 * skip, so a green run cannot hide missing browser coverage.
 */
export async function canLaunchChromium(): Promise<boolean> {
  const result = await probeChromium();
  if (result.launchable)
    return true;

  const detail = `Chromium could not be launched: ${result.reason}`;
  if (process.env.MCP_REQUIRE_BROWSER === '1')
    throw new Error(`${detail}. MCP_REQUIRE_BROWSER=1 forbids skipping browser-backed tests.`);
  process.emitWarning(`${detail}. Skipping browser-backed tests.`);
  return false;
}

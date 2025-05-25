import { scanViolations, executeClick, executeType } from './accessibilityChecker';
import { AxeBuilder } from '@axe-core/playwright';
import playwright from 'playwright';
import path from 'node:path';
import os from 'node:os';
import { vi, describe, test, expect, beforeEach } from 'vitest';

// Mock external dependencies globally
vi.mock('playwright');
vi.mock('@axe-core/playwright');
vi.mock('node:path');
vi.mock('node:os');

// Common mock objects that can be configured in beforeEach blocks
let mockPage: any;
let mockBrowser: any;
let mockContext: any;
let mockAxeBuilderInstance: any;

const MOCK_URL = 'http://example.com';
const MOCK_SELECTOR = '#test-selector';
const MOCK_TEXT = 'test input';
const MOCK_VIOLATIONS_TAG = ['wcag2aa'];
const MOCK_VIEWPORT = { width: 1280, height: 720 };
const MOCK_SHOULD_RUN_IN_HEADLESS = false;
const MOCK_HOME_DIR = '/mock/home';
const MOCK_DOWNLOADS_PATH = '/mock/home/Downloads'; // Consistent with path.join mock

beforeEach(() => {
    // General reset for mocks that might be used across different describe blocks
    // path.join and os.homedir are mocked globally and then specifically in relevant tests/describes
    vi.mocked(path.join).mockImplementation((...args: string[]) => args.join('/'));
    vi.mocked(os.homedir).mockReturnValue(MOCK_HOME_DIR);

    // Default Playwright mock setup, can be overridden in specific describe blocks if needed
    mockPage = {
        goto: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
        click: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
        type: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
        waitForLoadState: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
        addStyleTag: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
        screenshot: vi.fn<[], Promise<Buffer>>().mockResolvedValue(Buffer.from('dummy-screenshot')),
        evaluate: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    };
    mockContext = { newPage: vi.fn<[], Promise<any>>().mockResolvedValue(mockPage) };
    mockBrowser = {
        newContext: vi.fn<[], Promise<any>>().mockResolvedValue(mockContext),
        close: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    };
    vi.mocked(playwright.chromium.launch).mockResolvedValue(mockBrowser as any);

    // AxeBuilder mock setup
    mockAxeBuilderInstance = {
        withTags: vi.fn().mockReturnThis(),
        analyze: vi.fn<[], Promise<any>>().mockResolvedValue({ violations: [] }),
    };
    vi.mocked(AxeBuilder).mockImplementation(() => mockAxeBuilderInstance);
});

describe('scanViolations', () => {
    test('should perform an accessibility scan and return report and screenshot', async () => {
        await scanViolations(MOCK_URL, MOCK_VIOLATIONS_TAG, MOCK_VIEWPORT, MOCK_SHOULD_RUN_IN_HEADLESS);

        expect(playwright.chromium.launch).toHaveBeenCalledWith({
            headless: MOCK_SHOULD_RUN_IN_HEADLESS,
            args: expect.any(Array),
        });
        expect(mockBrowser.newContext).toHaveBeenCalledWith({
            viewport: MOCK_VIEWPORT,
            userAgent: expect.any(String),
        });
        expect(mockContext.newPage).toHaveBeenCalled();
        expect(mockPage.goto).toHaveBeenCalledWith(MOCK_URL);
        expect(mockPage.addStyleTag).toHaveBeenCalled();
        expect(AxeBuilder).toHaveBeenCalledWith({ page: mockPage });
        expect(mockAxeBuilderInstance.withTags).toHaveBeenCalledWith(MOCK_VIOLATIONS_TAG);
        expect(mockAxeBuilderInstance.analyze).toHaveBeenCalled();
        expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({
            path: expect.stringContaining(`${MOCK_DOWNLOADS_PATH}/a11y-report-`),
            fullPage: true,
        }));
        expect(mockBrowser.close).toHaveBeenCalled();
    });
});

describe('executeClick', () => {
    beforeEach(() => {
        // Specific mock for path.join for click screenshots
        vi.mocked(path.join).mockImplementation((base, dir, file) => {
            if (base === MOCK_HOME_DIR && dir === 'Downloads') {
                return `${MOCK_DOWNLOADS_PATH}/${file}`;
            }
            return [base, dir, file].filter(Boolean).join('/');
        });
    });

    test('should click an element and return screenshot and message', async () => {
        const result = await executeClick(MOCK_URL, MOCK_SELECTOR, MOCK_VIEWPORT, MOCK_SHOULD_RUN_IN_HEADLESS);

        expect(playwright.chromium.launch).toHaveBeenCalledWith({
            headless: MOCK_SHOULD_RUN_IN_HEADLESS,
            args: expect.any(Array),
        });
        expect(mockBrowser.newContext).toHaveBeenCalledWith({
            viewport: MOCK_VIEWPORT,
            userAgent: expect.any(String),
        });
        expect(mockPage.goto).toHaveBeenCalledWith(MOCK_URL);
        expect(mockPage.click).toHaveBeenCalledWith(MOCK_SELECTOR);
        expect(mockPage.waitForLoadState).toHaveBeenCalledWith('domcontentloaded');
        expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({
            path: expect.stringContaining(`${MOCK_DOWNLOADS_PATH}/click-screenshot-`),
            fullPage: true,
        }));
        expect(mockBrowser.close).toHaveBeenCalled();
        expect(result.message).toContain(`Clicked element '${MOCK_SELECTOR}'`);
        expect(result.message).toContain(`Screenshot saved to ${MOCK_DOWNLOADS_PATH}/click-screenshot-`);
        expect(result.base64Screenshot).toBe(Buffer.from('dummy-screenshot').toString('base64'));
    });
});

describe('executeType', () => {
    beforeEach(() => {
        // Specific mock for path.join for type screenshots
        vi.mocked(path.join).mockImplementation((base, dir, file) => {
            if (base === MOCK_HOME_DIR && dir === 'Downloads') {
                return `${MOCK_DOWNLOADS_PATH}/${file}`;
            }
            return [base, dir, file].filter(Boolean).join('/');
        });
    });

    test('should type into an element and return screenshot and message', async () => {
        const result = await executeType(MOCK_URL, MOCK_SELECTOR, MOCK_TEXT, MOCK_VIEWPORT, MOCK_SHOULD_RUN_IN_HEADLESS);

        expect(playwright.chromium.launch).toHaveBeenCalledWith({
            headless: MOCK_SHOULD_RUN_IN_HEADLESS,
            args: expect.any(Array),
        });
        expect(mockBrowser.newContext).toHaveBeenCalledWith({
            viewport: MOCK_VIEWPORT,
            userAgent: expect.any(String),
        });
        expect(mockPage.goto).toHaveBeenCalledWith(MOCK_URL);
        expect(mockPage.type).toHaveBeenCalledWith(MOCK_SELECTOR, MOCK_TEXT);
        expect(mockPage.waitForLoadState).toHaveBeenCalledWith('domcontentloaded');
        expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({
            path: expect.stringContaining(`${MOCK_DOWNLOADS_PATH}/type-screenshot-`),
            fullPage: true,
        }));
        expect(mockBrowser.close).toHaveBeenCalled();
        expect(result.message).toContain(`Typed text into element '${MOCK_SELECTOR}'`);
        expect(result.message).toContain(`Screenshot saved to ${MOCK_DOWNLOADS_PATH}/type-screenshot-`);
        expect(result.base64Screenshot).toBe(Buffer.from('dummy-screenshot').toString('base64'));
    });
});

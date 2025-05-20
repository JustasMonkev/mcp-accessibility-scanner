import { scanViolations } from './accessibilityChecker';
import { AxeBuilder } from '@axe-core/playwright';
import playwright from 'playwright';
import path from 'node:path';
import os from 'node:os';
import { jest } from '@jest/globals'; // For describe, test, expect, jest.fn()

// Mock external dependencies
jest.mock('playwright');
jest.mock('@axe-core/playwright');
jest.mock('node:path');
jest.mock('node:os');

describe('scanViolations with actions', () => {
    let mockPage: any;
    let mockBrowser: any;
    let mockContext: any;
    let mockAxeBuilderInstance: any;

    beforeEach(() => {
        // Reset mocks before each test
        mockPage = {
            goto: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
            click: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
            type: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
            waitForLoadState: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
            addStyleTag: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
            screenshot: jest.fn<() => Promise<Buffer>>().mockResolvedValue(Buffer.from('dummy-screenshot')),
            evaluate: jest.fn<() => Promise<void>>().mockResolvedValue(undefined), // for highlighting
        };
        mockContext = { newPage: jest.fn<() => Promise<any>>().mockResolvedValue(mockPage) };
        mockBrowser = {
            newContext: jest.fn<() => Promise<any>>().mockResolvedValue(mockContext),
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        // Explicitly mock the implementation for launch to ensure type compatibility
        (playwright.chromium.launch as jest.Mock).mockImplementation(() => Promise.resolve(mockBrowser as any));

        mockAxeBuilderInstance = {
            withTags: jest.fn().mockReturnThis(),
            analyze: jest.fn<() => Promise<any>>().mockResolvedValue({ violations: [] }),
        };
        (AxeBuilder as jest.Mock).mockImplementation(() => mockAxeBuilderInstance);

        // Mock path and os
        (path.join as jest.Mock).mockImplementation((...args) => args.join('/'));
        (os.homedir as jest.Mock).mockReturnValue('/fake/home');
    });

    test('should execute a click action', async () => {
        const actions = [{ type: 'click' as const, selector: '#testButton' }];
        await scanViolations('http://example.com', ['wcag2aa'], undefined, true, actions);
        
        expect(mockPage.click).toHaveBeenCalledWith('#testButton');
        expect(mockPage.waitForLoadState).toHaveBeenCalledWith('domcontentloaded');
        expect(AxeBuilder).toHaveBeenCalled(); // Ensure AxeBuilder is initialized
        expect(mockAxeBuilderInstance.analyze).toHaveBeenCalled(); // Ensure scan happens
    });

    test('should execute a type action', async () => {
        const actions = [{ type: 'type' as const, selector: '#testInput', text: 'hello world' }];
        await scanViolations('http://example.com', ['wcag2aa'], undefined, true, actions);
        
        expect(mockPage.type).toHaveBeenCalledWith('#testInput', 'hello world');
        expect(mockPage.waitForLoadState).toHaveBeenCalledWith('domcontentloaded');
        expect(AxeBuilder).toHaveBeenCalled();
        expect(mockAxeBuilderInstance.analyze).toHaveBeenCalled();
    });

    test('should execute multiple actions in order', async () => {
        const actions = [
            { type: 'click' as const, selector: '#button1' },
            { type: 'type' as const, selector: '#input1', text: 'typed text' },
            { type: 'click' as const, selector: '#button2' }
        ];
        await scanViolations('http://example.com', ['wcag2aa'], undefined, true, actions);
        
        const clickCalls = mockPage.click.mock.calls;
        const typeCalls = mockPage.type.mock.calls;
        const waitForLoadStateCalls = mockPage.waitForLoadState.mock.calls;

        expect(clickCalls.length).toBe(2);
        expect(typeCalls.length).toBe(1);
        expect(waitForLoadStateCalls.length).toBe(3); // One after each action

        // Check order of operations
        // For simplicity, we're checking calls were made. For strict order,
        // we'd need to capture call order across different mocks.
        // jest.fn().mock.invocationCallOrder gives this.
        
        expect(mockPage.click).toHaveBeenNthCalledWith(1, '#button1');
        expect(mockPage.waitForLoadState).toHaveBeenNthCalledWith(1, 'domcontentloaded');
        
        expect(mockPage.type).toHaveBeenCalledWith('#input1', 'typed text');
        // This check ensures type was called after the first click's waitForLoadState
        // and before the second click's waitForLoadState.
        expect(mockPage.type.mock.invocationCallOrder[0]).toBeGreaterThan(mockPage.click.mock.invocationCallOrder[0]);
        expect(mockPage.type.mock.invocationCallOrder[0]).toBeLessThan(mockPage.click.mock.invocationCallOrder[1]);


        expect(mockPage.waitForLoadState).toHaveBeenNthCalledWith(2, 'domcontentloaded');
        
        expect(mockPage.click).toHaveBeenNthCalledWith(2, '#button2');
        expect(mockPage.waitForLoadState).toHaveBeenNthCalledWith(3, 'domcontentloaded');
        
        expect(AxeBuilder).toHaveBeenCalled();
        expect(mockAxeBuilderInstance.analyze).toHaveBeenCalled();
        // Check that analyze was called after all actions
        expect(mockAxeBuilderInstance.analyze.mock.invocationCallOrder[0]).toBeGreaterThan(mockPage.waitForLoadState.mock.invocationCallOrder[2]);

    });

    test('should run scan directly if no actions are provided', async () => {
        await scanViolations('http://example.com', ['wcag2aa'], undefined, true, []);
        
        expect(mockPage.click).not.toHaveBeenCalled();
        expect(mockPage.type).not.toHaveBeenCalled();
        // waitForLoadState might be called by playwright's goto, but not after actions
        // For this test, we are interested that it's not called due to actions.
        // A more robust way would be to count calls if there's a baseline call from goto.
        // However, our actions loop adds one call per action. So 0 action, 0 calls from the loop.

        expect(AxeBuilder).toHaveBeenCalled();
        expect(mockAxeBuilderInstance.analyze).toHaveBeenCalled();
    });

    test('should run scan directly if actions parameter is undefined', async () => {
        await scanViolations('http://example.com', ['wcag2aa'], undefined, true, undefined);
        
        expect(mockPage.click).not.toHaveBeenCalled();
        expect(mockPage.type).not.toHaveBeenCalled();
        
        expect(AxeBuilder).toHaveBeenCalled();
        expect(mockAxeBuilderInstance.analyze).toHaveBeenCalled();
    });
    
    test('AxeBuilder should be initialized after actions', async () => {
        const actions = [{ type: 'click' as const, selector: '#testButton' }];
        await scanViolations('http://example.com', ['wcag2aa'], undefined, true, actions);

        expect(AxeBuilder).toHaveBeenCalled();
        // Ensure AxeBuilder constructor is called after the last action's waitForLoadState
        const axeBuilderConstructorCallOrder = (AxeBuilder as jest.Mock).mock.invocationCallOrder[0];
        const lastWaitForLoadStateCallOrder = mockPage.waitForLoadState.mock.invocationCallOrder[mockPage.waitForLoadState.mock.invocationCallOrder.length - 1];
        
        expect(axeBuilderConstructorCallOrder).toBeGreaterThan(lastWaitForLoadStateCallOrder);
        expect(mockAxeBuilderInstance.analyze).toHaveBeenCalled();
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import keyboardTools from '../src/tools/keyboard.js';
import formTools from '../src/tools/form.js';
import waitTools from '../src/tools/wait.js';
import fileTools from '../src/tools/files.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';

// None of these tools had a behavioural test: nothing checked that the right
// Playwright call was made with the right arguments, so a swapped fill/press
// or a dropped submit was invisible.

type ToolUnderTest = { handle: (context: Context, params: any, response: Response) => Promise<void> };
const find = (tools: any[], name: string): ToolUnderTest =>
  tools.find(tool => tool.schema.name === name)! as ToolUnderTest;

const pressKey = find(keyboardTools, 'browser_press_key');
const type = find(keyboardTools, 'browser_type');
const fillForm = find(formTools, 'browser_fill_form');
const waitFor = find(waitTools, 'browser_wait_for');
const fileUpload = find(fileTools, 'browser_file_upload');

function createLocator() {
  return {
    fill: vi.fn().mockResolvedValue(undefined),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    setChecked: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    first: vi.fn(),
  };
}

describe('input tools', () => {
  let mockTab: any;
  let mockContext: Context;
  let response: Response;
  let locator: ReturnType<typeof createLocator>;

  beforeEach(() => {
    locator = createLocator();
    locator.first.mockReturnValue(locator);
    mockTab = {
      page: {
        url: () => 'https://example.com',
        keyboard: { press: vi.fn().mockResolvedValue(undefined) },
        getByText: vi.fn().mockReturnValue(locator),
      },
      modalStates: vi.fn().mockReturnValue([]),
      modalStatesMarkdown: vi.fn().mockReturnValue([]),
      clearModalState: vi.fn(),
      refLocator: vi.fn().mockResolvedValue(locator),
      waitForCompletion: vi.fn().mockImplementation(async (cb: any) => await cb()),
    };
    mockContext = {
      currentTabOrDie: () => mockTab,
      currentTab: () => mockTab,
      tabs: () => [mockTab],
      config: {},
    } as any;
    response = new Response(mockContext, 'input', {});
  });

  describe('browser_press_key', () => {
    it('presses the requested key and emits the matching snippet', async () => {
      await pressKey.handle(mockContext, { key: 'ArrowLeft' }, response);

      expect(mockTab.page.keyboard.press).toHaveBeenCalledWith('ArrowLeft');
      expect(response.code()).toBe(`await page.keyboard.press('ArrowLeft');`);
    });

    it('runs the press through waitForCompletion so page work is awaited', async () => {
      await pressKey.handle(mockContext, { key: 'Enter' }, response);
      expect(mockTab.waitForCompletion).toHaveBeenCalledTimes(1);
    });

    it('quotes a key that would otherwise break the generated snippet', async () => {
      await pressKey.handle(mockContext, { key: `'` }, response);
      expect(() => new Function(response.code().replace('await ', ''))).not.toThrow();
    });
  });

  describe('browser_type', () => {
    it('fills the whole value at once by default', async () => {
      await type.handle(mockContext, { element: 'Name', ref: 'e1', text: 'Ada' }, response);

      expect(locator.fill).toHaveBeenCalledWith('Ada');
      expect(locator.pressSequentially).not.toHaveBeenCalled();
      expect(locator.press).not.toHaveBeenCalled();
    });

    it('types character by character when slowly is set', async () => {
      await type.handle(mockContext, { element: 'Name', ref: 'e1', text: 'Ada', slowly: true }, response);

      expect(locator.pressSequentially).toHaveBeenCalledWith('Ada');
      expect(locator.fill).not.toHaveBeenCalled();
    });

    it('presses Enter after typing when submit is set', async () => {
      await type.handle(mockContext, { element: 'Name', ref: 'e1', text: 'Ada', submit: true }, response);

      expect(locator.fill).toHaveBeenCalledWith('Ada');
      expect(locator.press).toHaveBeenCalledWith('Enter');
    });

    it('does not submit when submit is absent', async () => {
      await type.handle(mockContext, { element: 'Name', ref: 'e1', text: 'Ada' }, response);
      expect(locator.press).not.toHaveBeenCalled();
    });

    it('types an empty string rather than skipping the field', async () => {
      await type.handle(mockContext, { element: 'Name', ref: 'e1', text: '' }, response);
      expect(locator.fill).toHaveBeenCalledWith('');
    });
  });

  describe('browser_fill_form', () => {
    it('uses the right Playwright call for each field type', async () => {
      await fillForm.handle(mockContext, {
        fields: [
          { name: 'Name', type: 'textbox', ref: 'e1', value: 'Ada' },
          { name: 'Volume', type: 'slider', ref: 'e2', value: '7' },
          { name: 'Subscribe', type: 'checkbox', ref: 'e3', value: 'true' },
          { name: 'Plan', type: 'radio', ref: 'e4', value: 'false' },
          { name: 'Country', type: 'combobox', ref: 'e5', value: 'Lithuania' },
        ],
      }, response);

      expect(locator.fill).toHaveBeenCalledWith('Ada');
      expect(locator.fill).toHaveBeenCalledWith('7');
      expect(locator.setChecked).toHaveBeenNthCalledWith(1, true);
      // Only the literal "true" checks the box.
      expect(locator.setChecked).toHaveBeenNthCalledWith(2, false);
      expect(locator.selectOption).toHaveBeenCalledWith({ label: 'Lithuania' });
    });

    it('resolves each field by its own ref', async () => {
      await fillForm.handle(mockContext, {
        fields: [
          { name: 'Name', type: 'textbox', ref: 'e1', value: 'Ada' },
          { name: 'Email', type: 'textbox', ref: 'e2', value: 'a@b.c' },
        ],
      }, response);

      expect(mockTab.refLocator).toHaveBeenNthCalledWith(1, { element: 'Name', ref: 'e1' });
      expect(mockTab.refLocator).toHaveBeenNthCalledWith(2, { element: 'Email', ref: 'e2' });
    });

    it('accepts an empty field list without touching the page', async () => {
      await fillForm.handle(mockContext, { fields: [] }, response);
      expect(mockTab.refLocator).not.toHaveBeenCalled();
    });
  });

  describe('browser_wait_for', () => {
    it('rejects a call that names nothing to wait for', async () => {
      await expect(waitFor.handle(mockContext, {}, response))
          .rejects.toThrow('Either time, text or textGone must be provided');
    });

    it('waits for text to become visible', async () => {
      await waitFor.handle(mockContext, { text: 'Loaded' }, response);

      expect(mockTab.page.getByText).toHaveBeenCalledWith('Loaded');
      expect(locator.waitFor).toHaveBeenCalledWith({ state: 'visible' });
      expect(response.result()).toBe('Waited for Loaded');
    });

    it('waits for text to disappear', async () => {
      await waitFor.handle(mockContext, { textGone: 'Spinner' }, response);
      expect(locator.waitFor).toHaveBeenCalledWith({ state: 'hidden' });
    });

    // A caller asking for both wants the old text gone before the new text
    // appears; reversing that would pass on a page that never changed.
    it('waits for disappearance before appearance when given both', async () => {
      await waitFor.handle(mockContext, { text: 'Done', textGone: 'Spinner' }, response);

      expect(locator.waitFor.mock.calls.map(call => call[0].state)).toEqual(['hidden', 'visible']);
    });

    it('caps a very long wait so a tool call cannot hang indefinitely', async () => {
      vi.useFakeTimers();
      try {
        const pending = waitFor.handle(mockContext, { time: 3600 }, response);
        // The cap is 30s regardless of the requested 3600s.
        await vi.advanceTimersByTimeAsync(30000);
        await pending;
        expect(response.result()).toBe('Waited for 3600');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('browser_file_upload', () => {
    // defineTabTool intercepts a clearsModalState tool whose modal state is
    // absent, so this surfaces as an error result rather than a throw — and
    // the handler never runs, so no path is ever handed to the page.
    it('reports an error instead of uploading when no file chooser is open', async () => {
      await fileUpload.handle(mockContext, { paths: ['/tmp/a.txt'] }, response);

      expect(response.isError()).toBe(true);
      expect(response.result()).toContain('can only be used when there is related modal state present');
    });

    it('hands the paths to the open chooser and clears the modal state', async () => {
      const setFiles = vi.fn().mockResolvedValue(undefined);
      const modalState = { type: 'fileChooser', description: 'File chooser', fileChooser: { setFiles } };
      mockTab.modalStates.mockReturnValue([modalState]);

      await fileUpload.handle(mockContext, { paths: ['/tmp/a.txt', '/tmp/b.txt'] }, response);

      expect(setFiles).toHaveBeenCalledWith(['/tmp/a.txt', '/tmp/b.txt']);
      // Leaving the modal state set would block every later snapshot tool.
      expect(mockTab.clearModalState).toHaveBeenCalledWith(modalState);
    });
  });
});

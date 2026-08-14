import { describe, it, expect, vi, beforeEach } from 'vitest';
import verifyTools from '../src/tools/verify.js';
import { Response } from '../src/response.js';
import type { Context } from '../src/context.js';

// The four browser_verify_* tools had no tests at all. They are assertion
// tools: an LLM calls them to confirm page state, so a verify that reports
// "Done" when the element is absent (or when the value differs) is worse than
// no check at all — it converts a failed expectation into a passing one.

const verifyElement = verifyTools.find(t => t.schema.name === 'browser_verify_element_visible')!;
const verifyText = verifyTools.find(t => t.schema.name === 'browser_verify_text_visible')!;
const verifyList = verifyTools.find(t => t.schema.name === 'browser_verify_list_visible')!;
const verifyValue = verifyTools.find(t => t.schema.name === 'browser_verify_value')!;

type LocatorStub = {
  count: ReturnType<typeof vi.fn>;
  inputValue: ReturnType<typeof vi.fn>;
  isChecked: ReturnType<typeof vi.fn>;
  textContent: ReturnType<typeof vi.fn>;
  getByText: ReturnType<typeof vi.fn>;
  filter: ReturnType<typeof vi.fn>;
};

function createLocator(overrides: Partial<Record<keyof LocatorStub, any>> = {}): LocatorStub {
  const locator: LocatorStub = {
    count: vi.fn().mockResolvedValue(1),
    inputValue: vi.fn().mockResolvedValue(''),
    isChecked: vi.fn().mockResolvedValue(false),
    textContent: vi.fn().mockResolvedValue(''),
    getByText: vi.fn(),
    filter: vi.fn(),
    ...(overrides as any),
  };
  // Default chaining returns the locator itself so `.filter({visible:true})`
  // and `.getByText(...)` keep the configured count/textContent.
  if (!overrides.filter)
    locator.filter = vi.fn().mockReturnValue(locator);
  if (!overrides.getByText)
    locator.getByText = vi.fn().mockReturnValue(locator);
  return locator;
}

describe('browser_verify_* tools', () => {
  let mockTab: any;
  let mockContext: Context;
  let response: Response;
  let refLocator: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    refLocator = vi.fn();
    mockTab = {
      page: {
        url: () => 'https://example.com',
        getByRole: vi.fn(),
        getByText: vi.fn(),
      },
      modalStates: vi.fn().mockReturnValue([]),
      modalStatesMarkdown: vi.fn().mockReturnValue([]),
      refLocator,
      waitForCompletion: vi.fn().mockImplementation(async (cb: any) => await cb()),
    };
    mockContext = {
      currentTabOrDie: () => mockTab,
      currentTab: () => mockTab,
      tabs: () => [mockTab],
      config: {},
    } as any;
    response = new Response(mockContext, 'verify', {});
  });

  describe('browser_verify_element_visible', () => {
    it('reports Done and emits a replayable assertion when the element exists', async () => {
      mockTab.page.getByRole.mockReturnValue(createLocator({ count: vi.fn().mockResolvedValue(1) }));

      await verifyElement.handle(mockContext, { role: 'button', accessibleName: 'Submit' }, response);

      expect(mockTab.page.getByRole).toHaveBeenCalledWith('button', { name: 'Submit' });
      expect(response.isError()).toBeFalsy();
      expect(response.result()).toBe('Done');
      expect(response.code()).toBe(
          `await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();`);
    });

    it('errors instead of reporting Done when no element matches', async () => {
      mockTab.page.getByRole.mockReturnValue(createLocator({ count: vi.fn().mockResolvedValue(0) }));

      await verifyElement.handle(mockContext, { role: 'button', accessibleName: 'Missing' }, response);

      expect(response.isError()).toBe(true);
      expect(response.result()).toContain('not found');
      // A failed verification must not leave behind a passing assertion.
      expect(response.result()).not.toContain('Done');
      expect(response.code()).toBe('');
    });

    it('escapes quotes in the generated assertion so the snippet stays valid JS', async () => {
      mockTab.page.getByRole.mockReturnValue(createLocator());

      await verifyElement.handle(
          mockContext, { role: 'link', accessibleName: `O'Brien "quoted"` }, response);

      const code = response.code();
      expect(code).toContain('O\\\'Brien');
      expect(() => new Function(`const page={getByRole(){}},expect=()=>({toBeVisible(){}});`)).not.toThrow();
    });
  });

  describe('browser_verify_text_visible', () => {
    it('filters to visible text and reports Done when present', async () => {
      const locator = createLocator({ count: vi.fn().mockResolvedValue(2) });
      mockTab.page.getByText.mockReturnValue(locator);

      await verifyText.handle(mockContext, { text: 'Welcome back' }, response);

      expect(mockTab.page.getByText).toHaveBeenCalledWith('Welcome back');
      // Invisible matches must not satisfy a visibility check.
      expect(locator.filter).toHaveBeenCalledWith({ visible: true });
      expect(response.isError()).toBeFalsy();
      expect(response.result()).toBe('Done');
      expect(response.code()).toBe(`await expect(page.getByText('Welcome back')).toBeVisible();`);
    });

    it('errors when the text is present but not visible', async () => {
      const hidden = createLocator({ count: vi.fn().mockResolvedValue(0) });
      mockTab.page.getByText.mockReturnValue(hidden);

      await verifyText.handle(mockContext, { text: 'Hidden' }, response);

      expect(response.isError()).toBe(true);
      expect(response.result()).toBe('Text not found');
      expect(response.code()).toBe('');
    });
  });

  describe('browser_verify_list_visible', () => {
    it('reports Done and builds an aria snapshot from the observed item text', async () => {
      const itemLocator = createLocator({
        count: vi.fn().mockResolvedValue(1),
        textContent: vi.fn()
            .mockResolvedValueOnce('Apples')
            .mockResolvedValueOnce('Pears'),
      });
      const listLocator = createLocator({ getByText: vi.fn().mockReturnValue(itemLocator) });
      refLocator.mockResolvedValue(listLocator);

      await verifyList.handle(
          mockContext, { element: 'Fruit list', ref: 'e5', items: ['Apples', 'Pears'] }, response);

      expect(refLocator).toHaveBeenCalledWith({ ref: 'e5', element: 'Fruit list' });
      expect(response.isError()).toBeFalsy();
      expect(response.result()).toBe('Done');
      // The snapshot is built from what the page actually reported, not from
      // the requested items, so a mismatch stays visible in the generated code.
      expect(response.code()).toContain('- listitem: "Apples"');
      expect(response.code()).toContain('- listitem: "Pears"');
    });

    it('errors on the first missing item and does not report the rest', async () => {
      const itemLocator = createLocator({
        count: vi.fn()
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0),
        textContent: vi.fn().mockResolvedValue('Apples'),
      });
      refLocator.mockResolvedValue(createLocator({ getByText: vi.fn().mockReturnValue(itemLocator) }));

      await verifyList.handle(
          mockContext, { element: 'Fruit list', ref: 'e5', items: ['Apples', 'Bananas'] }, response);

      expect(response.isError()).toBe(true);
      expect(response.result()).toBe('Item "Bananas" not found');
      expect(response.code()).toBe('');
    });
  });

  describe('browser_verify_value', () => {
    it.each([
      ['textbox', 'inputValue'],
      ['combobox', 'inputValue'],
      ['slider', 'inputValue'],
    ] as const)('reads %s state via %s and reports Done on a match', async (type, method) => {
      const locator = createLocator({ [method]: vi.fn().mockResolvedValue('42') });
      refLocator.mockResolvedValue(locator);

      await verifyValue.handle(
          mockContext, { type, element: 'Field', ref: 'e1', value: '42' }, response);

      expect(response.isError()).toBeFalsy();
      expect(response.result()).toBe('Done');
      expect(response.code()).toContain(`toHaveValue('42')`);
    });

    it('errors with both the expected and the actual value on a mismatch', async () => {
      refLocator.mockResolvedValue(createLocator({ inputValue: vi.fn().mockResolvedValue('actual') }));

      await verifyValue.handle(
          mockContext, { type: 'textbox', element: 'Field', ref: 'e1', value: 'expected' }, response);

      expect(response.isError()).toBe(true);
      expect(response.result()).toBe('Expected value "expected", but got "actual"');
      expect(response.code()).toBe('');
    });

    it.each([
      [true, 'true', 'toBeChecked'],
      [false, 'false', 'not.toBeChecked'],
    ] as const)('matches a checkbox that is %s and emits %s', async (checked, value, matcher) => {
      refLocator.mockResolvedValue(createLocator({ isChecked: vi.fn().mockResolvedValue(checked) }));

      await verifyValue.handle(
          mockContext, { type: 'checkbox', element: 'Box', ref: 'e2', value }, response);

      expect(response.isError()).toBeFalsy();
      expect(response.result()).toBe('Done');
      expect(response.code()).toContain(`.${matcher}();`);
    });

    it('errors when a checkbox is unchecked but expected checked', async () => {
      refLocator.mockResolvedValue(createLocator({ isChecked: vi.fn().mockResolvedValue(false) }));

      await verifyValue.handle(
          mockContext, { type: 'radio', element: 'Box', ref: 'e2', value: 'true' }, response);

      expect(response.isError()).toBe(true);
      expect(response.result()).toBe('Expected value "true", but got "false"');
    });

    // Only the literal string "true" means checked; any other string is false.
    // Without this, "TRUE"/"1" would silently verify the opposite state.
    it.each(['TRUE', '1', 'yes', ''])('treats %o as unchecked, not as true', async value => {
      refLocator.mockResolvedValue(createLocator({ isChecked: vi.fn().mockResolvedValue(true) }));

      await verifyValue.handle(
          mockContext, { type: 'checkbox', element: 'Box', ref: 'e2', value }, response);

      expect(response.isError()).toBe(true);
      expect(response.result()).toContain('but got "true"');
    });
  });

  it('exposes exactly the four verify tools, all under the opt-in verify capability', () => {
    expect(verifyTools.map(t => t.schema.name).sort()).toEqual([
      'browser_verify_element_visible',
      'browser_verify_list_visible',
      'browser_verify_text_visible',
      'browser_verify_value',
    ]);
    // These are assertions, not page mutations; readOnly keeps them usable
    // where destructive tools are refused.
    for (const tool of verifyTools) {
      expect(tool.capability).toBe('verify');
      expect(tool.schema.type).toBe('readOnly');
    }
  });
});

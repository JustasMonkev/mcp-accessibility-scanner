/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import type { ElementHandle, Page } from 'playwright';
import type { Bounded } from './scenarioGuard.js';

export async function assertFocusedEditable(target: ElementHandle<Element>, bounded: Bounded): Promise<void> {
  const editable = await bounded(() => target.evaluate(element => {
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement)
      focused = focused.shadowRoot.activeElement;
    if (window !== window.top || element.ownerDocument !== document || !element.isConnected || focused !== element || element.getAttribute('aria-disabled') === 'true' || element.getAttribute('aria-readonly') === 'true')
      return false;
    if (element instanceof HTMLInputElement)
      return ['text', 'search', 'email', 'tel', 'url', 'password', 'number'].includes(element.type) && !element.readOnly && !element.matches(':disabled');
    if (element instanceof HTMLTextAreaElement)
      return !element.readOnly && !element.matches(':disabled');
    return element instanceof HTMLElement && element.isContentEditable;
  }));
  if (!editable)
    throw new Error('focus-changed');
}

export async function typeIntoFocusedElement(page: Page, target: ElementHandle<Element>, text: string, bounded: Bounded): Promise<void> {
  await assertFocusedEditable(target, bounded);
  for (const character of text.replace(/\r\n?/g, '\n')) {
    await bounded(() => character === '\n' ? page.keyboard.press('Enter') : page.keyboard.type(character));
    await assertFocusedEditable(target, bounded);
  }
}

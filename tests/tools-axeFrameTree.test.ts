/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import axeCore from 'axe-core/axe.min.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { finishFrameTree, scannedFrame, unscannedFrame, unscannedFramesOf } from '../src/tools/axeFrameTree.js';

import type { FrameOutcome } from '../src/tools/axeFrameTree.js';

// A partial result as runPartial reports it, serialized: no rule results needed
// here, one serialized element per selected child frame, and environment data
// on the top frame only. `marker` lets a test read back which frame it is.
function partial(marker: string, childCount: number, top = false) {
  const spec = { selector: ['iframe'], ancestry: ['iframe'], xpath: ['/iframe'], nodeIndexes: [0], source: '<iframe>' };
  const result = {
    results: [],
    frames: Array.from({ length: childCount }, () => spec),
    environmentData: top ? {
      testEngine: { name: 'axe-core', version: axeCore.version },
      testRunner: { name: 'axe' },
      testEnvironment: { userAgent: 'test', windowWidth: 1280, windowHeight: 720 },
      timestamp: '2026-01-01T00:00:00.000Z',
      url: 'https://example.com/',
    } : undefined,
    marker,
  };
  return { json: JSON.stringify(result), frameCount: childCount };
}

// A scanned frame; most tests have no closed-shadow frames to record.
function scanned(serialized: ReturnType<typeof partial>, children: FrameOutcome[] = [], unseenFrames: string[] = []) {
  return scannedFrame(serialized, children, unseenFrames);
}

function leaf(marker: string): FrameOutcome {
  return scanned(partial(marker, 0));
}

const markersOf = (partials: axeCore.PartialResults) => partials.map(result => (result as unknown as { marker: string } | null)?.marker ?? null);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('axe frame tree', () => {
  it('hands finishRun each frame, then its descendants, then its next sibling', async () => {
    const finishRun = vi.spyOn(axeCore, 'finishRun');
    // top
    // - a
    //   - a1
    //   - a2
    // - b
    //   - b1
    const top = scanned(partial('top', 2, true), [
      scanned(partial('a', 2), [leaf('a1'), leaf('a2')]),
      scanned(partial('b', 1), [leaf('b1')]),
    ]);
    await finishFrameTree(top, {});

    expect(markersOf(finishRun.mock.calls[0][0])).toEqual(['top', 'a', 'a1', 'a2', 'b', 'b1']);
  });

  it('puts a null where a frame could not run, with nothing below it', async () => {
    const finishRun = vi.spyOn(axeCore, 'finishRun');
    // An unscanned frame has no children to give: axe never ran there, so it
    // never named any, and finishRun requires them to be absent.
    const top = scanned(partial('top', 3, true), [
      leaf('a'),
      unscannedFrame('https://example.com/b'),
      scanned(partial('c', 1), [unscannedFrame('https://example.com/c1')]),
    ]);
    await finishFrameTree(top, {});

    expect(markersOf(finishRun.mock.calls[0][0])).toEqual(['top', 'a', null, 'c', null]);
  });

  it.each([
    ['fewer', 2, 1],
    ['more', 1, 2],
  ])('refuses %s outcomes than the child frames axe selected', (_label, selected, recorded) => {
    // A mismatch would shift every later partial onto the wrong frame's
    // selectors without finishRun noticing.
    expect(() => scanned(partial('top', selected, true), Array.from({ length: recorded }, (_, index) => leaf(`child-${index}`))))
        .toThrow(`Axe selected ${selected} child frame(s) but ${recorded} outcome(s) were recorded`);
  });

  it('leaves the tree untouched, so finishing it twice gives the same report', async () => {
    // finishRun writes frame specs into the partials it is handed; each call
    // parses its own from the stored JSON.
    const top = scanned(partial('top', 1, true), [scanned(partial('a', 1), [leaf('a1')])]);
    const before = structuredClone(top);

    const first = await finishFrameTree(top, {});
    const second = await finishFrameTree(top, {});

    expect(top).toEqual(before);
    expect({ ...second, timestamp: first.timestamp }).toEqual(first);
  });

  it('lists unscanned frames in document order, with frames hidden from axe after each frame\'s children', () => {
    const top = scanned(partial('top', 2, true), [
      scanned(partial('a', 1), [unscannedFrame('a1')], ['a-closed-shadow']),
      unscannedFrame('b'),
    ], ['top-closed-shadow']);

    expect(unscannedFramesOf(top)).toEqual(['a1', 'a-closed-shadow', 'b', 'top-closed-shadow']);
    expect(unscannedFramesOf(leaf('clean'))).toEqual([]);
  });
});

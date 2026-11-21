/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import axe from 'axe-core/axe.min.js';

// axe.finishRun takes one flat array whose meaning is purely positional: each
// frame's partial result, then its descendants depth-first, then its next
// sibling; a frame that could not run is a null, and its descendants are left
// out entirely. Get the order wrong and finishRun does not fail -- it files one
// frame's findings under another frame's selectors.
//
// This module is the only place that order exists. Callers build a tree of
// frame outcomes, which cannot express the invalid cases, and hand it over.

/**
 * One frame's runPartial result, kept as the JSON it crossed the protocol in.
 * finishRun writes into the results it is handed, so each call parses its own
 * copy: the tree never changes, and no defensive deep copy is needed.
 */
export type SerializedPartial = {
  readonly json: string;
  /** partial.frames.length: how many child frames this run selected. */
  readonly frameCount: number;
};

/** A frame axe ran in, with one outcome per child frame it selected. */
export type ScannedFrame = {
  readonly scanned: true;
  readonly partial: SerializedPartial;
  readonly children: readonly FrameOutcome[];
  /** Frames axe could not see, and so never selected (closed shadow roots). */
  readonly unseenFrames: readonly string[];
};

/** A frame axe selected but could not run in. It has no children by type. */
type UnscannedFrame = {
  readonly scanned: false;
  readonly description: string;
};

export type FrameOutcome = ScannedFrame | UnscannedFrame;

export function scannedFrame(partial: SerializedPartial, children: readonly FrameOutcome[], unseenFrames: readonly string[] = []): ScannedFrame {
  // partial.frames lists the child frames this run selected, in the order
  // finishRun will pair them with the partials that follow. One outcome per
  // selected frame is what keeps that pairing honest.
  if (partial.frameCount !== children.length)
    throw new Error(`Axe selected ${partial.frameCount} child frame(s) but ${children.length} outcome(s) were recorded; refusing to merge results that would be attributed to the wrong frames.`);
  return { scanned: true, partial, children, unseenFrames };
}

export function unscannedFrame(description: string): UnscannedFrame {
  return { scanned: false, description };
}

function toFinishRunOrder(frame: FrameOutcome): axe.PartialResults {
  if (!frame.scanned)
    return [null];
  return [JSON.parse(frame.partial.json) as axe.PartialResult, ...frame.children.flatMap(toFinishRunOrder)];
}

/** Frames that contributed no findings, in document order: a frame's failed children, then frames it hid from axe. */
export function unscannedFramesOf(frame: FrameOutcome): string[] {
  if (!frame.scanned)
    return [frame.description];
  return [...frame.children.flatMap(unscannedFramesOf), ...frame.unseenFrames];
}

/** Merges a scanned top frame and its descendants into one axe report. */
export async function finishFrameTree(top: ScannedFrame, options: axe.RunOptions): Promise<axe.AxeResults> {
  return axe.finishRun(toFinishRunOrder(top), options);
}

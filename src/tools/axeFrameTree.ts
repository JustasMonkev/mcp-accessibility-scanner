/*
 * Copyright (c) MCP Accessibility Scanner contributors.
 * Licensed under the Apache License, Version 2.0.
 */

import axe from 'axe-core/axe.min.js';


export type SerializedPartial = {
  readonly json: string;
  readonly frameCount: number;
};

export type ScannedFrame = {
  readonly scanned: true;
  readonly partial: SerializedPartial;
  readonly children: readonly FrameOutcome[];
  readonly unseenFrames: readonly string[];
};

type UnscannedFrame = {
  readonly scanned: false;
  readonly description: string;
};

export type FrameOutcome = ScannedFrame | UnscannedFrame;

export function scannedFrame(partial: SerializedPartial, children: readonly FrameOutcome[], unseenFrames: readonly string[]): ScannedFrame {
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

export function unscannedFramesOf(frame: FrameOutcome): string[] {
  if (!frame.scanned)
    return [frame.description];
  return [...frame.children.flatMap(unscannedFramesOf), ...frame.unseenFrames];
}

export async function finishFrameTree(top: ScannedFrame, options: axe.RunOptions): Promise<axe.AxeResults> {
  return axe.finishRun(toFinishRunOrder(top), options);
}

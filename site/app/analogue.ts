/*
 * The analogue advisor: matches the current situation against every hour of
 * a saved investigation, the way forecasters reach for historical analogues.
 * Deliberately auditable — a six-number situation vector per hour with stated
 * scales, cosine similarity over the trailing three hours, no fitted weights.
 * A match is an advisory to open the saved case and investigate, never a
 * forecast or a diagnosis.
 */

import { PEOPLE_CLASSES } from "./map-draw";

/** The structural slice of a case slot the advisor reads. */
export type VectorSlot = {
  up: number;
  down: number;
  rainMm: number;
  rainWarning: boolean;
  signals: { properties: Record<string, unknown> }[];
};

/* Fixed normalisation scales, chosen from the April record's magnitudes:
 * 12 gated signals, 100% class drop, 50 mm/h rain. Stated, not fitted. */
const SCALE_SIGNALS = 12;
const SCALE_RAIN_MM = 50;
const WINDOW_HOURS = 3;
const MIN_SCORE = 0.7;

function classDrop(slot: VectorSlot, people: boolean): number {
  let observed = 0;
  let expected = 0;
  for (const feature of slot.signals) {
    const isPeople = PEOPLE_CLASSES.has(String(feature.properties.transport_class));
    if (isPeople !== people) continue;
    observed += Number(feature.properties.observed_count);
    expected += Number(feature.properties.expected_count);
  }
  return expected > 0 ? Math.max(0, (expected - observed) / expected) : 0;
}

/** Six auditable dimensions: down, up, vehicle drop, people drop, rain, warning. */
export function situationVector(slot: VectorSlot): number[] {
  return [
    Math.min(1, slot.down / SCALE_SIGNALS),
    Math.min(1, slot.up / SCALE_SIGNALS),
    classDrop(slot, false),
    classDrop(slot, true),
    Math.min(1, slot.rainMm / SCALE_RAIN_MM),
    slot.rainWarning ? 1 : 0,
  ];
}

export function slotVectors(slots: VectorSlot[]): number[][] {
  return slots.map(situationVector);
}

function windowVector(vectors: number[][], atIndex: number): number[] {
  const joined: number[] = [];
  for (let back = WINDOW_HOURS - 1; back >= 0; back -= 1) {
    joined.push(...vectors[Math.max(0, atIndex - back)]);
  }
  return joined;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export type AnalogueMatch = { index: number; score: number };

/**
 * Nearest saved hour to the current trailing window, or null while the
 * current hour is too quiet to compare (calm matching calm is noise, so an
 * advisory needs some activity first) or below the stated score floor.
 */
export function matchAnalogue(
  currentSlots: VectorSlot[],
  atIndex: number,
  savedVectors: number[][],
): AnalogueMatch | null {
  if (atIndex < 0 || atIndex >= currentSlots.length) return null;
  const now = currentSlots[atIndex];
  if (now.down < 2 && now.rainMm < 2.5) return null;
  const currentVectors = slotVectors(currentSlots);
  const current = windowVector(currentVectors, atIndex);
  let best: AnalogueMatch | null = null;
  for (let index = WINDOW_HOURS - 1; index < savedVectors.length; index += 1) {
    const score = cosine(current, windowVector(savedVectors, index));
    if (!best || score > best.score) best = { index, score };
  }
  return best && best.score >= MIN_SCORE ? best : null;
}

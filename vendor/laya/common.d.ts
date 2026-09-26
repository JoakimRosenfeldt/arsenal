import type { TokenizerLike } from "./tokenizer.js";
export type QType = "choice" | "score" | "noul";
export interface InternalQ {
    t: QType;
    ins: string;
    crit: unknown;
    labels?: {
        false: string;
        true: string;
    };
}
export declare function serializeState(state: unknown): string;
export declare function renderOptions(q: InternalQ): string[];
export interface QuestionPrefix {
    /** [CLS] head [SEP] options [SEP] — the state-independent part of the sequence. */
    ids: number[];
    /** Mask-marker positions (absolute; the prefix sits at the start of the final sequence). */
    markers: number[];
    nOptions: number;
}
/** The question half of `buildSequence`: everything before the state tokens. Hoisted out so
 * callers asking several questions about the same state can encode the state text only once. */
export declare function buildQuestionPrefix(tok: TokenizerLike, q: InternalQ, maxLen?: number, headMaxLen?: number, optionOrder?: number[]): QuestionPrefix;
/** Append pre-encoded state tokens to a question prefix. Identical output to building the
 * whole sequence in one pass, but the state only needs encoding once per state, not once
 * per (state, question) pair. */
export declare function sequenceWithState(prefix: QuestionPrefix, stateIds: number[], sepId: number, maxLen?: number, truncateLeft?: boolean): {
    ids: number[];
    markers: number[];
};
export declare function buildSequence(tok: TokenizerLike, state: unknown, q: InternalQ, maxLen?: number, headMaxLen?: number, optionOrder?: number[], truncateLeft?: boolean): {
    ids: number[];
    markers: number[];
};
export declare function softmax(z: number[]): number[];
export declare function confidenceFromProbs(p: number[]): number;
export declare function answerConfidence(p: number[]): number;
export declare const TEMP_MIN = 0.5, TEMP_MAX = 5;
export declare function clampTemperature(t: unknown): number;
export declare function tempBucket(qtype: number, k: number): string;
/** Max of a length list without spread (Math.max(...arr) throws RangeError past ~100k args). */
export declare function maxOf(values: ArrayLike<number>, fallback?: number): number;
export interface CollateItem {
    ids: number[];
    markers: number[];
    qtype: number;
    label?: number;
    target?: number[];
    [k: string]: unknown;
}
export interface CollatedBatch {
    inputIds: number[][];
    attentionMask: number[][];
    markerPos: number[][];
    markerMask: boolean[][];
    qtype: number[];
    label: number[];
    meta: Record<string, unknown>[];
    target?: number[][];
}
/** TS parity of py `collate_items(batch, pad_id)`: batch = list of groups. */
export declare function collateItems(batch: CollateItem[][], padId: number): CollatedBatch | null;

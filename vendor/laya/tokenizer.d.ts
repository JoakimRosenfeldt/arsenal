export interface TokenizerLike {
    readonly clsId: number;
    readonly sepId: number;
    readonly maskId: number;
    readonly padId: number;
    readonly maskToken: string;
    encode(text: string): number[];
}
/** Special ids of the laya ModernBERT checkpoint (HF added_tokens). */
export declare const CHECKPOINT_IDS: {
    readonly cls: 50281;
    readonly sep: 50282;
    readonly mask: 50284;
    readonly pad: 50283;
    readonly unk: 50280;
};
/** Alias lookup order per special: ModernBERT `[X]` names first, Gemma `<x>` names after. */
export declare const SPECIAL_ALIASES: {
    readonly cls: readonly ["[CLS]", "<bos>", "<s>"];
    readonly sep: readonly ["[SEP]", "<eos>", "</s>"];
    readonly pad: readonly ["[PAD]", "<pad>"];
    readonly mask: readonly ["[MASK]", "<mask>"];
    readonly unk: readonly ["[UNK]", "<unk>"];
};
export interface TokenizerIds {
    cls: number;
    sep: number;
    mask: number;
    pad: number;
    unk: number;
}
export type PreTokenizerKind = "metaspace" | "bytelevel";
export interface TokenizerData {
    vocab: Map<string, number>;
    merges: Map<string, number>;
    ids: TokenizerIds;
    kind: PreTokenizerKind;
    maskToken: string;
    /** Normalizer Replace rules (pattern -> content) applied in order before pre-tokenizing. */
    replaces: Array<[string, string]>;
}
/** Metaspace word-boundary marker (HF SentencePiece-style replacement for ' '). */
export declare const METASPACE_REPLACEMENT = "\u2581";
export declare function bpeEncode(vocab: Map<string, number>, merges: Map<string, number>, text: string): number[];
/** Metaspace (SentencePiece-style) BPE encode: unicode chars, NO byte map, NO lowercasing.
 * Normalizer replaces run first, then one marker is ensured at text start, then the text
 * is cut into words at each marker (marker kept as word prefix) with maximal `\n` runs
 * as their own pieces. Each piece is BPE-merged; leftover unknown pieces map to unk. */
export declare function metaspaceEncode(vocab: Map<string, number>, merges: Map<string, number>, text: string, unkId?: number, replaces?: ReadonlyArray<readonly [string, string]>): number[];
/** Dispatch to the Metaspace or GPT-2/ByteLevel encoder based on the parsed pre-tokenizer. */
export declare function encodeWithData(data: TokenizerData, text: string): number[];
/** Parse an HF tokenizer.json ({model vocab/merges, normalizer, pre_tokenizer, added_tokens}). */
export declare function parseTokenizerJson(raw: unknown): TokenizerData | null;
/** Load an HF tokenizer.json from a local path (node) or URL into vocab/merges/ids. */
export declare function loadTokenizerJson(pathOrUrl: string): Promise<TokenizerData | null>;

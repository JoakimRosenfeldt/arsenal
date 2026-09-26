import type { SessionProvider } from "./providers.js";
import { type TokenizerLike } from "./tokenizer.js";
import { type DecideOptions, type DecisionResult } from "./structured.js";
import { HookRegistry, type HookArg, type PredictHook } from "./hooks.js";
export declare const QTYPES: Record<string, number>;
export interface QuestionDef {
    type: string;
    instructions?: unknown;
    criteria?: unknown;
    [k: string]: unknown;
}
export interface ActionInfo {
    act_probability: number;
}
export interface ChoiceAnswer {
    type: "choice";
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
    answer_confidence: number;
    action: ActionInfo;
}
export interface ScoreAnswer {
    type: "score";
    score: number;
    legend: Record<string, unknown>;
    probabilities: Record<string, number>;
    confidence: number;
    answer_confidence: number;
    action: ActionInfo;
}
export interface NoulAnswer {
    type: "noul";
    noul: number;
    confidence: number;
    answer_confidence: number;
    action: ActionInfo;
}
export type SystemAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export interface SystemUsage {
    input_tokens: number;
    output_tokens: number;
}
export interface SystemOneResult {
    model: string;
    answers: Record<string, SystemAnswer>;
    usage: SystemUsage;
}
export interface AgentCfg {
    max_len?: number;
    head_max_len?: number;
    temperature?: unknown;
    temperature_by_options?: Record<string, unknown>;
    [k: string]: unknown;
}
export interface AgentOptions {
    provider: SessionProvider;
    tok?: TokenizerLike;
    cfg?: AgentCfg;
    /** Commit SHA the artifacts were loaded from (pinned/requested or `x-repo-commit`); null for local dirs. */
    revision?: string | null;
    max_len?: number;
    head_max_len?: number;
    temperature?: unknown;
    temperature_by_options?: Record<string, unknown>;
    /**
     * Per-language temperature overrides, keyed by language code; keys are normalised to
     * their base subtag (`de-AT` -> `de`), matching Python `Agent(lang_temperatures=...)`.
     * Each entry may carry a `temperature` list of 3 floats (default: the base raw
     * temperature) and/or a `temperature_by_options` map (default: none). A matching
     * override replaces the scale wholesale — see the note at the decode site.
     */
    lang_temperatures?: Record<string, {
        temperature?: unknown;
        temperature_by_options?: Record<string, unknown>;
    } | null>;
    hooks?: HookArg;
    onPredictStart?: PredictHook;
    onPredictEnd?: PredictHook;
    hooksRaise?: boolean;
}
/** Per-call options shared by Agent.systemOne/predict and Router.predict. */
export interface PredictOptions {
    /**
     * Language of the request (e.g. "de"); when the Agent has a matching
     * `lang_temperatures` override it selects that language's temperature, exactly like
     * Python `system_one(..., lang=...)`. Routing alone never sets this.
     */
    lang?: string | null;
    hooks?: HookArg;
    onPredictStart?: PredictHook;
    onPredictEnd?: PredictHook;
    hooksRaise?: boolean;
}
export declare function checkQuestion(qid: string, qdef: unknown): void;
export declare function toInternal(qdef: QuestionDef): {
    t: "choice" | "score" | "noul";
    ins: string;
    crit: unknown;
    labels?: {
        false: string;
        true: string;
    };
};
export declare function defaultTokenizer(): TokenizerLike;
export declare class Agent extends HookRegistry {
    hooksRaise: boolean;
    cfg: AgentCfg;
    provider: SessionProvider;
    revision: string | null;
    tok: TokenizerLike;
    maxLen: number;
    headMaxLen: number;
    temperatureRaw: unknown;
    temperatureByOptionsRaw: Record<string, unknown>;
    temperature: number[];
    temperatureByOptions: Record<string, number>;
    langTemperatures: Record<string, {
        temperature: number[];
        temperatureByOptions: Record<string, number>;
    }>;
    constructor(opts: AgentOptions);
    /**
     * Evaluate typed questions across one state in a single forward pass.
     *
     * `hooks` / `onPredictStart` / `onPredictEnd` observe or shape the prediction, appended
     * after any hooks installed on the Agent; a start hook may rewrite the state/questions or
     * call `ctx.skip(...)` to short-circuit inference, an end hook may rewrite the results.
     * See hooks.ts. `hooksRaise` overrides the Agent's setting for this call.
     */
    systemOne(state: unknown, questions: Record<string, QuestionDef>, opts?: PredictOptions): Promise<SystemOneResult>;
    private _predictHooked;
    private _systemOneCore;
    predict(state: unknown, questions: Record<string, QuestionDef>, opts?: PredictOptions): Promise<SystemOneResult>;
    /**
     * Answer `state` against a JSON schema (or explicit `opts.questions`) and return typed
     * values — see `structured.ts`. Pass exactly one of `schema` or `opts.questions`; other
     * options are forwarded to `predict`.
     */
    decide(state: unknown, schema: unknown, opts: DecideOptions & PredictOptions & {
        returnDetails: true;
    }): Promise<DecisionResult>;
    decide(state: unknown, schema?: unknown, opts?: DecideOptions & PredictOptions): Promise<Record<string, unknown>>;
    static load(modelDirOrRepo: string, opts?: {
        device?: string;
        subfolder?: string | null;
        localDir?: string;
        token?: string | null;
        numThreads?: number;
        /** Per-language temperature overrides; see AgentOptions.lang_temperatures. */
        lang_temperatures?: AgentOptions["lang_temperatures"];
        /** Optional commit SHA/branch/tag to fetch; omitted uses the Hub default and existing cache. */
        revision?: string | null;
        /**
         * Opt-in `{artifact name: SHA-256 hexdigest}` check before any artifact is parsed
         * or executed. A missing artifact or digest mismatch throws and loading is refused.
         */
        expectedSha256?: Record<string, string>;
    }): Promise<Agent>;
}

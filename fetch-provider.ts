/** Ordinary web-page routes, distinct from resource-specific specialized extractors. */
export const FETCH_PROVIDERS = ["http", "firecrawl", "crawl4ai", "jina", "tinyfish", "search1api", "querit", "kagi", "ollama", "parallel", "parallel-mcp", "brightdata", "gemini", "tavily"] as const;
export type FetchProvider = typeof FETCH_PROVIDERS[number];
export type FetchProviderSelection = "auto" | FetchProvider;

export type ExtractionAttempt = {
	provider: FetchProvider | null;
	extractionProvider?: string | null;
} & (
	| { outcome: "succeeded" }
	| {
		outcome: "failed";
		/** Sanitized text only; never credentials, transport causes, or stacks. */
		error: string;
	}
);

/** Optional while existing extraction paths are incrementally connected to provenance. */
export type ExtractionProvenance = {
	/** Successful ordinary web-page route, or null when none produced usable content. */
	provider?: FetchProvider | null;
	/** Actual specialized extractor, not the HTTP transport or the answer model. */
	extractionProvider?: string | null;
	/** Ordered extraction invocations only; discovery/download and skipped routes are not attempts. */
	attempts?: ExtractionAttempt[];
};

export const FETCH_PROVIDER_DESCRIPTION = "Ordinary web-page provider for every URL. Enabled, eligible specialized extractors run first; recoverable specialized failures continue to the selected provider only when safety and resource controls can be preserved. Omit or use auto for HTTP-first automatic routing after specialized dispatch. An explicit provider is strict: do not accept ordinary HTTP page content or substitute another web-page provider. Resource-type discovery may still use guarded HTTP. Raw and authenticated fetching are HTTP-only; provider selection cannot override safety policies.";

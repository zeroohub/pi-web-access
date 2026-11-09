/** Ordinary web-page routes, distinct from resource-specific specialized extractors. */
export const FETCH_PROVIDERS = ["http", "firecrawl", "crawl4ai", "jina", "tinyfish", "search1api", "querit", "kagi", "ollama", "parallel", "parallel-mcp", "brightdata", "gemini", "deepseek", "exa", "tabstack", "tavily"] as const;
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

export const FETCH_PROVIDER_DESCRIPTION = "Web pages: specialized first; HTTP-first auto; explicit is strict; raw/auth HTTP-only.";

import { existsSync, readFileSync } from "node:fs";
import type TurndownService from "turndown";
import pLimit from "p-limit";
import { FETCH_PROVIDERS, type FetchProvider, type FetchProviderSelection, type ExtractionProvenance, type ExtractionAttempt } from "./fetch-provider.ts";
import { activityMonitor } from "./activity.ts";
import { extractRSCContent } from "./rsc-extract.ts";
import { extractPDFToMarkdown, getPDFExtractionAttempts, PDFProcessingLimitError, isPDF, loadPDFConfig } from "./pdf-extract.ts";
import { extractGitHub, parseGitHubUrl } from "./github-extract.ts";
import { extractGitHubIssuePr, parseGitHubIssuePrUrl } from "./github-issue-pr.ts";
import { isYouTubeURL, isYouTubeEnabled, extractYouTube, extractYouTubeFrame, extractYouTubeFrames, getYouTubeStreamInfo } from "./youtube-extract.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { isGeminiApiAvailable, isGeminiApiAvailableWithVideo } from "./gemini-api.ts";
import { isGeminiWebAvailable } from "./gemini-web.ts";
import { extractWithUrlContext, extractWithGeminiWeb } from "./gemini-url-context.ts";
import { extractWithParallel, isParallelAvailable } from "./parallel.ts";
import { extractWithParallelMcp, isParallelMcpAvailable } from "./parallel-mcp.ts";
import { extractWithTinyFish, isTinyFishAvailable } from "./tinyfish.ts";
import { extractWithSearch1API, isSearch1APIAvailable } from "./search1api.ts";
import { extractWithQuerit, isQueritAvailable } from "./querit.ts";
import { extractWithTavily, isTavilyAvailable } from "./tavily.ts";
import { extractWithKagi, isKagiExtractAvailable } from "./kagi.ts";
import { extractWithOllama, isOllamaFetchAvailable } from "./ollama.ts";
import { extractWithFirecrawl, isFirecrawlAvailable } from "./firecrawl.ts";
import { extractWithCrawl4ai, isCrawl4aiAvailable } from "./crawl4ai.ts";
import { extractWithBrightDataUnlocker, isBrightDataUnlockerAvailable } from "./brightdata-unlocker.ts";
import { isVideoFile, extractVideo, extractVideoFrame, getLocalVideoDuration } from "./video-extract.ts";
import { appendDeclaredWebLinks, discoverDeclaredWebLinks, type DeclaredWebLink } from "./declared-web-links.ts";
import { fetchRemoteUrl, loadFetchContentDomainPolicy, resolveFetchContentRedirectPolicy, loadFetchContentUserAgent, loadSsrfConfig, validateRemoteUrl, type DomainPolicy, type Lookup, type RedirectPolicy, type SsrfConfig } from "./ssrf-protection.ts";
import { formatSeconds, getWebSearchConfigPath, type ProxiedRequestInit } from "./utils.ts";
import { isImageEnabled } from "./feature-config.ts";
import { assertAuthFetchUrl, authFetchRedirectGuard, type AuthFetchProfile } from "./auth-fetch.ts";
import { getBrowserCookiesForHosts, getLastBrowserCookieDiagnostic } from "./chrome-cookies.ts";
import { sanitizeInlineDataUris } from "./data-uri-sanitize.ts";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_CONFIGURED_TIMEOUT_MS = 2_147_483_647;
const CONCURRENT_LIMIT = 3;
const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();

function loadFetchTimeoutMs(): number {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return DEFAULT_TIMEOUT_MS;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8"));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid config in ${WEB_SEARCH_CONFIG_PATH}: expected a JSON object`);
	}

	const fetchConfig = (raw as Record<string, unknown>).fetch;
	if (fetchConfig === undefined) return DEFAULT_TIMEOUT_MS;
	if (!fetchConfig || typeof fetchConfig !== "object" || Array.isArray(fetchConfig)) {
		throw new Error(`fetch in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}

	const value = (fetchConfig as Record<string, unknown>).timeout;
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid fetch.timeout in ${WEB_SEARCH_CONFIG_PATH}: expected a positive finite number of seconds, got ${JSON.stringify(value)}`);
	}
	const timeoutMs = Math.ceil(value * 1000);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CONFIGURED_TIMEOUT_MS) {
		throw new Error(`Invalid fetch.timeout in ${WEB_SEARCH_CONFIG_PATH}: converted timeout must be a finite safe integer from 1 through ${MAX_CONFIGURED_TIMEOUT_MS} milliseconds`);
	}
	return Math.max(1, timeoutMs);
}

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large", "PDF extraction is disabled", "PDF exceeds configured pdf.maxSizeMB limit", "Image fetching is disabled", "PaddleOCR credential resolution failed:"];
const MIN_USEFUL_CONTENT = 500;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
type FetchRouting = { providers: FetchProvider[]; allowRemoteHostedProviders: boolean };
const DEFAULT_FETCH_PROVIDER_ORDER: FetchProvider[] = ["http", "firecrawl", "crawl4ai", "jina", "tinyfish", "search1api", "querit", "kagi", "ollama", "parallel", "brightdata", "gemini"];
const REMOTE_HOSTED_FETCH_PROVIDERS = new Set<FetchProvider>(["jina", "tinyfish", "search1api", "querit", "kagi", "ollama", "parallel", "parallel-mcp", "brightdata", "gemini", "tavily"]);

function isDefuddleConsoleError(args: Parameters<typeof console.error>): boolean {
	const prefix = args[0];
	return prefix === "Defuddle" || (typeof prefix === "string" && /^Defuddle(?:\s|:)/.test(prefix));
}

async function extractWithDefuddle(text: string, url: string): Promise<{ title: string; content: string } | null> {
	const { Defuddle } = await import("defuddle/node");
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML(text);
	try {
		Object.defineProperty(document, "location", {
			value: new URL(url),
			configurable: true,
		});
	} catch {
		return null;
	}
	let processingError: unknown;
	const originalConsoleError = console.error;
	console.error = (...args) => {
		if (isDefuddleConsoleError(args)) {
			if (args[0] === "Defuddle" && args[1] === "Error processing document:") {
				processingError = args[2];
			}
			return;
		}
		originalConsoleError(...args);
	};

	let resultPromise: ReturnType<typeof Defuddle>;
	try {
		// With useAsync:false, Defuddle parses synchronously before returning its promise.
		// Keep the console interception limited to that call so unrelated Pi output is
		// never routed through this fallback's handler.
		// SAFETY: linkedom supplies the DOM document interface used by Defuddle.
		resultPromise = Defuddle(document as unknown as Document, url, { markdown: true, useAsync: false });
	} finally {
		console.error = originalConsoleError;
	}

	const result = await resultPromise;
	if (processingError !== undefined) {
		throw new Error(`Defuddle failed to process document: ${errorMessage(processingError)}`);
	}
	return typeof result.content === "string" ? { title: result.title, content: result.content } : null;
}

export { loadSsrfConfig } from "./ssrf-protection.ts";

export function loadSsrfAllowRanges(): string[] {
	return loadSsrfConfig().allowRanges;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isConfigParseError(err: unknown): boolean {
	return errorMessage(err).startsWith("Failed to parse ");
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function isAbortException(err: unknown): boolean {
	return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
}

function isRedirectPolicyError(message: string): boolean {
	return message.startsWith("Authenticated fetch refused cross-origin redirect") ||
		message.startsWith("Refused cross-origin redirect by fetch_content redirect policy") ||
		message.startsWith("Blocked internal ") ||
		message.startsWith("Blocked hostname by fetch_content domain policy") ||
		message.startsWith("Hostname not allowed by fetch_content domain policy") ||
		message.startsWith("Too many redirects fetching ") ||
		message === "Only HTTP and HTTPS URLs can be fetched remotely" ||
		message === "URL must include a hostname" ||
		message.startsWith("Failed to resolve ");
}

function isExtractionPreflightError(err: unknown): boolean {
	const message = errorMessage(err);
	return err instanceof CredentialResolutionError || isConfigParseError(err) ||
		message.includes("credential resolution failed:") ||
		(message.startsWith("Invalid ") && (message.includes(WEB_SEARCH_CONFIG_PATH) || message.startsWith("Invalid CIDR"))) ||
		/^(?:Unsupported .*version|.* in .*web-search\.json (?:must|requires)|PDF provider .*requires)/.test(message);
}

function isFatalExtractionError(err: unknown): boolean {
	const message = errorMessage(err).replace(/^GitHub REST fallback failed: /, "");
	return isExtractionPreflightError(err) || isNonRecoverableHttpError(message);
}

function isGitHubSpecializationEnabled(section: "githubClone" | "githubPrIssue"): boolean {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return true;
	const config = JSON.parse(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8"));
	return config?.[section]?.enabled !== false;
}

// Errors that end routing: no other provider may be tried after them.
function isNonRecoverableHttpError(error: string | null): boolean {
	return !!error && (NON_RECOVERABLE_ERRORS.some(prefix => error.startsWith(prefix)) ||
		isRedirectPolicyError(error) || isConfigParseError(error));
}

function imageGateError(): string | null {
	try {
		return isImageEnabled() ? null : "Image fetching is disabled by image.enabled";
	} catch (err) {
		return errorMessage(err);
	}
}

function redirectPolicyRouteRefusal(url: string, path: string): ExtractedContent {
	return { url, title: "", content: "", error: `Extraction path ${path} is disabled by the fetch_content same-origin redirect policy because its redirect chain cannot be observed` };
}

async function resolveAuthCookieHeader(url: string | URL, profile: AuthFetchProfile): Promise<string> {
	const parsed = assertAuthFetchUrl(profile, url.toString());
	const result = await getBrowserCookiesForHosts({ hosts: [parsed.hostname], profile: profile.chromeProfile, requestUrl: parsed });
	if (result?.cookieHeader) return result.cookieHeader;
	if (!result) {
		const diagnostic = getLastBrowserCookieDiagnostic();
		throw new Error(`Authenticated fetch profile ${profile.name} could not read browser cookies${diagnostic ? `: ${diagnostic}` : ""}`);
	}
	throw new Error(`Authenticated fetch profile ${profile.name} could not build a cookie header`);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchAuthenticatedRemoteUrl(
	url: string,
	init: RequestInit,
	validationOptions: { ssrf: SsrfConfig; domainPolicy: DomainPolicy; lookup?: Lookup; proxy?: string; redirects?: RedirectPolicy },
	profile: AuthFetchProfile,
): Promise<Response> {
	let current = await validateRemoteUrl(url, {
		allowRanges: validationOptions.ssrf.allowRanges,
		trustEnvProxy: validationOptions.ssrf.trustEnvProxy,
		domainPolicy: validationOptions.domainPolicy,
		proxy: validationOptions.proxy,
		...(validationOptions.lookup ? { lookup: validationOptions.lookup } : {}),
	});
	const originalOrigin = current.origin;
	let requestInit = init;
	for (let redirects = 0; redirects <= 5; redirects++) {
		const cookieHeader = await resolveAuthCookieHeader(current, profile);
		const headers = { ...(requestInit.headers as Record<string, string>), cookie: cookieHeader };
		const response = await fetch(current, { ...requestInit, headers, redirect: "manual" });
		if (!REDIRECT_STATUSES.has(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		if (redirects === 5) throw new Error(`Too many redirects fetching ${current.toString()}`);
		const from = current;
		const next = new URL(location, current);
		if (validationOptions.redirects === "same-origin" && next.origin !== originalOrigin) {
			throw new Error(`Refused cross-origin redirect by fetch_content redirect policy: ${originalOrigin} -> ${next.origin}`);
		}
		current = await validateRemoteUrl(next, {
			allowRanges: validationOptions.ssrf.allowRanges,
			trustEnvProxy: validationOptions.ssrf.trustEnvProxy,
			domainPolicy: validationOptions.domainPolicy,
			proxy: validationOptions.proxy,
			...(validationOptions.lookup ? { lookup: validationOptions.lookup } : {}),
		});
		authFetchRedirectGuard(profile, from, current);
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST")) {
			const { body: _body, ...nextInit } = requestInit;
			requestInit = { ...nextInit, method: "GET" };
		}
	}
	throw new Error(`Too many redirects fetching ${current.toString()}`);
}

function loadFetchRouting(): FetchRouting {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) {
		return { providers: DEFAULT_FETCH_PROVIDER_ORDER, allowRemoteHostedProviders: false };
	}

	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		raw = parsed as Record<string, unknown>;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}

	if (!Object.hasOwn(raw, "fetchRouting")) {
		return { providers: DEFAULT_FETCH_PROVIDER_ORDER, allowRemoteHostedProviders: false };
	}
	const routing = raw.fetchRouting;
	if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
		throw new Error(`fetchRouting in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}

	const routingConfig = routing as Record<string, unknown>;
	const providersValue = routingConfig.providers;
	let providers = DEFAULT_FETCH_PROVIDER_ORDER;
	if (providersValue !== undefined) {
		if (!Array.isArray(providersValue) || providersValue.length === 0) {
			throw new Error(`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} must be a non-empty array`);
		}

		providers = [];
		for (const provider of providersValue) {
			const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
			if (!FETCH_PROVIDERS.includes(normalized as FetchProvider)) {
				throw new Error(`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} contains an invalid provider: ${String(provider)}`);
			}
			if (providers.includes(normalized as FetchProvider)) {
				throw new Error(`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} must not contain duplicates: ${normalized}`);
			}
			providers.push(normalized as FetchProvider);
		}
	}

	const allowRemoteHostedProvidersValue = routingConfig.allowRemoteHostedProviders;
	if (allowRemoteHostedProvidersValue !== undefined && typeof allowRemoteHostedProvidersValue !== "boolean") {
		throw new Error(`fetchRouting.allowRemoteHostedProviders in ${WEB_SEARCH_CONFIG_PATH} must be a boolean`);
	}

	return { providers, allowRemoteHostedProviders: allowRemoteHostedProvidersValue === true };
}

/** Names of the search/fetch tools the caller has actually registered, so
 * failure guidance never points at tools that do not exist in the session. */
export interface RegisteredToolNames {
	webSearch?: string;
	fetchContent?: string;
	getSearchContent?: string;
}

/** Guidance for definitive origin 404/410 responses: no extraction provider
 * can retrieve a page the origin says is gone, so point at the registered
 * search/fetch tools (when the caller knows them) instead of provider config. */
function notFoundGuidance(result: ExtractedContent, toolNames?: RegisteredToolNames): string {
	const lines = [
		result.error ?? `HTTP ${result.status}`,
		"",
		`The origin server says this page does not exist (HTTP ${result.status}), so extraction providers cannot retrieve it.`,
	];
	if (toolNames?.webSearch && toolNames.fetchContent) {
		lines.push(`The page may have moved or been renamed. Use ${toolNames.webSearch} to find the current URL, then retry ${toolNames.fetchContent} with it.`);
	} else if (toolNames?.webSearch) {
		lines.push(`The page may have moved or been renamed. Use ${toolNames.webSearch} to find the current URL.`);
	} else {
		lines.push("The page may have moved or been renamed. Find the current URL, then retry the fetch with it.");
	}
	return lines.join("\n");
}


/** Fallback-list hint for the keyless Jina Reader. Returns null when Jina
 * already ran for this fetch, and otherwise names only the config change still
 * missing, so users keep their existing or default provider order. */
function jinaReaderGuidance(routing: FetchRouting, providerOrder: FetchProvider[], needsRemoteOptIn: boolean): string | null {
	if (providerOrder.includes("jina")) return null;
	const privacy = "target URLs are fetched through Jina's infrastructure";
	const optInCaveat = "this also allows the other hosted providers in your fetch provider order";
	if (routing.providers.includes("jina")) {
		return `  • Enable the keyless Jina Reader fallback: set fetchRouting.allowRemoteHostedProviders to true in ${WEB_SEARCH_CONFIG_PATH} (Jina is already in your fetch provider order; ${optInCaveat}; ${privacy})`;
	}
	return needsRemoteOptIn
		? `  • Enable the keyless Jina Reader fallback: add "jina" to your existing fetchRouting.providers and set fetchRouting.allowRemoteHostedProviders to true in ${WEB_SEARCH_CONFIG_PATH} (${optInCaveat}; ${privacy})`
		: `  • Enable the keyless Jina Reader fallback: add "jina" to your existing fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} (${privacy})`;
}
function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

// Share first-use initialization without loading Turndown at extension startup.
let turndownInstance: Promise<TurndownService> | undefined;
async function loadTurndown(): Promise<TurndownService> {
	const { default: TurndownService } = await import("turndown");
	return new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
	});
}
function getTurndown(): Promise<TurndownService> {
	turndownInstance ??= loadTurndown();
	return turndownInstance;
}

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface VideoFrame {
	data: string;
	mimeType: string;
	timestamp: string;
}

export type FrameData = { data: string; mimeType: string };
export type FrameResult = FrameData | { error: string };

export interface ExtractedContent extends ExtractionProvenance {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	frames?: VideoFrame[];
	duration?: number;
	mimeType?: string;
	status?: number;
}

type HttpExtractedContent = ExtractedContent & { declaredLinks?: DeclaredWebLink[]; terminal?: boolean };

export interface ExtractOptions {
	provider?: FetchProviderSelection;
	timeoutMs?: number;
	forceClone?: boolean;
	prompt?: string;
	timestamp?: string;
	frames?: number;
	model?: string;
	mode?: "readable" | "raw" | "answer";
	answerModel?: string;
	authFetchProfile?: AuthFetchProfile;
	toolNames?: RegisteredToolNames;
	/** Optional HTTP(S) or SOCKS proxy URL; routed through the curl-backed transport. */
	proxy?: string;
	/** Reject direct image URLs with this error instead of decoding them with Pi's
	 * resizeImage. Hosts without the Pi runtime set it; Pi leaves it unset. */
	rejectDirectImages?: string;
	/** Custom DNS resolver used for SSRF validation. Primarily a test seam. */
	lookup?: Lookup;
	/** "follow" permits normal redirects and hosted extraction; "same-origin" restricts
	 * both. A configured same-origin policy cannot be weakened per call. */
	redirects?: RedirectPolicy;
}

/** Resolve the direct HTTP/Jina fetch budget, with a per-call override taking precedence. */
export function resolveFetchTimeoutMs(options?: Pick<ExtractOptions, "timeoutMs">): number {
	return options?.timeoutMs ?? loadFetchTimeoutMs();
}

const JINA_READER_BASE = "https://r.jina.ai/";

async function extractWithJinaReader(
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
	lookup?: Lookup,
): Promise<ExtractedContent | null> {
	const jinaUrl = JINA_READER_BASE + url;

	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });

	try {
		const ssrf = loadSsrfConfig();
		const domainPolicy = loadFetchContentDomainPolicy();
		await validateRemoteUrl(url, {
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			domainPolicy,
			...(lookup ? { lookup } : {}),
		});
		const res = await fetch(jinaUrl, {
			headers: {
				"Accept": "text/markdown",
				"X-No-Cache": "true",
			},
			signal: AbortSignal.any([
				AbortSignal.timeout(timeoutMs),
				...(signal ? [signal] : []),
			]),
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const content = await res.text();
		activityMonitor.logComplete(activityId, res.status);

		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) {
			return null;
		}

		const markdownPart = content.slice(contentStart + 17).trim(); // 17 = "Markdown Content:".length

		// Check for failed JS rendering or minimal content
		if (markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")) {
			return null;
		}

		const title = extractHeadingTitle(markdownPart) ?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title, content: markdownPart, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

function parseTimestamp(ts: string): number | null {
	const num = Number(ts);
	if (!isNaN(num) && num >= 0) return Math.floor(num);
	const parts = ts.split(":").map(Number);
	if (parts.some(p => isNaN(p) || p < 0)) return null;
	if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
	if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
	return null;
}

type TimestampSpec = { type: "single"; seconds: number } | { type: "range"; start: number; end: number };

function parseTimestampSpec(ts: string): TimestampSpec | null {
	const dashIdx = ts.indexOf("-", 1);
	if (dashIdx > 0) {
		const start = parseTimestamp(ts.slice(0, dashIdx));
		const end = parseTimestamp(ts.slice(dashIdx + 1));
		if (start !== null && end !== null && end > start) return { type: "range", start, end };
	}
	const seconds = parseTimestamp(ts);
	return seconds !== null ? { type: "single", seconds } : null;
}

const DEFAULT_RANGE_FRAMES = 6;
const MIN_FRAME_INTERVAL = 5;

function computeRangeTimestamps(start: number, end: number, maxFrames: number = DEFAULT_RANGE_FRAMES): number[] {
	if (maxFrames <= 1) return [start];
	const duration = end - start;
	const idealInterval = duration / (maxFrames - 1);
	if (idealInterval < MIN_FRAME_INTERVAL) {
		const timestamps: number[] = [];
		for (let t = start; t <= end && timestamps.length < maxFrames; t += MIN_FRAME_INTERVAL) {
			timestamps.push(t);
		}
		return timestamps;
	}
	return Array.from({ length: maxFrames }, (_, i) => Math.round(start + i * idealInterval));
}

function buildFrameResult(
	url: string, label: string, requestedCount: number,
	frames: VideoFrame[], error: string | null, duration?: number,
): ExtractedContent {
	if (frames.length === 0) {
		const msg = error ?? "Frame extraction failed";
		return { url, title: `Frames ${label} (0/${requestedCount})`, content: msg, error: msg };
	}
	return {
		url,
		title: `Frames ${label} (${frames.length}/${requestedCount})`,
		content: `${frames.length} frames extracted from ${label}`,
		error: null,
		frames,
		...(duration !== undefined ? { duration } : {}),
	};
}

async function extractLocalFrames(
	filePath: string, timestamps: number[],
): Promise<{ frames: VideoFrame[]; error: string | null }> {
	const results = await Promise.all(timestamps.map(async (t) => {
		const frame = await extractVideoFrame(filePath, t);
		if ("error" in frame) return { error: frame.error };
		return { ...frame, timestamp: formatSeconds(t) };
	}));
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const firstError = results.find((f): f is { error: string } => "error" in f);
	return { frames, error: frames.length === 0 && firstError ? firstError.error : null };
}

type LocalVideoInfoResult =
	| { status: "video"; info: NonNullable<ReturnType<typeof isVideoFile>> }
	| { status: "not-video" }
	| { status: "invalid"; error: string };

function safeVideoInfo(url: string): LocalVideoInfoResult {
	try {
		const info = isVideoFile(url);
		return info ? { status: "video", info } : { status: "not-video" };
	} catch (err) {
		return { status: "invalid", error: errorMessage(err) };
	}
}

type DispatchProvenance = {
	attempts: ExtractionAttempt[];
	earlyExtractionProvider?: "youtube" | "local-video";
};

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	const attempts: ExtractionAttempt[] = [];
	const selected = options?.provider;
	let validationError: string | null = null;
	if (selected !== undefined && selected !== "auto" && !FETCH_PROVIDERS.includes(selected as FetchProvider)) {
		validationError = "Invalid fetch provider selection";
	} else if (selected && selected !== "auto" && selected !== "http" && (options?.mode === "raw" || options?.authFetchProfile)) {
		validationError = "Raw and authenticated fetching require provider http or auto";
	} else if (options?.forceClone && !parseGitHubUrl(url)) {
		validationError = "forceClone only works with GitHub repository URLs";
	} else if (options?.model && !isYouTubeURL(url).isYouTube && safeVideoInfo(url).status !== "video") {
		validationError = "model only works with YouTube and local video files";
	}
	if (validationError) return { url, title: "", content: "", error: validationError, provider: null, attempts };
	const provenance: DispatchProvenance = { attempts };
	const { terminal: _terminal, declaredLinks: _declaredLinks, ...extracted } = await dispatchContent(url, signal, options, provenance) as HttpExtractedContent;
	const result = signal?.aborted ? abortedResult(url) : extracted;
	const extractionProvider = provenance.earlyExtractionProvider;
	if (extractionProvider && !isFatalExtractionError(result.error ?? "")) {
		attempts.push(result.error
			? { provider: null, extractionProvider, outcome: "failed", error: `${extractionProvider} extraction failed` }
			: { provider: null, extractionProvider, outcome: "succeeded" });
		if (!result.error) result.extractionProvider = extractionProvider;
	}
	return { ...result, provider: result.provider ?? null, attempts };
}

async function dispatchContent(
	url: string,
	signal: AbortSignal | undefined,
	options: ExtractOptions | undefined,
	provenance: DispatchProvenance,
): Promise<ExtractedContent> {
	const { attempts } = provenance;
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	let redirectPolicy: RedirectPolicy | undefined;
	try {
		redirectPolicy = resolveFetchContentRedirectPolicy(options?.redirects);
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}
	let remoteUrl: URL | null = null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") remoteUrl = parsed;
	} catch {
		// Local paths are handled below without remote URL validation.
		remoteUrl = null;
	}
	if (remoteUrl) {
		try {
			const ssrf = loadSsrfConfig();
			const domainPolicy = loadFetchContentDomainPolicy();
			// An invalid configured User-Agent fails here, before any provider fallback runs.
			loadFetchContentUserAgent();
			await validateRemoteUrl(remoteUrl, {
				allowRanges: ssrf.allowRanges,
				trustEnvProxy: ssrf.trustEnvProxy,
				domainPolicy,
				proxy: options?.proxy,
				...(options?.lookup ? { lookup: options.lookup } : {}),
			});
		} catch (err) {
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	if (options?.authFetchProfile || options?.mode === "raw") {
		try {
			const result = await extractViaHttp(url, resolveFetchTimeoutMs(options), signal, options);
			attempts.push(...(result.attempts ?? []));
			return result;
		} catch (err) {
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	if (redirectPolicy === "same-origin") {
		if (parseGitHubIssuePrUrl(url)) return redirectPolicyRouteRefusal(url, "GitHub issue/PR");
		if (parseGitHubUrl(url)) return redirectPolicyRouteRefusal(url, "GitHub repository");
		if (isYouTubeURL(url).isYouTube) return redirectPolicyRouteRefusal(url, "YouTube");
	}

	if (options?.frames || options?.timestamp) {
		try {
			if (isYouTubeURL(url).isYouTube && !isYouTubeEnabled()) {
				return { url, title: "", content: "", error: "YouTube extraction is disabled by youtube.enabled" };
			}
		} catch (err) {
			return { url, title: "", content: "", error: errorMessage(err) };
		}
		const disabled = imageGateError();
		if (disabled) return { url, title: "", content: "", error: disabled };
	}

	if (options?.frames && !options.timestamp) {
		const frameCount = options.frames;
		const ytInfo = isYouTubeURL(url);
		if (ytInfo.isYouTube && ytInfo.videoId) {
			const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
			if ("error" in streamInfo) {
				return { url, title: "Frames", content: streamInfo.error, error: streamInfo.error };
			}
			if (streamInfo.duration === null) {
				const error = "Cannot determine video duration. Use a timestamp range instead.";
				return { url, title: "Frames", content: error, error };
			}
			const dur = Math.floor(streamInfo.duration);
			const timestamps = computeRangeTimestamps(0, dur, frameCount);
			provenance.earlyExtractionProvider = "youtube";
			const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
			const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
			return buildFrameResult(url, label, timestamps.length, result.frames, result.error, streamInfo.duration);
		}

		const localVideo = safeVideoInfo(url);
		if (localVideo.status === "invalid") {
			return { url, title: "", content: "", error: localVideo.error };
		}
		if (localVideo.status === "video") {
			const durationResult = await getLocalVideoDuration(localVideo.info.absolutePath);
			if (typeof durationResult !== "number") {
				return { url, title: "Frames", content: durationResult.error, error: durationResult.error };
			}
			const dur = Math.floor(durationResult);
			const timestamps = computeRangeTimestamps(0, dur, frameCount);
			provenance.earlyExtractionProvider = "local-video";
			const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
			const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
			return buildFrameResult(url, label, timestamps.length, result.frames, result.error, durationResult);
		}

		return { url, title: "", content: "", error: "Frame extraction only works with YouTube and local video files" };
	}

	if (options?.timestamp) {
		const spec = parseTimestampSpec(options.timestamp);
		if (!spec) {
			return {
				url,
				title: "",
				content: "",
				error: `Invalid timestamp format: "${options.timestamp}". Use "H:MM:SS", "MM:SS", "85", or "start-end".`,
			};
		}

		const frameCount = options.frames;
		const ytInfo = isYouTubeURL(url);
		if (ytInfo.isYouTube && ytInfo.videoId) {
			const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
			if ("error" in streamInfo) {
				if (spec.type === "range") {
					const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
					return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
				}
				if (frameCount) {
					const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
					const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
					return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
				}
				return { url, title: `Frame at ${options.timestamp}`, content: streamInfo.error, error: streamInfo.error };
			}

			if (spec.type === "range") {
				const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
				if (streamInfo.duration !== null && spec.end > streamInfo.duration) {
					const error = `Timestamp ${formatSeconds(spec.end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
					return { url, title: `Frames ${label}`, content: error, error };
				}
				const timestamps = frameCount
					? computeRangeTimestamps(spec.start, spec.end, frameCount)
					: computeRangeTimestamps(spec.start, spec.end);
				provenance.earlyExtractionProvider = "youtube";
				const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error, result.duration ?? undefined);
			}

			if (frameCount) {
				const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
				const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
				if (streamInfo.duration !== null && end > streamInfo.duration) {
					const error = `Timestamp ${formatSeconds(end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
					return { url, title: `Frames ${label}`, content: error, error };
				}
				const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
				provenance.earlyExtractionProvider = "youtube";
				const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error, result.duration ?? undefined);
			}

			if (streamInfo.duration !== null && spec.seconds > streamInfo.duration) {
				const error = `Timestamp ${formatSeconds(spec.seconds)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
				return { url, title: `Frame at ${options.timestamp}`, content: error, error };
			}
			provenance.earlyExtractionProvider = "youtube";
			const frame = await extractYouTubeFrame(ytInfo.videoId, spec.seconds, streamInfo);
			if ("error" in frame) {
				return { url, title: `Frame at ${options.timestamp}`, content: frame.error, error: frame.error };
			}
			// mimeType marks the image as the payload (like direct-image fetches); a
			// text result with a bonus thumbnail stays without one.
			return { url, title: `Frame at ${options.timestamp}`, content: `Video frame at ${options.timestamp}`, error: null, thumbnail: frame, mimeType: frame.mimeType };
		}

		const localVideo = safeVideoInfo(url);
		if (localVideo.status === "invalid") {
			return { url, title: "", content: "", error: localVideo.error };
		}
		if (localVideo.status === "video") {
			if (spec.type === "range") {
				const timestamps = frameCount
					? computeRangeTimestamps(spec.start, spec.end, frameCount)
					: computeRangeTimestamps(spec.start, spec.end);
				provenance.earlyExtractionProvider = "local-video";
				const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
				const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
			}

			if (frameCount) {
				const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
				const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
				provenance.earlyExtractionProvider = "local-video";
				const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
				const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
			}

			provenance.earlyExtractionProvider = "local-video";
			const frame = await extractVideoFrame(localVideo.info.absolutePath, spec.seconds);
			if ("error" in frame) {
				return { url, title: `Frame at ${options.timestamp}`, content: frame.error, error: frame.error };
			}
			return { url, title: `Frame at ${options.timestamp}`, content: `Video frame at ${options.timestamp}`, error: null, thumbnail: frame, mimeType: frame.mimeType };
		}

		return { url, title: "", content: "", error: "Timestamp extraction only works with YouTube and local video files" };
	}

	const localVideo = safeVideoInfo(url);
	if (localVideo.status === "invalid") {
		return { url, title: "", content: "", error: localVideo.error };
	}
	if (localVideo.status === "video") {
		try {
			if (localVideo.info.withinUploadLimit && (isGeminiApiAvailableWithVideo() || await isGeminiWebAvailable())) {
				provenance.earlyExtractionProvider = "local-video";
			}
			const result = await extractVideo(localVideo.info, signal, options);
			if (signal?.aborted) return abortedResult(url);
			return result ?? { url, title: "", content: "", error: `Video analysis requires Gemini access. Either:\n  1. Sign into gemini.google.com in Chrome (free, uses cookies)\n  2. Set GEMINI_API_KEY in ${WEB_SEARCH_CONFIG_PATH}` };
		} catch (err) {
			if (isAbortError(err)) return abortedResult(url);
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	try {
		if (!remoteUrl) new URL(url);
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}
	if (!remoteUrl) {
		return { url, title: "", content: "", error: "Only HTTP and HTTPS URLs can be fetched remotely" };
	}

	let specializedError: string | null = null;
	let specializedFailure: ExtractedContent | null = null;
	const runSpecialized = async (
		extractionProvider: string,
		extract: () => Promise<ExtractedContent | null>,
	): Promise<ExtractedContent | null> => {
		try {
			const result = await extract();
			if (signal?.aborted || result?.error === "Aborted") {
				attempts.push({ provider: null, extractionProvider, outcome: "failed", error: "Aborted" });
				return abortedResult(url);
			}
			if (result && !result.error) {
				attempts.push({ provider: null, extractionProvider, outcome: "succeeded" });
				return { ...result, provider: null, extractionProvider };
			}
			if (result?.error && isExtractionPreflightError(result.error)) return result;
			attempts.push({ provider: null, extractionProvider, outcome: "failed", error: `${extractionProvider} extraction failed` });
			if (result?.error && isFatalExtractionError(result.error)) return result;
			specializedError = result?.error ?? `${extractionProvider} extraction failed`;
			if (result?.error && result.content) specializedFailure = result;
		} catch (err) {
			if (isExtractionPreflightError(err)) return { url, title: "", content: "", error: errorMessage(err) };
			attempts.push({ provider: null, extractionProvider, outcome: "failed", error: `${extractionProvider} extraction failed` });
			if (signal?.aborted || isAbortError(err)) return abortedResult(url);
			if (isFatalExtractionError(err)) return { url, title: "", content: "", error: errorMessage(err) };
			specializedError = errorMessage(err);
		}
		return null;
	};
	try {
		if (parseGitHubIssuePrUrl(url) && isGitHubSpecializationEnabled("githubPrIssue")) {
			const result = await runSpecialized("github", () => extractGitHubIssuePr(url, signal, options));
			if (result) return result;
		}
		if (parseGitHubUrl(url) && isGitHubSpecializationEnabled("githubClone")) {
			const result = await runSpecialized("github", () => extractGitHub(url, signal, options?.forceClone));
			if (result) return result;
		}
		if (isYouTubeURL(url).isYouTube && isYouTubeEnabled()) {
			const result = await runSpecialized("youtube", () => extractYouTube(url, signal, options?.prompt, options?.model));
			if (result) return result;
		}
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}

	if (signal?.aborted) return abortedResult(url);

	let fetchTimeoutMs: number;
	try {
		fetchTimeoutMs = resolveFetchTimeoutMs(options);
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}

	let fetchRouting: FetchRouting;
	try {
		fetchRouting = loadFetchRouting();
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}
	if ((!options?.provider || options.provider === "auto") && redirectPolicy === "same-origin" && !fetchRouting.providers.includes("http")) {
		return redirectPolicyRouteRefusal(url, fetchRouting.providers[0]!);
	}
	const explicitProvider = options?.provider && options.provider !== "auto" ? options.provider : undefined;
	const configuredOrder = explicitProvider ? [explicitProvider] : fetchRouting.providers;
	const providerOrder: FetchProvider[] = explicitProvider ? [explicitProvider] : redirectPolicy === "same-origin"
		? ["http"]
		: remoteUrl && !fetchRouting.allowRemoteHostedProviders
			? configuredOrder.filter(provider => !REMOTE_HOSTED_FETCH_PROVIDERS.has(provider))
			: configuredOrder;
	if (providerOrder.length === 0) {
		return {
			url,
			title: "",
			content: "",
			error: "Remote hosted fetch providers are disabled unless fetchRouting.allowRemoteHostedProviders is true",
		};
	}

	let httpResult: ExtractedContent | null = null;
	let declaredLinks: DeclaredWebLink[] = [];
	let activeProvider: FetchProvider = "http";
	const withDeclaredLinks = (result: ExtractedContent): ExtractedContent => ({
		...result,
		provider: activeProvider,
		content: appendDeclaredWebLinks(result.content, declaredLinks),
	});
	const parseErrorResult = (message: string): ExtractedContent => httpResult
		? { ...httpResult, error: message }
		: { url, title: "", content: "", error: message };
	const runHttpProvider = async (): Promise<ExtractedContent | null> => {
		const { declaredLinks: discoveredLinks = [], terminal, ...result } = await extractViaHttp(url, fetchTimeoutMs, signal, options);
		httpResult = result;
		attempts.push(...(httpResult.attempts ?? []));
		declaredLinks = discoveredLinks;
		if (signal?.aborted) return abortedResult(url);
		if (!httpResult.error && (!explicitProvider || explicitProvider === "http" || httpResult.extractionProvider)) return httpResult;
		if (terminal || isNonRecoverableHttpError(httpResult.error) || httpResult.error === options?.rejectDirectImages) {
			return httpResult;
		}
		return null;
	};

	const providerErrors: Partial<Record<FetchProvider, string>> = {};
	// Discovery and local page extraction share this guarded response. HTTP is
	// never revisited through a later entry in the automatic provider list.
	if (remoteUrl) {
		const result = await runHttpProvider();
		if (result) return result;
		if (explicitProvider === "http") return specializedFailure ?? httpResult!;
	}

	if (explicitProvider && explicitProvider !== "http") {
		if (redirectPolicy === "same-origin") return redirectPolicyRouteRefusal(url, explicitProvider);
		if (remoteUrl && !fetchRouting.allowRemoteHostedProviders && REMOTE_HOSTED_FETCH_PROVIDERS.has(explicitProvider)) {
			return { url, title: "", content: "", error: "Remote hosted fetch providers are disabled unless fetchRouting.allowRemoteHostedProviders is true" };
		}
	}

	for (const provider of providerOrder) {
		if (signal?.aborted) return abortedResult(url);
		if (provider === "http") continue;
		activeProvider = provider;
		let invoked = false;
		try {
			let available: boolean;
			switch (provider) {
				case "firecrawl": available = isFirecrawlAvailable(); break;
				case "crawl4ai": available = isCrawl4aiAvailable(); break;
				case "jina": available = true; break;
				case "tinyfish": available = isTinyFishAvailable(); break;
				case "search1api": available = isSearch1APIAvailable(); break;
				case "querit": available = isQueritAvailable(); break;
				case "tavily": available = isTavilyAvailable(); break;
				case "kagi": available = isKagiExtractAvailable(); break;
				case "ollama": available = isOllamaFetchAvailable(); break;
				case "parallel": available = isParallelAvailable(); break;
				case "parallel-mcp": available = isParallelMcpAvailable(); break;
				case "brightdata": available = isBrightDataUnlockerAvailable(); break;
				case "gemini": available = isGeminiApiAvailable() || Boolean(await isGeminiWebAvailable()); break;
			}
			if (!available) {
				if (explicitProvider) return parseErrorResult(`Fetch provider ${provider} is unavailable; configure its credentials or endpoint`);
				continue;
			}
			if (signal?.aborted) return abortedResult(url);
			const guardedOptions = { timeoutMs: options?.timeoutMs, lookup: options?.lookup, ssrf: loadSsrfConfig() };
			invoked = true;
			let result: ExtractedContent | null;
			switch (provider) {
				case "firecrawl": result = await extractWithFirecrawl(url, signal, guardedOptions); break;
				case "crawl4ai": result = await extractWithCrawl4ai(url, signal, guardedOptions); break;
				case "jina": result = await extractWithJinaReader(url, fetchTimeoutMs, signal, options?.lookup); break;
				case "tinyfish": result = await extractWithTinyFish(url, signal, options); break;
				case "search1api": result = await extractWithSearch1API(url, signal, options); break;
				case "querit": result = await extractWithQuerit(url, signal, options); break;
				case "tavily": result = await extractWithTavily(url, signal, { ...options, timeoutMs: fetchTimeoutMs }); break;
				case "kagi": result = await extractWithKagi(url, signal, guardedOptions); break;
				case "ollama": result = await extractWithOllama(url, signal, guardedOptions); break;
				case "parallel": result = await extractWithParallel(url, signal, options); break;
				case "parallel-mcp": result = await extractWithParallelMcp(url, signal, options); break;
				case "brightdata": result = await extractWithBrightDataUnlocker(url, signal, guardedOptions); break;
				case "gemini": result = await extractWithUrlContext(url, signal) ?? await extractWithGeminiWeb(url, signal); break;
			}
			if (signal?.aborted) {
				attempts.push({ provider, outcome: "failed", error: "Aborted" });
				return abortedResult(url);
			}
			if (result && !result.error) {
				attempts.push({ provider, outcome: "succeeded" });
				return withDeclaredLinks(result);
			}
			attempts.push({ provider, outcome: "failed", error: `${provider} extraction failed` });
			if (result?.error) providerErrors[provider] = result.error;
		} catch (err) {
			if (isExtractionPreflightError(err)) return parseErrorResult(errorMessage(err));
			if (invoked) attempts.push({ provider, outcome: "failed", error: `${provider} extraction failed` });
			if (signal?.aborted || isAbortException(err) || (provider !== "crawl4ai" && isAbortError(err))) return abortedResult(url);
			providerErrors[provider] = errorMessage(err);
			if (isFatalExtractionError(err)) {
				const message = provider === "brightdata" ? `Bright Data fallback failed: ${errorMessage(err)}` : errorMessage(err);
				return parseErrorResult(message);
			}
		}
	}

	if (signal?.aborted) return abortedResult(url);
	const finalHttpResult = httpResult as ExtractedContent | null;
	if (!explicitProvider && finalHttpResult && declaredLinks.length > 0) {
		const httpAttempt = attempts.findIndex(attempt => attempt.provider === "http");
		if (httpAttempt >= 0) attempts[httpAttempt] = { provider: "http", outcome: "succeeded" };
		return { ...finalHttpResult, provider: "http", error: null };
	}
	const finalSpecializedFailure = specializedFailure as ExtractedContent | null;
	if (finalSpecializedFailure) return { ...finalSpecializedFailure, provider: null, extractionProvider: undefined };
	if (explicitProvider) return parseErrorResult(providerErrors[explicitProvider] ?? `${explicitProvider} extraction failed`);

	// A definitive 404/410 from the origin means no extraction provider can
	// retrieve the page, so the provider-configuration checklist below would
	// send users down the wrong path. Point at search instead.
	if (finalHttpResult?.status === 404 || finalHttpResult?.status === 410) {
		return { ...finalHttpResult, error: notFoundGuidance(finalHttpResult, options?.toolNames) };
	}
	// Under the redirect policy no other provider may run, so provider setup hints do not apply.
	if (redirectPolicy === "same-origin" && finalHttpResult) return finalHttpResult;

	const searchToolName = options?.toolNames?.webSearch;
	const jinaHint = jinaReaderGuidance(fetchRouting, providerOrder, Boolean(remoteUrl) && !fetchRouting.allowRemoteHostedProviders);
	const guidance = [
		...(specializedError ? [specializedError] : []),
		finalHttpResult?.error ?? "No fetch_content provider returned content",
		...(providerErrors["firecrawl"] ? [`Firecrawl fallback failed: ${providerErrors["firecrawl"]}`] : []),
		...(providerErrors["crawl4ai"] ? [`Crawl4AI fallback failed: ${providerErrors["crawl4ai"]}`] : []),
		...(providerErrors["tinyfish"] ? [`TinyFish fallback failed: ${providerErrors["tinyfish"]}`] : []),
		...(providerErrors["search1api"] ? [`Search1API fallback failed: ${providerErrors["search1api"]}`] : []),
		...(providerErrors["querit"] ? [`Querit fallback failed: ${providerErrors["querit"]}`] : []),
		...(providerErrors["tavily"] ? [`Tavily fallback failed: ${providerErrors["tavily"]}`] : []),
		...(providerErrors["kagi"] ? [`Kagi fallback failed: ${providerErrors["kagi"]}`] : []),
		...(providerErrors["ollama"] ? [`Ollama fallback failed: ${providerErrors["ollama"]}`] : []),
		...(providerErrors["parallel"] ? [`Parallel fallback failed: ${providerErrors["parallel"]}`] : []),
		...(providerErrors["parallel-mcp"] ? [`Parallel MCP fallback failed: ${providerErrors["parallel-mcp"]}`] : []),
		...(providerErrors["brightdata"] ? [`Bright Data fallback failed: ${providerErrors["brightdata"]}`] : []),
		"",
		"Fallback options:",
		...(jinaHint ? [jinaHint] : []),
		`  • Set firecrawlBaseUrl in ${WEB_SEARCH_CONFIG_PATH} to a self-hosted Firecrawl instance`,
		`  • Set crawl4aiBaseUrl in ${WEB_SEARCH_CONFIG_PATH} to a self-hosted Crawl4AI instance`,
		`  • Set tinyfishApiKey in ${WEB_SEARCH_CONFIG_PATH} or TINYFISH_API_KEY`,
		`  • Set search1apiApiKey in ${WEB_SEARCH_CONFIG_PATH} or SEARCH1API_KEY`,
		`  • Set queritApiKey in ${WEB_SEARCH_CONFIG_PATH} or QUERIT_API_KEY`,
		`  • Set kagiApiKey in ${WEB_SEARCH_CONFIG_PATH} or KAGI_API_KEY`,
		`  • Set ollamaApiKey in ${WEB_SEARCH_CONFIG_PATH} or OLLAMA_API_KEY`,
		`  • Set parallelApiKey in ${WEB_SEARCH_CONFIG_PATH} or PARALLEL_API_KEY`,
		`  • Set brightdataApiKey and brightdataUnlockerZone in ${WEB_SEARCH_CONFIG_PATH} or BRIGHTDATA_API_KEY and BRIGHTDATA_UNLOCKER_ZONE`,
		`  • Set GEMINI_API_KEY in ${WEB_SEARCH_CONFIG_PATH}`,
		"  • Sign into gemini.google.com in Chrome",
		...(searchToolName ? [`  • Use ${searchToolName} to find content about this topic`] : []),
	].join("\n");
	return { ...(finalHttpResult ?? { url, title: "", content: "", error: null }), error: guidance };
}

// Cloudflare interstitials served with HTTP 200. The header is authoritative for
// any text response; the body check is HTML-only and needs both challenge-platform
// markers so a generic "Just a moment..." page never matches.
function isCloudflareChallenge(response: Response, text: string, isHTML: boolean): boolean {
	if (response.status !== 200) return false;
	if (response.headers.get("cf-mitigated") === "challenge") return true;
	return isHTML &&
		/<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(text) &&
		text.includes("window._cf_chl_opt") &&
		text.includes("/cdn-cgi/challenge-platform/");
}

function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;

	const bodyHtml = bodyMatch[1];

	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

	const scriptCount = (html.match(/<script/gi) || []).length;

	return textContent.length < 500 && scriptCount > 3;
}

export async function readPDFResponseBuffer(response: Response, maxSizeMB: number): Promise<ArrayBuffer> {
	const maxBytes = maxSizeMB * 1024 * 1024;
	return readResponseBufferWithLimit(response, maxBytes, () => pdfSizeLimitError(maxSizeMB));
}

async function readTextResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
	const buffer = await readResponseBufferWithLimit(response, maxBytes, () => responseSizeLimitError(maxBytes));
	const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(buffer);
	} catch {
		return new TextDecoder("utf-8").decode(buffer);
	}
}

function isTextContentType(contentType: string): boolean {
	const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/ld+json" ||
		mimeType === "application/xml" ||
		mimeType === "application/xhtml+xml" ||
		mimeType === "application/javascript" ||
		mimeType === "application/x-javascript" ||
		mimeType.endsWith("+json") ||
		mimeType.endsWith("+xml");
}

async function readResponseBufferWithLimit(
	response: Response,
	maxBytes: number,
	buildError: () => Error,
): Promise<ArrayBuffer> {
	const reader = response.body?.getReader();
	if (!reader) {
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxBytes) throw buildError();
		return buffer;
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw buildError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined.buffer;
}

function pdfSizeLimitError(maxSizeMB: number): Error {
	return new Error(`PDF exceeds configured pdf.maxSizeMB limit (${maxSizeMB} MB)`);
}

function responseSizeLimitError(maxBytes: number): Error {
	return new Error(`Response too large (${Math.round(maxBytes / 1024 / 1024)}MB)`);
}

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
// Servers that support markdown content negotiation (Cloudflare Markdown for
// Agents, Mintlify, Vercel) return markdown directly; others see the same
// relative preferences as BROWSER_ACCEPT. Raw mode keeps BROWSER_ACCEPT so it
// returns the server's normal representation.
const MARKDOWN_FIRST_ACCEPT = "text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,application/xml;q=0.8,image/avif;q=0.9,image/webp;q=0.9,image/apng;q=0.9,*/*;q=0.7";

async function extractViaHttp(
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
	options?: ExtractOptions,
	preferMarkdown = options?.mode !== "raw",
): Promise<HttpExtractedContent> {
	const state: { invoked: boolean; attempts?: ExtractionAttempt[] } = { invoked: false };
	const result = await extractHttpResource(url, timeoutMs, state, signal, options, preferMarkdown);
	return {
		...result,
		provider: result.provider === undefined ? (!result.error && state.invoked ? "http" : null) : result.provider,
		attempts: state.attempts ?? result.attempts ?? (state.invoked ? [
			result.error ? { provider: "http", outcome: "failed", error: "HTTP extraction failed" } : { provider: "http", outcome: "succeeded" },
		] : []),
	};
}

async function extractHttpResource(
	url: string,
	timeoutMs: number,
	state: { invoked: boolean; attempts?: ExtractionAttempt[] },
	signal: AbortSignal | undefined,
	options: ExtractOptions | undefined,
	preferMarkdown: boolean,
): Promise<HttpExtractedContent> {
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	let terminal = options?.mode !== "raw" && isPDF(url);

	const controller = new AbortController();
	const startedAt = Date.now();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const ssrf = loadSsrfConfig();
		const domainPolicy = loadFetchContentDomainPolicy();
		const redirects = resolveFetchContentRedirectPolicy(options?.redirects);
		const authProfile = options?.authFetchProfile;
		const requestInit: ProxiedRequestInit = {
			signal: controller.signal,
			__proxy: options?.proxy,
			headers: {
				"User-Agent": loadFetchContentUserAgent(),
				"Accept": preferMarkdown ? MARKDOWN_FIRST_ACCEPT : BROWSER_ACCEPT,
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		};
		const response = authProfile
			? await fetchAuthenticatedRemoteUrl(url, requestInit, { ssrf, domainPolicy, redirects, proxy: options?.proxy, ...(options?.lookup ? { lookup: options.lookup } : {}) }, authProfile)
			: await fetchRemoteUrl(
				url,
				requestInit,
				{
					allowRanges: ssrf.allowRanges,
					trustEnvProxy: ssrf.trustEnvProxy,
					domainPolicy,
					redirects,
					proxy: options?.proxy,
					...(options?.lookup ? { lookup: options.lookup } : {}),
				},
			);

		const discoveryOnly = options?.provider && options.provider !== "auto" && options.provider !== "http";
		if (!response.ok && options?.mode !== "raw") {
			const knownPDF = isPDF(url, response.headers.get("content-type") ?? "");
			terminal ||= knownPDF;
			state.invoked = !discoveryOnly && !knownPDF;
			await response.body?.cancel();
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}${knownPDF ? ". PDF web-provider fallback cannot preserve the validated bytes and size limit" : ""}`,
				status: response.status,
				...(knownPDF ? { terminal: true, attempts: [] } : {}),
			};
		}

		const contentLengthHeader = response.headers.get("content-length");
		const contentType = response.headers.get("content-type") || "";
		const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		const isPDFContent = isPDF(url, contentType);
		terminal ||= isPDFContent && options?.mode !== "raw";
		const pdfConfig = isPDFContent ? loadPDFConfig() : null;
		if (isPDFContent && pdfConfig && !pdfConfig.enabled) {
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: "", content: "", error: "PDF extraction is disabled by pdf.enabled", attempts: [], mimeType, status: response.status };
		}
		const maxResponseSize = (pdfConfig?.maxSizeMB ?? 5) * 1024 * 1024;
		if (contentLengthHeader) {
			const contentLength = Number.parseInt(contentLengthHeader, 10);
			if (Number.isFinite(contentLength) && contentLength > maxResponseSize) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: "",
					content: "",
					...(pdfConfig ? { attempts: [] } : {}),
					error: pdfConfig
						? pdfSizeLimitError(pdfConfig.maxSizeMB).message
						: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
				};
			}
		}

		if (options?.mode === "raw") {
			state.invoked = true;
			if (!isTextContentType(contentType)) {
				activityMonitor.logComplete(activityId, response.status);
				const hint = isPDFContent ? "; retry without mode for Markdown, or with mode \"answer\" and a prompt" : "";
				return { url, title: "", content: "", error: `Unsupported content type in raw mode: ${mimeType || "missing"}${hint}`, mimeType, status: response.status };
			}
			const text = await readTextResponseWithLimit(response, maxResponseSize);
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: extractTextTitle(text, url), content: text, error: null, mimeType, status: response.status };
		}

		if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
			const disabled = imageGateError();
			if (disabled) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: "", content: "", error: disabled, mimeType, status: response.status };
			}
			if (options?.rejectDirectImages) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: "", content: "", error: options.rejectDirectImages, mimeType, status: response.status };
			}
			if (discoveryOnly) {
				await response.body?.cancel();
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: "", content: "", error: null, attempts: [] };
			}
			state.invoked = true;
			try {
				const buffer = await readResponseBufferWithLimit(response, maxResponseSize, () => responseSizeLimitError(maxResponseSize));
				const { resizeImage } = await import("@earendil-works/pi-coding-agent");
				const resized = await resizeImage(new Uint8Array(buffer), mimeType, { maxWidth: 2000, maxHeight: 2000 });
				activityMonitor.logComplete(activityId, response.status);
				if (!resized) return { url, title: "", content: "", error: `Could not decode image: ${mimeType}`, mimeType, status: response.status };
				const title = new URL(response.url || url).pathname.split("/").pop() || url;
				return {
					url,
					title,
					content: `Image fetched (${resized.width}×${resized.height}, ${resized.mimeType})`,
					error: null,
					thumbnail: { data: resized.data, mimeType: resized.mimeType },
					mimeType: resized.mimeType,
					status: response.status,
				};
			} catch (err) {
				const message = errorMessage(err);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: message, mimeType, status: response.status };
			}
		}

		if (isPDFContent && pdfConfig) {
			try {
				const buffer = await readPDFResponseBuffer(response, pdfConfig.maxSizeMB);
				if (signal?.aborted) return abortedResult(url);
				const result = await extractPDFToMarkdown(buffer, url, { signal, lookup: options?.lookup });
				state.attempts = result.attempts.map(attempt => ({ provider: null, ...attempt }));
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: result.title,
					provider: null,
					extractionProvider: result.extractionProvider,
					attempts: state.attempts,
					content: options?.mode === "answer"
						? result.content
						: `PDF extracted and saved to: ${result.outputPath}\n\n${result.pages > 0 ? `Pages: ${result.pages}\n` : ""}Characters: ${result.chars}`,
					error: null,
				};
			} catch (err) {
				const attempts = getPDFExtractionAttempts(err).map(attempt => ({ provider: null, ...attempt }));
				state.attempts = attempts;
				let message: string;
				if (signal?.aborted || isAbortError(err)) message = "Aborted";
				else if (err instanceof PDFProcessingLimitError || isFatalExtractionError(err)) message = errorMessage(err);
				else {
					// URL-only web adapters cannot bind their re-download to these bytes
					// or enforce pdf.maxSizeMB, even where a PDF page cap is supported.
					const engine = attempts.at(-1)?.extractionProvider;
					const label = engine === "paddleocr" ? "PaddleOCR" : engine;
					const status = errorMessage(err).match(/\bHTTP (\d{3})\b/)?.[1];
					const diagnostic = label ? `: ${label}${status ? ` HTTP ${status}` : ""} extraction failed` : "";
					message = `PDF extraction failed${diagnostic}. Web-provider fallback cannot preserve the validated PDF bytes and pdf.maxSizeMB size limit`;
				}
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: message, attempts, terminal: true };
			}
		}

		if (discoveryOnly) {
			await response.body?.cancel();
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: "", content: "", error: null, attempts: [] };
		}

		state.invoked = true;
		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const text = await readTextResponseWithLimit(response, maxResponseSize);
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (isCloudflareChallenge(response, text, isHTML)) {
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: "", content: "", error: `HTTP ${response.status}: Blocked by Cloudflare challenge page`, status: response.status };
		}

		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			const title = extractTextTitle(text, url);
			if (mimeType !== "text/markdown" && mimeType !== "text/x-markdown") return { url, title, content: text, error: null };
			const declaredLinks = discoverDeclaredWebLinks(null, response.headers.get("link"), response.url || url);
			const markdown = { url, title, content: appendDeclaredWebLinks(text, declaredLinks), error: null, declaredLinks };
			if (!preferMarkdown || text.trim().length >= MIN_USEFUL_CONTENT) return markdown;
			// Short negotiated markdown is re-requested with the browser Accept header.
			// That response stays authoritative for policy/config rejection, not-found
			// status, cancellation, and any content it has. This markdown only fills a
			// recoverable empty response, marked incomplete with its status and error.
			const normal = await extractViaHttp(url, Math.max(1, timeoutMs - (Date.now() - startedAt)), signal, options, false);
			terminal ||= normal.terminal === true;
			state.attempts = normal.attempts;
			if (signal?.aborted || isNonRecoverableHttpError(normal.error) ||
				normal.status === 404 || normal.status === 410 || isAbortError(normal.error)) return normal;
			const normalHasBody = normal.content.trim() !== appendDeclaredWebLinks("", normal.declaredLinks ?? []).trim();
			if (normalHasBody || !markdown.content.trim()) return normal;
			return {
				...normal,
				...markdown,
				error: "Extracted content appears incomplete" + (normal.error ? `\nBrowser retry failed: ${normal.error}` : ""),
			};
		}

		const { parseHTML } = await import("linkedom");
		const { document } = parseHTML(text);
		const documentTitle = document.title?.trim() ?? "";
		const declaredLinks = discoverDeclaredWebLinks(
			// SAFETY: linkedom implements the DOM queries used for discovery.
			document as unknown as Document,
			response.headers.get("link"),
			response.url || url,
		);
		const { Readability } = await import("@mozilla/readability");
		// SAFETY: linkedom implements the DOM document interface used by Readability.
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			const rscResult = extractRSCContent(text);
			if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: rscResult.title,
					content: appendDeclaredWebLinks(rscResult.content, declaredLinks),
					error: null,
					declaredLinks,
				};
			}
			controller.signal.throwIfAborted();
			const defuddleResult = await extractWithDefuddle(text, response.url || url);
			controller.signal.throwIfAborted();
			if (defuddleResult && defuddleResult.content.length >= MIN_USEFUL_CONTENT) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: documentTitle || defuddleResult.title,
					content: appendDeclaredWebLinks(defuddleResult.content, declaredLinks),
					error: null,
					declaredLinks,
				};
			}

			activityMonitor.logComplete(activityId, response.status);
			const jsRendered = isLikelyJSRendered(text);
			const errorMsg = jsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";

			return {
				url,
				title: documentTitle,
				content: appendDeclaredWebLinks("", declaredLinks),
				error: errorMsg,
				declaredLinks,
			};
		}

		if (typeof article.content !== "string") {
			throw new Error("Readability returned invalid article content");
		}
		const markdown = (await getTurndown()).turndown(article.content);
		activityMonitor.logComplete(activityId, response.status);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			const rscResult = extractRSCContent(text);
			if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
				return {
					url,
					title: rscResult.title,
					content: appendDeclaredWebLinks(rscResult.content, declaredLinks),
					error: null,
					declaredLinks,
				};
			}
			controller.signal.throwIfAborted();
			const defuddleResult = await extractWithDefuddle(text, response.url || url);
			controller.signal.throwIfAborted();
			if (defuddleResult && defuddleResult.content.length >= MIN_USEFUL_CONTENT) {
				return {
					url,
					title: article.title || documentTitle || defuddleResult.title,
					content: appendDeclaredWebLinks(defuddleResult.content, declaredLinks),
					error: null,
					declaredLinks,
				};
			}
			return {
				url,
				title: article.title || documentTitle,
				content: appendDeclaredWebLinks(markdown, declaredLinks),
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
				declaredLinks,
			};
		}

		return {
			url,
			title: article.title || documentTitle,
			content: appendDeclaredWebLinks(markdown, declaredLinks),
			error: null,
			declaredLinks,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		if (isPDF(url) && options?.mode !== "raw" && !isFatalExtractionError(err)) {
			return { url, title: "", content: "", error: "PDF download failed. Web-provider fallback cannot preserve the validated PDF bytes and size limit", terminal: true, attempts: [] };
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
		// Imports and CPU-bound processing need not observe the fetch signal, and
		// can finish before an expired timer gets a turn. Guard every exit, with
		// caller cancellation taking precedence over the internal deadline.
		if (signal?.aborted) return abortedResult(url);
		if (controller.signal.aborted || Date.now() - startedAt >= timeoutMs) {
			// A PDF deadline cannot make URL-only web-provider fallback safe.
			return { url, title: "", content: "", error: "The operation was aborted.", ...(terminal ? { terminal: true } : {}) };
		}
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	const heading = extractHeadingTitle(text);
	if (heading) return heading;
	try {
		return new URL(url).pathname.split("/").pop() || url;
	} catch {
		return url;
	}
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	const results = await Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, options))));
	if (options?.mode === "raw") return results;
	// Inline data: URIs in extracted markdown would otherwise flow into tool
	// results and the fetch cache as opaque base64; typed thumbnail/frame image
	// blocks are deliberate outputs and are left untouched.
	return results.map((result, index) => {
		if (!result.content) return result;
		const sanitized = sanitizeInlineDataUris(result.content, `urls[${index}].content`);
		return sanitized.omissions.length > 0 ? { ...result, content: sanitized.text } : result;
	});
}

import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { CredentialResolutionError, hasCredentialSource, resolveCredential, redactCredential } from "./credential-source.ts";
import { fetchRemoteUrl, loadSsrfConfig, RemoteUrlPolicyError, type Lookup } from "./ssrf-protection.ts";
import { getWebSearchConfigPath } from "./utils.ts";
import { PDFProcessingLimitError } from "./pdf-errors.ts";

const DEFAULT_BASE_URL = "https://paddleocr.aistudio-app.com";
const DEFAULT_MODEL = "PaddleOCR-VL-1.6";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface PaddleOCROptions {
	maxPages: number;
	totalPages: number;
	signal?: AbortSignal;
	lookup?: Lookup;
	onInvocation?: () => void;
}

function config(): Record<string, unknown> {
	const path = getWebSearchConfigPath();
	if (!existsSync(path)) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" ? value as Record<string, unknown> : {};
	} catch {
		throw new Error(`Failed to parse ${path} for PaddleOCR`);
	}
}

export function isPaddleOCRAvailable(): boolean {
	return hasCredentialSource({ provider: "PaddleOCR", configuredValue: config().paddleocrApiKey, environmentValue: process.env.PADDLEOCR_API_KEY });
}

function settings() {
	const raw = config();
	const pdf = raw.pdf && typeof raw.pdf === "object" ? raw.pdf as Record<string, unknown> : {};
	const model = pdf.paddleocrModel ?? DEFAULT_MODEL;
	if (typeof model !== "string" || !model.trim()) throw new Error("Failed to parse pdf.paddleocrModel: expected a non-empty model ID");
	const timeoutMs = pdf.paddleocrTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
		throw new Error("Failed to parse pdf.paddleocrTimeoutMs: expected an integer from 1 through 300000");
	}
	const base = process.env.PADDLEOCR_BASE_URL ?? raw.paddleocrBaseUrl ?? DEFAULT_BASE_URL;
	const url = typeof base === "string" ? URL.parse(base) : null;
	if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("Failed to parse paddleocrBaseUrl: expected an absolute HTTP(S) service base without credentials, query, or fragment");
	}
	return { raw, model: model.trim(), timeoutMs, jobsUrl: `${url.href.replace(/\/+$/, "")}/api/v2/ocr/jobs` };
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let onAbort: () => void = () => undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([work, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function readText(response: Response, signal: AbortSignal): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("PaddleOCR returned an empty response");
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await abortable(reader.read(), signal);
			if (done) return text + decoder.decode();
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) throw new Error("PaddleOCR returned an oversized response");
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		// Cancellation is best-effort; never wait for an unresponsive remote stream's cleanup.
		void reader.cancel().catch(() => undefined);
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PaddleOCR returned a malformed response");
	return value as Record<string, unknown>;
}

function parseJson(text: string): Record<string, unknown> {
	try {
		return record(JSON.parse(text));
	} catch {
		throw new Error("PaddleOCR returned malformed JSON");
	}
}

function parsePages(text: string, limit: number): string {
	const pages: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const result = record(parseJson(line).result);
		if (!Array.isArray(result.layoutParsingResults) || !result.layoutParsingResults.length) throw new Error("PaddleOCR returned no page results");
		for (const value of result.layoutParsingResults) {
			if (pages.length >= limit) throw new Error("PaddleOCR returned pages outside the requested processing limit");
			const page = record(value);
			const markdown = record(page.markdown);
			if (typeof markdown.text !== "string") throw new Error("PaddleOCR returned malformed page Markdown");
			let content = markdown.text.replaceAll("\x00", "");
			if (markdown.images && typeof markdown.images === "object") {
				for (const [path, target] of Object.entries(markdown.images)) {
					const url = typeof target === "string" ? URL.parse(target) : null;
					if (url && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
						content = content.replaceAll(`](${path})`, `](${url.href})`);
					}
				}
			}
			pages.push(content);
		}
	}
	if (!pages.some(page => page.trim())) throw new Error("PaddleOCR returned no Markdown");
	if (pages.length !== limit) throw new Error("PaddleOCR returned incomplete page results");
	return pages.map((page, index) => `<!-- Page ${index + 1} -->\n\n${page}`).join("\n\n");
}

export async function extractPDFViaPaddleOCR(buffer: ArrayBuffer, options: PaddleOCROptions): Promise<{ markdown: string }> {
	options.signal?.throwIfAborted();
	const { raw, model, timeoutMs, jobsUrl } = settings();
	const deadline = new AbortController();
	const expiresAt = Date.now() + timeoutMs;
	const timer = setTimeout(() => deadline.abort(new Error("PaddleOCR extraction timed out")), timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
	const checkDeadline = () => {
		signal.throwIfAborted();
		if (Date.now() >= expiresAt) throw new Error("PaddleOCR extraction timed out");
	};
	let key: string | null = null;
	try {
		key = await abortable(resolveCredential({ provider: "PaddleOCR", configuredValue: raw.paddleocrApiKey, environmentValue: process.env.PADDLEOCR_API_KEY, signal }), signal);
		if (!key) throw new Error("PDF provider paddleocr requires paddleocrApiKey or PADDLEOCR_API_KEY");
		const ssrf = loadSsrfConfig();
		const guard = { allowRanges: ssrf.allowRanges, trustEnvProxy: ssrf.trustEnvProxy, ...(options.lookup ? { lookup: options.lookup } : {}) };
		const request = async (url: string, init: RequestInit, api: boolean): Promise<Response> => {
			checkDeadline();
			const response = await abortable(fetchRemoteUrl(url, { ...init, signal }, {
				...guard,
				...(api ? { redirects: "same-origin" as const } : {}),
				onRequest: () => { checkDeadline(); options.onInvocation?.(); },
			}), signal);
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				throw new Error(`PaddleOCR ${api ? "API" : "result download"} HTTP ${response.status}`);
			}
			return response;
		};
		const apiRequest = async (url: string, init: RequestInit = {}) => {
			const response = await request(url, { ...init, headers: { Authorization: `Bearer ${key}` } }, true);
			const payload = parseJson(await readText(response, signal));
			if (payload.code !== undefined && payload.code !== 0) throw new Error("PaddleOCR API rejected the request");
			return record(payload.data);
		};
		const limit = Math.min(options.maxPages, options.totalPages);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || buffer.byteLength > 50 * 1024 * 1024) {
			throw new PDFProcessingLimitError("PaddleOCR requires 1-1000 selected pages and a PDF no larger than 50 MB");
		}
		const form = new FormData();
		form.append("file", new Blob([buffer], { type: "application/pdf" }), "document.pdf");
		form.append("model", model);
		form.append("pageRanges", `1-${limit}`);
		form.append("optionalPayload", JSON.stringify({ useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false }));
		// Submit once only: retrying an ambiguous POST can create another billable job.
		const job = await apiRequest(jobsUrl, { method: "POST", body: form });
		if (typeof job.jobId !== "string" || !job.jobId.trim()) throw new Error("PaddleOCR returned no job ID");
		const pollUrl = `${jobsUrl}/${encodeURIComponent(job.jobId)}`;
		for (;;) {
			const status = await apiRequest(pollUrl);
			if (status.state === "done") {
				const results = record(status.resultUrl);
				if (typeof results.jsonUrl !== "string") throw new Error("PaddleOCR returned no JSONL result URL");
				const response = await request(results.jsonUrl, {}, false);
				const markdown = parsePages(await readText(response, signal), limit);
				checkDeadline();
				return { markdown };
			}
			if (status.state === "failed") throw new Error("PaddleOCR document parsing failed");
			if (status.state !== "pending" && status.state !== "running") throw new Error("PaddleOCR returned an unknown job state");
			await sleep(1500, undefined, { signal });
		}
	} catch (err) {
		if (options.signal?.aborted) throw options.signal.reason;
		if (err instanceof CredentialResolutionError || err instanceof PDFProcessingLimitError) throw err;
		// Do not propagate transport error causes or cached stacks containing request credentials.
		const message = redactCredential(err instanceof Error ? err.message : String(err), key);
		if (err instanceof RemoteUrlPolicyError) throw new RemoteUrlPolicyError(message);
		throw new Error(message);
	} finally {
		clearTimeout(timer);
	}
}

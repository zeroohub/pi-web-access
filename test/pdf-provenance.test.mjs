import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const extractorUrl = new URL("../pdf-extract.ts", import.meta.url).href;
const fixtureUrl = new URL("./pdf-fixture.mjs", import.meta.url).href;

function runExtraction({ config = {}, setup = "", body, pageCount = 1 } = {}) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^(PADDLEOCR_|DATALAB_|GEMINI_|GOOGLE_|CLOUDFLARE_|PDF_ENDPOINT_)/.test(key)) delete env[key];
	}
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import assert from "node:assert/strict";
			import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			import { makePdf } from ${JSON.stringify(fixtureUrl)};
			const home = await mkdtemp(join(tmpdir(), "pi-pdf-provenance-"));
			process.env.PI_CODING_AGENT_DIR = home;
			process.env.TMPDIR = home;
			await writeFile(join(home, "web-search.json"), JSON.stringify(${JSON.stringify(config)}));
			globalThis.fetch = async () => { throw new Error("Unexpected external request"); };
			const pdf = makePdf("Local provenance text", ${pageCount});
			const options = { outputDir: home, lookup: async () => [{ address: "93.184.216.34", family: 4 }] };
			${setup}
			const api = await import(${JSON.stringify(extractorUrl)});
			try {
				${body ?? `const result = await api.extractPDFToMarkdown(pdf, "https://example.com/report.pdf", options);
				assert.equal(result.content, await readFile(result.outputPath, "utf8"));
				assert.equal(result.chars, result.content.length);
				console.log(JSON.stringify(result));`}
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		`,
		env,
		encoding: "utf8",
		timeout: 20_000,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr || child.error?.message);
	return child.stdout.trim() ? JSON.parse(child.stdout.trim().split("\n").at(-1)) : undefined;
}

test("public PDF extraction identifies local unpdf and preserves saved Markdown and page limits", () => {
	const result = runExtraction({ config: { pdf: { provider: "unpdf", maxPages: 1 } }, pageCount: 2 });
	assert.equal(result.extractionProvider, "unpdf");
	assert.equal(result.pages, 2);
	assert.match(result.content, /Local provenance text/);
	assert.match(result.content, /Only first 1 of 2 pages extracted/);
});

const hostedSetup = `
	globalThis.fetch = async (url, init) => {
		const target = String(url);
		if (target === "http://127.0.0.1:9/parse") return Response.json({ markdown: "Endpoint text", pages: 1 });
		if (target.endsWith("/api/v2/ocr/jobs")) return Response.json({ data: { jobId: "ocr-1" } });
		if (target.endsWith("/api/v2/ocr/jobs/ocr-1")) return Response.json({ data: { state: "done", resultUrl: { jsonUrl: "https://results.example.com/document.jsonl" } } });
		if (target === "https://results.example.com/document.jsonl") return Response.json({ result: { layoutParsingResults: [{ markdown: { text: "PaddleOCR text" } }] } });
		if (target.endsWith("/files/upload")) return Response.json({ file_id: 7, upload_url: "https://storage.test/put/abc", reference: "datalab://file-7" });
		if (target.includes("/put/") || init.method === "DELETE") return new Response(null);
		if (target.endsWith("/confirm")) return Response.json({ file_id: 7, reference: "datalab://file-7" });
		if (target.endsWith("/convert")) return Response.json({ status: "complete", markdown: "Datalab text", page_count: 1 });
		if (target.includes("generateContent")) return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "<!-- Page 1 -->\\nGemini text" }] } }] });
		throw new Error("Unexpected external request: " + target);
	};
`;

const allHostedConfig = {
	paddleocrApiKey: "synthetic-paddle-key",
	datalabApiKey: "synthetic-datalab-key",
	geminiApiKey: "synthetic-gemini-key",
};

test("public PDF extraction reports each actual hosted engine rather than auto configuration", () => {
	for (const [expected, config] of [
		["endpoint", { ...allHostedConfig, pdf: { endpointUrl: "http://127.0.0.1:9/parse" } }],
		["paddleocr", allHostedConfig],
		["datalab", { datalabApiKey: "synthetic-datalab-key", geminiApiKey: "synthetic-gemini-key" }],
		["gemini", { geminiApiKey: "synthetic-gemini-key" }],
	]) {
		const result = runExtraction({ config, setup: hostedSetup });
		assert.equal(result.extractionProvider, expected);
		assert.equal(result.pages, 1);
	}
});

test("public PDF fallback reports only invoked engines in order with safe failure text", () => {
	const result = runExtraction({
		config: { ...allHostedConfig, pdf: { endpointUrl: "http://127.0.0.1:9/parse" } },
		setup: `globalThis.fetch = async () => { throw new Error("Authorization: Bearer synthetic-private-token at /private/config"); };`,
	});
	assert.equal(result.extractionProvider, "unpdf");
	assert.deepEqual(result.attempts, [
		{ extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed" },
		{ extractionProvider: "paddleocr", outcome: "failed", error: "PDF paddleocr extraction failed" },
		{ extractionProvider: "datalab", outcome: "failed", error: "PDF datalab extraction failed" },
		{ extractionProvider: "gemini", outcome: "failed", error: "PDF gemini extraction failed" },
		{ extractionProvider: "unpdf", outcome: "succeeded" },
	]);
	assert.doesNotMatch(JSON.stringify(result), /synthetic-private-token|Authorization|\/private\/config/);
	const skipped = runExtraction({ config: { pdf: { provider: "datalab" } } });
	assert.deepEqual(skipped.attempts, [{ extractionProvider: "unpdf", outcome: "succeeded" }]);
});

test("PDF endpoint safety preflight is terminal without an attempt or a later upload", () => {
	for (const provider of ["auto", "endpoint"]) {
		runExtraction({
			config: { geminiApiKey: "synthetic-gemini-key", pdf: { provider, endpointUrl: "http://10.0.0.2/parse" } },
			setup: hostedSetup + `
				const hosted = globalThis.fetch;
				const calls = [];
				globalThis.fetch = async (...args) => { calls.push(String(args[0])); return hosted(...args); };
			`,
			body: `
				await assert.rejects(api.extractPDFToMarkdown(pdf, "https://example.com/report.pdf", options), error => {
					assert.match(error.message, /Blocked internal address/);
					assert.deepEqual(api.getPDFExtractionAttempts(error), []);
					return true;
				});
				assert.deepEqual(calls, []);
			`,
		});
	}
});

test("PDF guard rejection after endpoint submission preserves the actual attempt and prevents fallback", () => {
	runExtraction({
		config: { ...allHostedConfig, pdf: { endpointUrl: "http://93.184.216.34/parse" } },
		setup: `
			const calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				return new Response(null, { status: 302, headers: { location: "http://10.0.0.2/private" } });
			};
		`,
		body: `
			await assert.rejects(api.extractPDFToMarkdown(pdf, "https://example.com/report.pdf", options), error => {
				assert.match(error.message, /Blocked internal address/);
				assert.deepEqual(api.getPDFExtractionAttempts(error), [
					{ extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed" },
				]);
				return true;
			});
			assert.deepEqual(calls, ["http://93.184.216.34/parse"]);
		`,
	});
});

test("PaddleOCR safety preflight is terminal and preserves earlier actual PDF attempts only", () => {
	for (const endpoint of [false, true]) {
		runExtraction({
			config: { ...allHostedConfig, paddleocrBaseUrl: "http://10.0.0.2", pdf: endpoint ? { endpointUrl: "http://127.0.0.1:9/parse" } : {} },
			setup: `const calls = []; globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("private endpoint failure"); };`,
			body: `
				await assert.rejects(api.extractPDFToMarkdown(pdf, "https://example.com/report.pdf", options), error => {
					assert.match(error.message, /Blocked internal address/);
					assert.deepEqual(api.getPDFExtractionAttempts(error), ${endpoint
						? '[{ extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed" }]'
						: '[]'});
					return true;
				});
				assert.deepEqual(calls, ${endpoint ? '["http://127.0.0.1:9/parse"]' : '[]'});
			`,
		});
	}
});

for (const stage of ["redirect", "result"]) {
	test(`PaddleOCR ${stage} safety refusal stays terminal after actual submission`, () => {
		runExtraction({
			config: allHostedConfig,
			setup: `
				const calls = [];
				globalThis.fetch = async (url) => {
					const target = String(url);
					calls.push(target);
					if (${JSON.stringify(stage)} === "redirect") return new Response(null, { status: 302, headers: { location: "https://other.example/job" } });
					if (target.endsWith("/api/v2/ocr/jobs")) return Response.json({ data: { jobId: "ocr-1" } });
					return Response.json({ data: { state: "done", resultUrl: { jsonUrl: "http://10.0.0.2/private.jsonl" } } });
				};
			`,
			body: `
				await assert.rejects(api.extractPDFToMarkdown(pdf, "https://example.com/report.pdf", options), error => {
					assert.match(error.message, /Blocked internal address|Refused cross-origin redirect/);
					assert.deepEqual(api.getPDFExtractionAttempts(error), [
						{ extractionProvider: "paddleocr", outcome: "failed", error: "PDF paddleocr extraction failed" },
					]);
					assert.doesNotMatch(error.message, /synthetic-paddle-key/);
					return true;
				});
				assert.deepEqual(calls, ${stage === "redirect"
					? '["https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"]'
					: '["https://paddleocr.aistudio-app.com/api/v2/ocr/jobs", "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs/ocr-1"]'});
			`,
		});
	});
}

test("PDF guard configuration rejection is terminal before any extraction request", () => {
	for (const ssrf of [{ allowRanges: ["invalid-cidr"] }, { trustEnvProxy: "invalid" }, []]) {
		runExtraction({
			config: { ...allHostedConfig, ssrf, pdf: { endpointUrl: "http://127.0.0.1:9/parse" } },
			body: `
				await assert.rejects(api.extractPDFToMarkdown(pdf, "https://example.com/report.pdf", options), error => {
					assert.match(error.message, /ssrf/);
					assert.deepEqual(api.getPDFExtractionAttempts(error), []);
					return true;
				});
			`,
		});
	}
});

test("terminal PDF errors retain their class and expose safe prior attempts as independent snapshots", () => {
	runExtraction({
		config: { pdf: { endpointUrl: "http://127.0.0.1:9/parse" } },
		setup: `globalThis.fetch = async () => { throw new Error("private-transport-secret"); };`,
		body: `
			await assert.rejects(
				api.extractPDFToMarkdown(new Uint8Array([1, 2, 3]).buffer, "https://example.com/report.pdf", options),
				error => {
					assert.equal(error.name, "InvalidPDFException");
					const expected = [
						{ extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed" },
						{ extractionProvider: "unpdf", outcome: "failed", error: "PDF unpdf extraction failed" },
					];
					const attempts = api.getPDFExtractionAttempts(error);
					assert.deepEqual(attempts, expected);
					attempts[0].error = "changed";
					attempts.pop();
					assert.deepEqual(api.getPDFExtractionAttempts(error), expected);
					assert.equal(Object.hasOwn(error, "attempts"), false);
					assert.deepEqual(api.getPDFExtractionAttempts(new Error("unrelated")), []);
					assert.deepEqual(api.getPDFExtractionAttempts("primitive"), []);
					return true;
				},
			);
		`,
	});
});

test("PDF processing-limit preflight is typed and terminal with no extraction attempt or upload", () => {
	for (const provider of ["paddleocr", "auto"]) {
		runExtraction({
			config: { paddleocrApiKey: "synthetic-paddle-key", pdf: { provider, maxPages: 1001 } },
			pageCount: 1001,
			setup: `let uploads = 0; globalThis.fetch = async () => { uploads++; throw new Error("Must not upload"); };`,
			body: `
				await assert.rejects(api.extractPDFToMarkdown(pdf, "https://example.com/report.pdf", options), error => {
					assert.ok(error instanceof api.PDFProcessingLimitError);
					assert.equal(error.message, "PaddleOCR requires 1-1000 selected pages and a PDF no larger than 50 MB");
					assert.deepEqual(api.getPDFExtractionAttempts(error), []);
					return true;
				});
				assert.equal(uploads, 0);
			`,
		});
	}
});

test("hosted PDF fallback identifies the succeeding engine and omits unavailable engines", () => {
	const result = runExtraction({
		config: { datalabApiKey: "synthetic-datalab-key", geminiApiKey: "synthetic-gemini-key" },
		setup: hostedSetup + `
			const hosted = globalThis.fetch;
			globalThis.fetch = async (url, init) => String(url).endsWith("/convert")
				? new Response("private-remote-error", { status: 503 })
				: hosted(url, init);
		`,
	});
	assert.equal(result.extractionProvider, "gemini");
	assert.deepEqual(result.attempts, [
		{ extractionProvider: "datalab", outcome: "failed", error: "PDF datalab extraction failed" },
		{ extractionProvider: "gemini", outcome: "succeeded" },
	]);
});

test("PDF credential/configuration and local page-count preflight errors do not invent attempts", () => {
	for (const [config, pageCount, expected] of [
		[{ paddleocrApiKey: "$MISSING_PDF_TEST_CREDENTIAL", pdf: { provider: "paddleocr", maxPages: 1001 } }, 1001, "credential"],
		[{ paddleocrApiKey: "synthetic-paddle-key", pdf: { provider: "paddleocr", paddleocrTimeoutMs: 0 } }, 1, "configuration"],
		[{ pdf: { provider: "paddleocr" } }, 1, "unavailable"],
		[{ paddleocrApiKey: "synthetic-paddle-key", pdf: { provider: "paddleocr" } }, 1, "page-count"],
	]) {
		runExtraction({
			config,
			pageCount,
			setup: `
				delete process.env.MISSING_PDF_TEST_CREDENTIAL;
				let uploads = 0;
				globalThis.fetch = async () => { uploads++; throw new Error("Must not upload"); };
			`,
			body: `
				const { CredentialResolutionError } = await import(${JSON.stringify(new URL("../credential-source.ts", import.meta.url).href)});
				await assert.rejects(api.extractPDFToMarkdown(
					${expected === "page-count" ? "new Uint8Array([1, 2, 3]).buffer" : "pdf"},
					"https://example.com/report.pdf", options), error => {
					${expected === "credential" ? `assert.ok(error instanceof CredentialResolutionError); assert.equal(error.category, "environment-empty");` : ""}
					${expected === "configuration" ? `assert.match(error.message, /^Failed to parse pdf.paddleocrTimeoutMs/);` : ""}
					${expected === "unavailable" ? `assert.match(error.message, /requires paddleocrApiKey/);` : ""}
					${expected === "page-count" ? `assert.equal(error.name, "InvalidPDFException");` : ""}
					assert.deepEqual(api.getPDFExtractionAttempts(error), []);
					return true;
				});
				assert.equal(uploads, 0);
			`,
		});
	}
});

test("PDF fatal credential errors preserve prior failed extraction history without exposing credential sources", () => {
	runExtraction({
		config: { paddleocrApiKey: "$MISSING_PDF_TEST_CREDENTIAL", pdf: { endpointUrl: "http://127.0.0.1:9/parse" } },
		setup: `delete process.env.MISSING_PDF_TEST_CREDENTIAL; globalThis.fetch = async () => { throw new Error("private endpoint failure"); };`,
		body: `
			const { CredentialResolutionError } = await import(${JSON.stringify(new URL("../credential-source.ts", import.meta.url).href)});
			await assert.rejects(api.extractPDFToMarkdown(pdf, "https://example.com/report.pdf", options), error => {
				assert.ok(error instanceof CredentialResolutionError);
				assert.deepEqual(api.getPDFExtractionAttempts(error), [
					{ extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed" },
				]);
				return true;
			});
		`,
	});
});

test("PDF cancellation keeps frozen caller error identity and distinguishes invocation from preflight", () => {
	for (const preAborted of [true, false]) {
		runExtraction({
			config: { pdf: { endpointUrl: "http://127.0.0.1:9/parse" } },
			setup: `
				const controller = new AbortController();
				const reason = Object.freeze(new Error("Caller stopped PDF extraction"));
				${preAborted ? "controller.abort(reason);" : ""}
				globalThis.fetch = async () => { controller.abort(reason); throw reason; };
			`,
			body: `
				await assert.rejects(api.extractPDFToMarkdown(pdf, "https://example.com/report.pdf", { ...options, signal: controller.signal }), error => {
					assert.equal(error, reason);
					assert.deepEqual(api.getPDFExtractionAttempts(error), ${preAborted ? "[]" : `[{ extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed" }]`});
					return true;
				});
			`,
		});
	}
});

test("pinned PaddleOCR failure stays terminal and reports only its actual failed attempt", () => {
	runExtraction({
		config: { ...allHostedConfig, pdf: { provider: "paddleocr" } },
		setup: `let uploads = 0; globalThis.fetch = async () => { uploads++; return new Response("private service error", { status: 503 }); };`,
		body: `
			await assert.rejects(api.extractPDFToMarkdown(pdf, "https://example.com/report.pdf", options), error => {
				assert.match(error.message, /HTTP 503/);
				assert.deepEqual(api.getPDFExtractionAttempts(error), [
					{ extractionProvider: "paddleocr", outcome: "failed", error: "PDF paddleocr extraction failed" },
				]);
				return true;
			});
			assert.equal(uploads, 1);
		`,
	});
});

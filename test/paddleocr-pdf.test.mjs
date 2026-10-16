import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const pdfUrl = new URL("../pdf-extract.ts", import.meta.url).href;
const fixtureUrl = new URL("./pdf-fixture.mjs", import.meta.url).href;
const extractUrl = new URL("../extract.ts", import.meta.url).href;

function runExtraction({ config = {}, setup = "", options = "{}", body = "", pageCount = 1 } = {}) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^(PADDLEOCR_|DATALAB_|GEMINI_|GOOGLE_|CLOUDFLARE_|PDF_ENDPOINT_)/.test(key)) delete env[key];
	}
	const script = `
		import assert from "node:assert/strict";
		import {mkdtemp, writeFile, readFile, rm} from "node:fs/promises";
		import {tmpdir} from "node:os";
		import {join} from "node:path";
		import {makePdf} from ${JSON.stringify(fixtureUrl)};
		const home = await mkdtemp(join(tmpdir(), "pi-paddleocr-test-"));
		process.env.PI_CODING_AGENT_DIR = home;
		process.env.TMPDIR = home;
		await writeFile(join(home, "web-search.json"), JSON.stringify(${JSON.stringify(config)}));
		const calls = [];
		const pdf = makePdf("Local PDF fallback", ${pageCount});
		const lookup = async () => [{address: "93.184.216.34", family: 4}];
		const json = value => Response.json(value);
		${setup}
		const {extractPDFToMarkdown} = await import(${JSON.stringify(pdfUrl)});
		try {
			${body || `const result = await extractPDFToMarkdown(pdf, "https://example.com/report.pdf", {outputDir: home, lookup, ...${options}});
			assert.equal(await readFile(result.outputPath, "utf8"), result.content);
			console.log(JSON.stringify({result, calls}));`}
		} finally { await rm(home, {recursive: true, force: true}); }
	`;
	const child = spawnSync(process.execPath, ["--input-type=module"], { input: script, env, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
	assert.equal(child.status, 0, child.stderr || child.error?.message);
	return child.stdout.trim() ? JSON.parse(child.stdout.trim().split("\n").at(-1)) : undefined;
}

const configured = { paddleocrApiKey: "synthetic-paddle-key", pdf: { provider: "paddleocr" } };
const success = `
	globalThis.fetch = async (url, init) => {
		const target = String(url);
		calls.push({url: target, method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization")});
		if (init.method === "POST") {
			assert.ok(init.body instanceof FormData);
			assert.deepEqual(new Uint8Array(await init.body.get("file").arrayBuffer()), new Uint8Array(pdf));
			assert.equal(init.body.get("model"), "PaddleOCR-VL-1.6");
			assert.equal(init.body.get("pageRanges"), "1-1");
			assert.equal(init.body.get("fileUrl"), null);
			return json({code: 0, data: {jobId: "job-1"}});
		}
		if (target.endsWith("/job-1")) return json({code: 0, data: {state: "done", resultUrl: {jsonUrl: "https://results.example.com/document.jsonl"}}});
		assert.equal(target, "https://results.example.com/document.jsonl");
		return new Response(JSON.stringify({result: {layoutParsingResults: [{markdown: {text: "# OCR report\\n\\n| Item | Value |\\n| --- | --- |\\n| Total | 42 |\\n\\n$x^2$", images: {}}}]}}));
	};
`;

test("PDF extraction uploads bytes to PaddleOCR and saves structured Markdown without leaking its credential", () => {
	const {result, calls} = runExtraction({config: configured, setup: success});
	assert.match(result.content, /# OCR report/);
	assert.match(result.content, /\| Total \| 42 \|/);
	assert.match(result.content, /\$x\^2\$/);
	assert.match(result.content, /<!-- Page 1 -->/);
	assert.equal(calls[0].url, "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs");
	assert.equal(calls[0].auth, "Bearer synthetic-paddle-key");
	assert.equal(calls[1].auth, "Bearer synthetic-paddle-key");
	assert.equal(calls[2].auth, null);
});


test("PDF processing selects only capped pages and reports source-document truncation", () => {
	const {result} = runExtraction({config: {...configured, pdf: {provider: "paddleocr", maxPages: 1}}, pageCount: 3, setup: success});
	assert.equal(result.pages, 3);
	assert.match(result.content, /Only first 1 of 3 pages extracted/);
});

test("PaddleOCR is skipped without credentials and explicit selection reports missing configuration", () => {
	const {result, calls} = runExtraction({setup: `globalThis.fetch = async () => {throw new Error("Unexpected remote request");};`});
	assert.match(result.content, /Local PDF fallback/);
	assert.deepEqual(calls, []);
	runExtraction({config: {pdf: {provider: "paddleocr"}}, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {outputDir: home, lookup}), /requires paddleocrApiKey/);`});
});

for (const provider of ["paddleocr", "auto"]) {
	test(`PaddleOCR failure is strict when pinned and falls back when automatic: ${provider}`, () => {
		const body = provider === "paddleocr"
			? `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {outputDir: home, lookup}), /HTTP 503/); assert.equal(calls.length, 1);`
			: `const result = await extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {outputDir: home, lookup}); assert.match(result.content, /Local PDF fallback/); assert.equal(calls.length, 1);`;
		runExtraction({config: {...configured, pdf: {provider}}, setup: `globalThis.fetch = async () => {calls.push("submit"); return new Response("unavailable", {status: 503});};`, body});
	});
}

test("PaddleOCR never retries an ambiguously failed job submission", () => {
	runExtraction({config: configured, setup: `globalThis.fetch = async () => {calls.push("submit"); throw new Error("Connection reset after upload");};`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), /Connection reset/); assert.deepEqual(calls, ["submit"]);`});
});

test("PaddleOCR honors configurable model IDs and gateway base paths", () => {
	const {calls} = runExtraction({config: {...configured, paddleocrBaseUrl: "https://gateway.example.com/paddle/", pdf: {provider: "paddleocr", paddleocrModel: "custom-ocr"}}, setup: success.replace('"PaddleOCR-VL-1.6"', '"custom-ocr"')});
	assert.equal(calls[0].url, "https://gateway.example.com/paddle/api/v2/ocr/jobs");
});

for (const [field, value] of [["paddleocrTimeoutMs", 0], ["paddleocrTimeoutMs", 300001], ["paddleocrModel", ""]]) {
	test(`PaddleOCR rejects invalid ${field} before any upload, even in auto`, () => {
		runExtraction({config: {...configured, pdf: {provider: "auto", [field]: value}}, setup: `globalThis.fetch = async () => {throw new Error("Unexpected upload");};`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), /Failed to parse pdf\\.${field}/);`});
	});
}

test("PaddleOCR credential-source errors fail closed instead of using another PDF provider", () => {
	runExtraction({config: {paddleocrApiKey: "$MISSING_PADDLEOCR_SECRET", pdf: {provider: "auto"}}, setup: `delete process.env.MISSING_PADDLEOCR_SECRET; globalThis.fetch = async () => {throw new Error("Unexpected upload");};`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), /PaddleOCR credential resolution failed: environment-empty/);`});
});

test("PaddleOCR errors redact its resolved credential", () => {
	runExtraction({config: configured, setup: `globalThis.fetch = async () => {const error = new Error("Rejected synthetic-paddle-key", {cause: new Error("synthetic-paddle-key")}); void error.stack; throw error;};`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), error => {assert.doesNotMatch(error.message + error.stack + error.cause, /synthetic-paddle-key/); return /Rejected/.test(error.message);});`});
});

test("PaddleOCR rejects private result URLs before a download", () => {
	runExtraction({config: configured, setup: success.replace("https://results.example.com/document.jsonl", "http://127.0.0.1/result"), body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), /Blocked internal/); assert.equal(calls.length, 2);`});
});

test("PaddleOCR refuses cross-origin API redirects before credentials or PDF bytes can leave the configured service", () => {
	runExtraction({config: configured, setup: `globalThis.fetch = async () => {calls.push("submit"); return new Response(null, {status: 307, headers: {location: "https://attacker.example.com/jobs"}});};`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), /cross-origin redirect/); assert.deepEqual(calls, ["submit"]);`});
});

test("PaddleOCR shares its deadline with result-body reading and cancels stalled downloads", () => {
	runExtraction({config: {...configured, pdf: {provider: "paddleocr", paddleocrTimeoutMs: 40}}, setup: `let cancelled = false; globalThis.fetch = async (url, init) => {
		if (init.method === "POST") return json({data: {jobId: "j"}});
		if (String(url).endsWith("/j")) return json({data: {state: "done", resultUrl: {jsonUrl: "https://results.example.com/stalled"}}});
		return new Response(new ReadableStream({cancel() {cancelled = true;}}));
	};`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), /timed out/); assert.ok(cancelled);`});
});

test("PaddleOCR cancels oversized result streams", () => {
	runExtraction({config: configured, setup: `let cancelled = false; globalThis.fetch = async (url, init) => {
		if (init.method === "POST") return json({data: {jobId: "j"}});
		if (String(url).endsWith("/j")) return json({data: {state: "done", resultUrl: {jsonUrl: "https://results.example.com/huge"}}});
		return new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(17 * 1024 * 1024));}, cancel() {cancelled = true;}}));
	};`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), /oversized response/); assert.ok(cancelled);`});
});


for (const [label, payload, expected] of [
	["failed", {state: "failed", errorMsg: "synthetic-paddle-key"}, "document parsing failed"],
	["unknown", {state: "mystery"}, "unknown job state"],
	["missing result URL", {state: "done", resultUrl: {}}, "no JSONL result URL"],
]) {
	test(`PaddleOCR reports ${label} without leaking service-provided secrets`, () => {
		runExtraction({config: configured, setup: `globalThis.fetch = async (url, init) => init.method === "POST" ? json({data: {jobId: "j"}}) : json({data: ${JSON.stringify(payload)}});`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), error => {assert.doesNotMatch(error.message, /synthetic-paddle-key/); return error.message.includes(${JSON.stringify(expected)});});`});
	});
}

for (const [label, text, expected] of [
	["non-JSON", "not json", "malformed JSON"],
	["empty", "", "no Markdown"],
	["empty Markdown", JSON.stringify({result: {layoutParsingResults: [{markdown: {text: "\u0000"}}]}}), "no Markdown"],
	["too many pages", JSON.stringify({result: {layoutParsingResults: [{markdown: {text: "One"}}, {markdown: {text: "Two"}}]}}), "processing limit"],
]) {
	test(`PaddleOCR rejects ${label} results instead of returning misleading success`, () => {
		runExtraction({config: configured, setup: `globalThis.fetch = async (url, init) => {
			if (init.method === "POST") return json({data: {jobId: "j"}});
			if (String(url).endsWith("/j")) return json({data: {state: "done", resultUrl: {jsonUrl: "https://results.example.com/file"}}});
			return new Response(${JSON.stringify(text)});
		};`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), error => error.message.includes(${JSON.stringify(expected)}));`});
	});
}

test("PaddleOCR caller cancellation interrupts polling and never falls back", () => {
	runExtraction({config: {...configured, pdf: {provider: "auto"}}, setup: `const controller = new AbortController(); globalThis.fetch = async (url, init) => {
		calls.push(String(url));
		if (init.method === "POST") return json({data: {jobId: "j"}});
		controller.abort(new Error("User stopped OCR"));
		return json({data: {state: "pending"}});
	};`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup, signal: controller.signal}), /User stopped OCR/); assert.equal(calls.length, 2);`});
});

test("PaddleOCR assembles multiple JSONL pages and preserves image references without downloading images", () => {
	const {result, calls} = runExtraction({config: configured, pageCount: 2, setup: `globalThis.fetch = async (url, init) => {
		calls.push(String(url));
		if (init.method === "POST") {assert.equal(init.body.get("pageRanges"), "1-2"); return json({data: {jobId: "j"}});}
		if (String(url).endsWith("/j")) return json({data: {state: "done", resultUrl: {jsonUrl: "https://results.example.com/file"}}});
		return new Response([
			JSON.stringify({result: {layoutParsingResults: [{markdown: {text: "First ![Chart](images/chart.png)", images: {"images/chart.png": "https://images.example.com/chart.png"}}}]}}),
			JSON.stringify({result: {layoutParsingResults: [{markdown: {text: "Second"}}]}})
		].join("\\n"));
	};`});
	assert.equal(result.pages, 2);
	assert.match(result.content, /<!-- Page 1 -->[\s\S]*First[\s\S]*<!-- Page 2 -->[\s\S]*Second/);
	assert.match(result.content, /!\[Chart\]\(https:\/\/images.example.com\/chart.png\)/);
	assert.equal(calls.length, 3);
});

test("fetch_content's public extraction boundary converts PDF responses through PaddleOCR", () => {
	runExtraction({config: configured, setup: success + `
		const remote = globalThis.fetch;
		globalThis.fetch = async (url, init) => String(url) === "https://example.com/report.pdf"
			? new Response(pdf, {headers: {"content-type": "application/pdf"}})
			: remote(url, init);
	`, body: `
		const {extractContent} = await import(${JSON.stringify(extractUrl)});
		const result = await extractContent("https://example.com/report.pdf", undefined, {lookup});
		assert.equal(result.error, null);
		const path = result.content.split("\\n")[0].replace("PDF extracted and saved to: ", "");
		assert.match(await readFile(path, "utf8"), /OCR report/);
	`});
});

test("PaddleOCR progresses through pending and running to done", () => {
	const {result} = runExtraction({config: configured, setup: `let polls = 0; ${success}
		const finish = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			if (String(url).endsWith("/job-1") && polls++ < 2) return json({data: {state: polls === 1 ? "pending" : "running"}});
			return finish(url, init);
		};`});
	assert.match(result.content, /OCR report/);
});


test("explicit PaddleOCR failures stop public fetch routing instead of invoking page extractors", () => {
	runExtraction({config: {...configured, tavilyApiKey: "synthetic-tavily", fetchRouting: {providers: ["tavily"], allowRemoteHostedProviders: true}}, setup: `
		globalThis.fetch = async (url, init) => {
			const target = String(url); calls.push(target);
			if (target === "https://example.com/report.pdf") return new Response(pdf, {headers: {"content-type": "application/pdf"}});
			if (target.includes("paddleocr")) return new Response("unavailable", {status: 503});
			return json({results: [{url: "https://example.com/report.pdf", raw_content: "Unexpected Tavily fallback".repeat(50)}]});
		};
	`, body: `
		const {extractContent} = await import(${JSON.stringify(extractUrl)});
		const result = await extractContent("https://example.com/report.pdf", undefined, {lookup});
		assert.match(result.error ?? "", /PaddleOCR.*HTTP 503/);
		assert.equal(calls.length, 2);
	`});
});


test("automatic PDF extraction prefers a configured endpoint before PaddleOCR", () => {
	const {result} = runExtraction({config: {...configured, pdf: {provider: "auto", endpointUrl: "http://127.0.0.1:9/parse"}}, setup: `globalThis.fetch = async url => {assert.equal(String(url), "http://127.0.0.1:9/parse"); return json({markdown: "Endpoint wins", pages: 1});};`});
	assert.match(result.content, /Endpoint wins/);
});

test("automatic PDF extraction prefers PaddleOCR before configured Datalab and Gemini", () => {
	const {result} = runExtraction({config: {...configured, datalabApiKey: "synthetic-datalab", geminiApiKey: "synthetic-gemini", pdf: {provider: "auto"}}, setup: success});
	assert.match(result.content, /OCR report/);
});

test("automatic PDF extraction continues from an endpoint failure into PaddleOCR", () => {
	const {result} = runExtraction({config: {...configured, pdf: {provider: "auto", endpointUrl: "http://127.0.0.1:9/parse"}}, setup: success + `
		const paddle = globalThis.fetch;
		globalThis.fetch = async (url, init) => String(url).includes("127.0.0.1") ? new Response("down", {status: 503}) : paddle(url, init);
	`});
	assert.match(result.content, /OCR report/);
});

test("automatic PDF extraction continues from PaddleOCR failure into Datalab", () => {
	const {result} = runExtraction({config: {...configured, datalabApiKey: "synthetic-datalab", pdf: {provider: "auto"}}, setup: `
		globalThis.fetch = async (url, init) => {
			const target = String(url);
			if (target.includes("paddleocr")) return new Response("down", {status: 503});
			if (target.endsWith("/files/upload")) return json({file_id: 7, upload_url: "https://storage.test/put/abc", reference: "datalab://file-7"});
			if (target.includes("/put/") || init.method === "DELETE") return new Response(null);
			if (target.endsWith("/confirm")) return json({file_id: 7, reference: "datalab://file-7"});
			if (target.endsWith("/convert")) return json({status: "complete", markdown: "Datalab fallback", page_count: 1});
			throw new Error("Unexpected request");
		};
	`});
	assert.match(result.content, /Datalab fallback/);
});

test("PaddleOCR supports named environment credentials and preserves environment-over-literal precedence", () => {
	const {result} = runExtraction({config: {...configured, paddleocrApiKey: "$SCOPED_OCR_KEY"}, setup: `process.env.SCOPED_OCR_KEY = "synthetic-paddle-key";` + success});
	assert.match(result.content, /OCR report/);
	const overridden = runExtraction({config: {...configured, paddleocrApiKey: "ignored-literal"}, setup: `process.env.PADDLEOCR_API_KEY = "synthetic-paddle-key";` + success});
	assert.match(overridden.result.content, /OCR report/);
});

test("PaddleOCR API and result redirects retain network validation without forwarding authentication to storage", () => {
	const {result, calls} = runExtraction({config: configured, setup: success + `
		const finish = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			if (String(url) === "https://results.example.com/document.jsonl") {
				assert.equal(new Headers(init.headers).get("authorization"), null);
				return new Response(null, {status: 302, headers: {location: "https://storage.example.com/redirected"}});
			}
			if (String(url).includes("storage.example.com")) {
				assert.equal(new Headers(init.headers).get("authorization"), null);
				return finish("https://results.example.com/document.jsonl", init);
			}
			return finish(url, init);
		};
	`});
	assert.match(result.content, /OCR report/);
	assert.equal(calls.at(-1).auth, null);
});

test("PaddleOCR rejects an excessive processing-page request before submission", () => {
	runExtraction({config: {...configured, pdf: {provider: "paddleocr", maxPages: 1001}}, pageCount: 1001, setup: `globalThis.fetch = async () => {throw new Error("Must not submit");};`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), /1-1000 selected pages/);`});
});


test("PaddleOCR preserves cancellation before PDF preflight instead of parsing or uploading", () => {
	runExtraction({config: configured, body: `const controller = new AbortController(); controller.abort(new Error("Caller cancelled before extraction")); await assert.rejects(extractPDFToMarkdown(new Uint8Array([1,2,3]).buffer, "https://example.com/a.pdf", {lookup, signal: controller.signal}), /Caller cancelled before extraction/);`});
});


test("PaddleOCR checks the shared elapsed deadline before polling, even before a timer callback runs", () => {
	runExtraction({config: configured, setup: success + `
		const now = Date.now; let elapsed = false;
		Date.now = () => now() + (elapsed ? 301000 : 0);
		const submit = globalThis.fetch;
		globalThis.fetch = async (url, init) => {const result = await submit(url, init); if (init.method === "POST") elapsed = true; return result;};
	`, body: `await assert.rejects(extractPDFToMarkdown(pdf, "https://example.com/a.pdf", {lookup}), /timed out/); assert.equal(calls.length, 1);`});
});

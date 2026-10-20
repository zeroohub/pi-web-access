import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Value } from "typebox/value";

const coreUrl = new URL("../web-tool-core.ts", import.meta.url).href;
const indexUrl = new URL("../index.ts", import.meta.url).href;
const mcpUrl = new URL("../mcp-server.ts", import.meta.url).href;
const fixtureUrl = new URL("./pdf-fixture.mjs", import.meta.url).href;
const PAGE = "https://93.184.216.34/page";

// Real shared execution and host registration; only DNS, HTTP and model runtime
// boundaries are substituted. Each child owns its generated configuration/cache.
function run(scenario = {}) {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
		env: { ...process.env },
		input: `
			import { mkdtemp, writeFile, rm } from 'node:fs/promises';
			import { tmpdir } from 'node:os';
			import { join } from 'node:path';
			import dns from 'node:dns/promises';
			import { syncBuiltinESMExports } from 'node:module';
			dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
			syncBuiltinESMExports();
			const s = ${JSON.stringify(scenario)};
			const root = await mkdtemp(join(tmpdir(), 'fetch-tool-selection-'));
			for (const key of ['HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR', 'TMPDIR']) process.env[key] = root;
			await writeFile(join(root, 'web-search.json'), JSON.stringify({
				fetchRouting: { providers: ['http'], allowRemoteHostedProviders: true },
				tavilyApiKey: 'synthetic-tavily-key', pdf: { provider: 'unpdf' }, ...s.config,
			}));
			const calls = [];
			const answers = [];
			const { makePdf } = await import(${JSON.stringify(fixtureUrl)});
			globalThis.fetch = async (target, init = {}) => {
				const url = String(target);
				calls.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
				if (url === 'https://api.tavily.com/extract') {
					const source = JSON.parse(init.body).urls[0];
					if (s.hostedFailure || source.endsWith('/failed')) return Response.json({ error: 'Synthetic quota exhausted' }, { status: 429 });
					return Response.json({ results: [{ url: source, title: 'Hosted page', raw_content: '# Hosted page\\n\\nSource from Tavily.' }] });
				}
				if (url.startsWith('https://r.jina.ai/')) return new Response('Synthetic Jina failure', { status: 503 });
				if (url.includes('generativelanguage.googleapis.com')) return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '# Video\\n\\nSynthetic transcript.' }] } }] });
				if (url.startsWith('https://93.184.216.34/')) {
					if (url.endsWith('/document')) return new Response(makePdf('PDF source content'), { headers: { 'content-type': 'application/pdf' } });
					if (url.endsWith('/cross-origin')) return new Response(null, { status: 302, headers: { location: 'https://other.example/page' } });
					if (url.endsWith('/article')) return new Response('<html><head><title>Readable article</title></head><body><article><p>' + 'Readable article content. '.repeat(100) + '</p></article></body></html>', { headers: { 'content-type': 'text/html' } });
					if (url.endsWith('/thin') || url.endsWith('/declared')) return new Response('<html><body><div>Loading...</div><script></script><script></script><script></script><script></script></body></html>', { headers: { 'content-type': 'text/html', ...(url.endsWith('/declared') ? { link: '</docs>; rel=service-doc' } : {}) } });
					return new Response('Ordinary HTTP source. '.repeat(60), { headers: { 'content-type': 'text/plain' } });
				}
				throw new Error('Unexpected external HTTP request');
			};
			try {
				let result, schema, retrieved;
				const params = s.params ?? { url: ${JSON.stringify(PAGE)}, provider: 'tavily' };
				if (s.host === 'mcp') {
					const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
					const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
					const { createMcpServer } = await import(${JSON.stringify(mcpUrl)});
					const { createStandaloneWebToolCore } = await import(${JSON.stringify(coreUrl)});
					const server = createMcpServer(createStandaloneWebToolCore(), { name: 'test', version: '0' });
					const client = new Client({ name: 'test', version: '0' });
					const [a, b] = InMemoryTransport.createLinkedPair();
					await Promise.all([server.connect(b), client.connect(a)]);
					schema = (await client.listTools()).tools.find(t => t.name === 'fetch_content').inputSchema;
					result = await client.callTool({ name: 'fetch_content', arguments: params });
					await client.close(); await server.close();
				} else if (s.host === 'pi') {
					const { default: initialize } = await import(${JSON.stringify(indexUrl)});
					const tools = [];
					initialize({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
					const tool = tools.find(t => t.name === 'fetch_content');
					schema = { input: tool.parameters, output: tool.outputSchema };
					const model = { provider: 'answer-fixture', id: 'answer-model', api: 'fixture-api', input: ['text'], contextWindow: 32000 };
					const ctx = { model, scopedModels: [], modelRegistry: {
						getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'synthetic-answer-key' }),
						complete: async (_model, context) => {
							answers.push(context.messages[0].content[0].text);
							if (s.answerFailure) throw new Error('Synthetic answer failure');
							return { stopReason: 'stop', content: [{ type: 'text', text: 'Answer from the separately configured model.' }] };
						},
					} };
					result = await tool.execute('fetch', params, undefined, undefined, ctx);
					if (result.details.responseId) retrieved = await tools.find(t => t.name === 'get_search_content').execute('read', { responseId: result.details.responseId, urlIndex: 0 });
				} else {
					const { createStandaloneWebToolCore } = await import(${JSON.stringify(coreUrl)});
					result = await createStandaloneWebToolCore().fetchContent(params);
				}
				console.log(JSON.stringify({ result, schema, calls, answers, retrieved }));
			} finally { await rm(root, { recursive: true, force: true }); }
		`,
	});
	assert.equal(child.status, 0, child.stderr || child.error?.message);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("shared fetch_content exposes actual explicit provider only in structured content", () => {
	const { result, calls } = run();
	assert.equal(result.structuredContent.urls[0].provider, "tavily");
	assert.deepEqual(result.structuredContent.urls[0].attempts, [{ provider: "tavily", outcome: "succeeded" }]);
	assert.equal(result.structuredContent.urls[0].content, "# Hosted page\n\nSource from Tavily.");
	assert.deepEqual(calls.map(c => c.url), [PAGE, "https://api.tavily.com/extract"]);
	assert.deepEqual(result.content, [
		{ type: "text", text: "# Hosted page\n\nSource from Tavily." },
		{ type: "text", text: `\n---\nFull content is stored as responseId "${result.details.responseId}". Use get_search_content({ responseId: "${result.details.responseId}", urlIndex: 0, offset: 0 }) to retrieve it.` },
	]);
	for (const field of ["provider", "extractionProvider", "attempts"]) assert.equal(result.details[field], undefined);
});

test("Pi batch keeps per-URL hosted, PDF, failed-attempt and preflight provenance separate", () => {
	const urls = [PAGE, "https://93.184.216.34/document", "https://93.184.216.34/failed", "https://blocked.example/page"];
	const { result, schema, calls } = run({
		host: "pi", params: { urls, provider: "tavily" },
		config: { fetchContent: { domainPolicy: { deny: ["blocked.example"] } } },
	});
	const [page, pdf, failed, blocked] = result.structuredContent.urls;
	assert.equal(page.provider, "tavily");
	assert.deepEqual(page.attempts, [{ provider: "tavily", outcome: "succeeded" }]);
	assert.equal(pdf.provider, null);
	assert.equal(pdf.extractionProvider, "unpdf");
	assert.deepEqual(pdf.attempts, [{ provider: null, extractionProvider: "unpdf", outcome: "succeeded" }]);
	assert.match(pdf.content, /PDF extracted and saved to:/);
	assert.equal(pdf.error, null);
	assert.equal(failed.provider, null);
	assert.deepEqual(failed.attempts, [{ provider: "tavily", outcome: "failed", error: "tavily extraction failed" }]);
	assert.match(failed.error, /429/);
	assert.equal(blocked.provider, null);
	assert.deepEqual(blocked.attempts, []);
	assert.match(blocked.error, /domain policy/i);
	assert.equal(result.details.successful, 2);
	assert.notEqual(result.isError, true);
	assert.equal(Value.Check(schema.output, result.structuredContent), true);
	assert.equal(calls.filter(c => c.url === urls[1]).length, 1);
	assert.deepEqual(calls.filter(c => c.url === "https://api.tavily.com/extract").map(c => c.body.urls[0]).sort(), [PAGE, urls[2]].sort());
	const text = result.content.map(c => c.text).join("\n");
	assert.match(text, /^## Fetched URLs\n\n- Hosted page/);
	assert.doesNotMatch(text, /extractionProvider|"attempts"|synthetic-tavily-key/);
});

test("Pi answer mode preserves source extraction provenance and stored originals, not the answer model", () => {
	const { result, schema, answers, retrieved, calls } = run({
		host: "pi", params: { url: PAGE, provider: "tavily", mode: "answer", prompt: "What does the page say?" },
	});
	const source = result.structuredContent.urls[0];
	assert.equal(source.content, "Answer from the separately configured model.");
	assert.equal(source.provider, "tavily");
	assert.deepEqual(source.attempts, [{ provider: "tavily", outcome: "succeeded" }]);
	assert.equal(source.extractionProvider, undefined);
	assert.equal(source.error, null);
	assert.equal(answers.length, 1);
	assert.match(answers[0], /Source from Tavily/);
	assert.doesNotMatch(answers[0], /Ordinary HTTP source/);
	assert.match(retrieved.content[0].text, /Source from Tavily/);
	assert.doesNotMatch(retrieved.content[0].text, /Answer from the separately configured model/);
	assert.deepEqual(result.content, [
		{ type: "text", text: "Answer from the separately configured model." },
		{ type: "text", text: `\n---\nOriginal source content is stored as responseId "${result.details.responseId}". Use get_search_content({ responseId: "${result.details.responseId}", urlIndex: 0, offset: 0 }) to retrieve it.` },
	]);
	assert.equal(calls.length, 2);
	assert.equal(Value.Check(schema.input, { url: PAGE, provider: "tavily", mode: "answer", prompt: "What does the page say?" }), true);
	assert.equal(Value.Check(schema.output, result.structuredContent), true);
});

test("an answer model failure does not rewrite successful extraction attempts", () => {
	const { result } = run({
		host: "pi", answerFailure: true,
		params: { url: PAGE, provider: "tavily", mode: "answer", prompt: "What does the page say?" },
	});
	assert.equal(result.isError, true);
	assert.match(result.structuredContent.urls[0].error, /Page answer failed/);
	assert.equal(result.structuredContent.urls[0].provider, "tavily");
	assert.deepEqual(result.structuredContent.urls[0].attempts, [{ provider: "tavily", outcome: "succeeded" }]);
});

test("MCP accepts explicit selection through the real shared core but keeps provenance off the wire", () => {
	const { result, schema, calls } = run({ host: "mcp" });
	assert.equal(result.isError, undefined);
	assert.deepEqual(Object.keys(result), ["content"]);
	assert.equal(result.structuredContent, undefined);
	assert.equal(result.details, undefined);
	assert.equal(result.content[0].text, "# Hosted page\n\nSource from Tavily.");
	assert.equal(result.content.length, 2);
	assert.match(result.content[1].text, /Full content is stored as responseId/);
	assert.deepEqual(calls.map(c => c.url), [PAGE, "https://api.tavily.com/extract"]);
	assert.deepEqual(schema.properties.provider.enum, ["auto", "http", "firecrawl", "crawl4ai", "jina", "tinyfish", "search1api", "querit", "kagi", "ollama", "parallel", "parallel-mcp", "brightdata", "gemini", "tavily"]);
});

test("shared auto and explicit http reuse their one HTTP response and report actual local extraction", () => {
	for (const provider of [undefined, "auto", "http"]) {
		const { result, calls } = run({ params: { url: PAGE, ...(provider ? { provider } : {}) } });
		assert.equal(result.structuredContent.urls[0].provider, "http");
		assert.deepEqual(result.structuredContent.urls[0].attempts, [{ provider: "http", outcome: "succeeded" }]);
		assert.deepEqual(calls.map(c => c.url), [PAGE]);
		assert.match(result.content[0].text, /^Ordinary HTTP source/);
	}
});

test("shared auto extracts origin content when hosted fallbacks are disabled", () => {
	for (const provider of [undefined, "auto"]) {
		const { result, calls } = run({
			params: { url: PAGE, ...(provider ? { provider } : {}) },
			config: { fetchRouting: { providers: ["tavily"], allowRemoteHostedProviders: false } },
		});
		const source = result.structuredContent.urls[0];
		assert.equal(source.error, null);
		assert.equal(source.provider, "http");
		assert.match(source.content, /^Ordinary HTTP source/);
		assert.deepEqual(source.attempts, [{ provider: "http", outcome: "succeeded" }]);
		assert.deepEqual(calls.map(c => c.url), [PAGE]);
	}
});

test("shared auto retains the HTTP extraction failure when no fallback is permitted", () => {
	const url = "https://93.184.216.34/thin";
	for (const redirects of [undefined, "same-origin"]) {
		for (const provider of [undefined, "auto"]) {
			const { result, calls } = run({
				params: { url, redirects, ...(provider ? { provider } : {}) },
				config: { fetchRouting: { providers: ["tavily"], allowRemoteHostedProviders: Boolean(redirects) } },
			});
			const source = result.structuredContent.urls[0];
			assert.equal(result.isError, true);
			assert.match(source.error, /JavaScript-rendered/);
			assert.equal(source.provider, null);
			assert.deepEqual(source.attempts, [{ provider: "http", outcome: "failed", error: "HTTP extraction failed" }]);
			assert.deepEqual(calls.map(c => c.url), [url]);
		}
	}
});

test("shared auto extracts HTML under same-origin without a configured HTTP entry", () => {
	const url = "https://93.184.216.34/article";
	for (const provider of [undefined, "auto"]) {
		const { result, calls } = run({
			params: { url, redirects: "same-origin", ...(provider ? { provider } : {}) },
			config: { fetchRouting: { providers: ["tavily"], allowRemoteHostedProviders: true } },
		});
		const source = result.structuredContent.urls[0];
		assert.equal(source.error, null);
		assert.equal(source.title, "Readable article");
		assert.match(source.content, /Readable article content/);
		assert.equal(source.provider, "http");
		assert.deepEqual(source.attempts, [{ provider: "http", outcome: "succeeded" }]);
		assert.deepEqual(calls.map(c => c.url), [url]);
	}
});

test("shared HTTP success does not resolve unused fallback credentials", () => {
	for (const providers of [["http", "tavily"], ["tavily", "http"], ["tavily"]]) {
		const { result, calls } = run({
			params: { url: PAGE, provider: "auto" },
			config: { tavilyApiKey: "$MISSING_UNUSED_TAVILY_KEY", fetchRouting: { providers, allowRemoteHostedProviders: true } },
		});
		assert.equal(result.structuredContent.urls[0].error, null);
		assert.equal(result.structuredContent.urls[0].provider, "http");
		assert.deepEqual(result.structuredContent.urls[0].attempts, [{ provider: "http", outcome: "succeeded" }]);
		assert.deepEqual(calls.map(c => c.url), [PAGE]);
	}
});

test("shared auto retains declared-link acceptance without an eligible hosted fallback", () => {
	const url = "https://93.184.216.34/declared";
	for (const redirects of [undefined, "same-origin"]) {
		const { result, calls } = run({
			params: { url, provider: "auto", redirects },
			config: { fetchRouting: { providers: ["tavily"], allowRemoteHostedProviders: Boolean(redirects) } },
		});
		const source = result.structuredContent.urls[0];
		assert.equal(source.error, null);
		assert.equal(source.provider, "http");
		assert.match(source.content, /https:\/\/93\.184\.216\.34\/docs/);
		assert.deepEqual(source.attempts, [{ provider: "http", outcome: "succeeded" }]);
		assert.deepEqual(calls.map(c => c.url), [url]);
	}
});

test("shared auto preserves per-URL HTTP, PDF, insufficient and blocked results with no eligible fallback", () => {
	const urls = [PAGE, "https://93.184.216.34/document", "https://93.184.216.34/thin", "http://127.0.0.1/private"];
	const { result, calls } = run({
		params: { urls, provider: "auto" },
		config: { fetchRouting: { providers: ["tavily"], allowRemoteHostedProviders: false } },
	});
	const [page, pdf, thin, blocked] = result.structuredContent.urls;
	assert.equal(result.details.successful, 2);
	assert.equal(page.provider, "http");
	assert.equal(page.error, null);
	assert.deepEqual(page.attempts, [{ provider: "http", outcome: "succeeded" }]);
	assert.equal(pdf.provider, null);
	assert.equal(pdf.extractionProvider, "unpdf");
	assert.equal(pdf.error, null);
	assert.deepEqual(pdf.attempts, [{ provider: null, extractionProvider: "unpdf", outcome: "succeeded" }]);
	assert.match(thin.error, /JavaScript-rendered/);
	assert.deepEqual(thin.attempts, [{ provider: "http", outcome: "failed", error: "HTTP extraction failed" }]);
	assert.match(blocked.error, /Blocked internal address/);
	assert.deepEqual(blocked.attempts, []);
	assert.deepEqual(calls.map(c => c.url).sort(), [PAGE, "https://93.184.216.34/document", "https://93.184.216.34/thin"].sort());
});

test("shared same-origin auto refuses cross-origin redirects without an HTTP list entry", () => {
	const url = "https://93.184.216.34/cross-origin";
	const { result, calls } = run({
		params: { url, provider: "auto", redirects: "same-origin" },
		config: { fetchRouting: { providers: ["tavily"], allowRemoteHostedProviders: true } },
	});
	const source = result.structuredContent.urls[0];
	assert.match(source.error, /Refused cross-origin redirect/);
	assert.equal(source.provider, null);
	assert.deepEqual(source.attempts, []);
	assert.deepEqual(calls.map(c => c.url), [url]);
});

test("Pi specialized YouTube success defers unused selected-provider credentials and has response-only identity", () => {
	const { result, calls, schema } = run({
		host: "pi", params: { url: "https://youtube.com/watch?v=abcdefghijk", provider: "tavily" },
		config: { tavilyApiKey: null, geminiApiKey: "synthetic-gemini-key" },
	});
	const source = result.structuredContent.urls[0];
	assert.equal(source.error, null);
	assert.equal(source.provider, null);
	assert.equal(source.extractionProvider, "youtube");
	assert.deepEqual(source.attempts, [{ provider: null, extractionProvider: "youtube", outcome: "succeeded" }]);
	assert.ok(calls.every(c => !c.url.includes("tavily")));
	assert.equal(Value.Check(schema.output, result.structuredContent), true);
	assert.equal(schema.input.properties.provider.enum.includes("youtube"), false);
	assert.equal(schema.input.properties.provider.enum.includes("local-video"), false);
	assert.doesNotMatch(JSON.stringify(result.content), /extractionProvider|"attempts"/);
});

test("Pi automatic answer mode preserves HTTP source provenance without eligible fallbacks", () => {
	const { result, calls, answers, retrieved } = run({
		host: "pi", params: { url: PAGE, provider: "auto", mode: "answer", prompt: "What does the page say?" },
		config: { fetchRouting: { providers: ["tavily"], allowRemoteHostedProviders: false } },
	});
	const source = result.structuredContent.urls[0];
	assert.equal(source.error, null);
	assert.equal(source.provider, "http");
	assert.equal(source.content, "Answer from the separately configured model.");
	assert.deepEqual(source.attempts, [{ provider: "http", outcome: "succeeded" }]);
	assert.equal(answers.length, 1);
	assert.match(answers[0], /Ordinary HTTP source/);
	assert.match(retrieved.content[0].text, /Ordinary HTTP source/);
	assert.deepEqual(calls.map(c => c.url), [PAGE]);
});

test("shared auto rejects malformed routing configuration before fetching", () => {
	for (const fetchRouting of [
		{ providers: [] },
		{ providers: "http" },
		{ providers: ["unknown"] },
		{ providers: ["http", "http"] },
		{ providers: ["http"], allowRemoteHostedProviders: "false" },
	]) {
		const { result, calls } = run({ params: { url: PAGE, provider: "auto" }, config: { fetchRouting } });
		assert.equal(result.isError, true);
		assert.match(result.structuredContent.urls[0].error, /fetchRouting/);
		assert.equal(result.structuredContent.urls[0].provider, null);
		assert.deepEqual(result.structuredContent.urls[0].attempts, []);
		assert.deepEqual(calls, []);
	}
});

test("shared request validation rejects invalid selections without external requests", () => {
	for (const provider of ["unknown", "youtube", "local-video", ["http"], null]) {
		const { result, calls } = run({ params: { url: PAGE, provider } });
		assert.match(result.content[0].text, /provider must be/);
		assert.deepEqual(calls, []);
	}
});

test("raw and incompatible specialized-option rejection preserve empty actual attempt lists", () => {
	for (const options of [{ mode: "raw" }, { forceClone: true }, { model: "video-model" }]) {
		const { result, calls } = run({ params: { url: PAGE, provider: "tavily", ...options } });
		const source = result.structuredContent.urls[0];
		assert.equal(result.isError, true);
		assert.equal(source.provider, null);
		assert.deepEqual(source.attempts, []);
		assert.ok(source.error);
		assert.deepEqual(calls, []);
	}
});

test("MCP rejects invalid and raw non-HTTP selections without changing its error transport", () => {
	for (const params of [{ url: PAGE, provider: "youtube" }, { url: PAGE, provider: "tavily", mode: "raw" }]) {
		const { result, calls } = run({ host: "mcp", params });
		assert.equal(result.isError, true);
		assert.equal(result.structuredContent, undefined);
		assert.equal(result.details, undefined);
		assert.equal(result.content[0].type, "text");
		assert.match(result.content[0].text, /provider/);
		assert.deepEqual(calls, []);
	}
});

test("shared automatic fallback serializes ordered actual attempts without repeating HTTP", () => {
	const url = "https://93.184.216.34/thin";
	for (const providers of [["http", "tavily"], ["tavily", "http"], ["tavily"]]) {
		const { result, calls } = run({
			params: { url }, config: { fetchRouting: { providers, allowRemoteHostedProviders: true } },
		});
		assert.equal(result.structuredContent.urls[0].provider, "tavily");
		assert.deepEqual(result.structuredContent.urls[0].attempts, [
			{ provider: "http", outcome: "failed", error: "HTTP extraction failed" },
			{ provider: "tavily", outcome: "succeeded" },
		]);
		assert.deepEqual(calls.map(c => c.url), [url, "https://api.tavily.com/extract"]);
	}
});

test("shared auto preserves fallback order and actual attempts on success or exhaustion", () => {
	const url = "https://93.184.216.34/thin";
	for (const hostedFailure of [false, true]) {
		const { result, calls } = run({
			hostedFailure, params: { url, provider: "auto" },
			config: { fetchRouting: { providers: ["jina", "http", "tavily"], allowRemoteHostedProviders: true } },
		});
		const source = result.structuredContent.urls[0];
		assert.equal(source.provider, hostedFailure ? null : "tavily");
		assert.deepEqual(source.attempts, [
			{ provider: "http", outcome: "failed", error: "HTTP extraction failed" },
			{ provider: "jina", outcome: "failed", error: "jina extraction failed" },
			hostedFailure
				? { provider: "tavily", outcome: "failed", error: "tavily extraction failed" }
				: { provider: "tavily", outcome: "succeeded" },
		]);
		if (hostedFailure) assert.match(source.error, /JavaScript-rendered/);
		else assert.equal(source.error, null);
		assert.deepEqual(calls.map(c => c.url), [url, "https://r.jina.ai/" + url, "https://api.tavily.com/extract"]);
	}
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;
const fixtureUrl = new URL("./pdf-fixture.mjs", import.meta.url).href;

function run(scenario = {}) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^(TAVILY_|FIRECRAWL_|CRAWL4AI_|GEMINI_|GOOGLE_|PADDLEOCR_|DATALAB_|PARALLEL_|TINYFISH_|SEARCH1API_|QUERIT_|KAGI_|OLLAMA_|BRIGHTDATA_|PERPLEXITY_|PDF_ENDPOINT_)/.test(key)) delete env[key];
	}
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		env, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
		input: `
			import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
			import { tmpdir } from 'node:os';
			import { join } from 'node:path';
			import { mock } from 'node:test';
			import { makePdf } from ${JSON.stringify(fixtureUrl)};
			const s = ${JSON.stringify(scenario)};
			const root = await mkdtemp(join(tmpdir(), 'pi-extract-selection-'));
			for (const key of ['PI_CODING_AGENT_DIR', 'HOME', 'USERPROFILE', 'TMPDIR']) process.env[key] = root;
			await writeFile(join(root, 'web-search.json'), JSON.stringify({
				fetchRouting: {providers: ['http', 'jina'], allowRemoteHostedProviders: true},
				...s.config,
			}));
			if (s.github || s.framesRuntime) {
				const bin = join(root, 'bin');
				await mkdir(bin);
				await writeFile(join(bin, 'gh'), '#!' + process.execPath + '\\n' + (s.githubFailure ? 'process.exit(1)' : "if (process.argv[2] === '--version') process.exit(0); console.log(Buffer.from('Specialized GitHub file').toString('base64'));"), {mode: 0o755});
				if (s.framesRuntime) {
					for (const [name, body] of Object.entries({
						'yt-dlp': "console.log(60); console.log('https://stream.invalid/video');",
						'ffprobe': "console.log('60');",
						'ffmpeg': "process.stdout.write('fake-jpeg-bytes');",
					})) await writeFile(join(bin, name), '#!' + process.execPath + '\\n' + body, {mode: 0o755});
				}
				process.env.PATH = bin;
			}
			const calls = [];
			const controller = new AbortController();
			if (s.aborted) controller.abort();
			let url = s.url ?? 'https://example.com/page';
			if (s.localVideo) { url = join(root, 'video.mp4'); await writeFile(url, 'synthetic video'); }
			let cancelledBody = false;
			globalThis.resizeCalls = 0;
			if (s.image) {
				const {registerHooks} = await import('node:module');
				registerHooks({resolve(specifier, context, nextResolve) {
					if (specifier === '@earendil-works/pi-coding-agent') return {url: 'data:text/javascript,' + encodeURIComponent('export async function resizeImage() { globalThis.resizeCalls++; return {width: 1, height: 1, data: "AA==", mimeType: "image/png"}; }'), shortCircuit: true};
					return nextResolve(specifier, context);
				}});
			}
			globalThis.fetch = async (target, init = {}) => {
				const address = String(target);
				calls.push({url: address, headers: Object.fromEntries(new Headers(init.headers)), body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null});
				if (address === url) {
					if (s.cancelDuringDiscovery) controller.abort();
					if (s.discoveryError) throw new Error('Authorization: Bearer private-transport-secret at /private/config');
					if (s.retryDiscoveryError && calls.filter(call => call.url === url).length > 1) throw new Error('network failed');
					if (s.redirect) return new Response(null, {status: 302, headers: {location: s.redirect}});
					if (s.retryRedirect && calls.filter(call => call.url === url).length > 1) return new Response(null, {status: 302, headers: {location: s.retryRedirect}});
					if (s.pdfHttpError) return new Response('unavailable', {status: 503, headers: {'content-type': 'application/pdf'}});
					if (s.image) return new Response('synthetic image bytes', {headers: {'content-type': 'image/png'}});
					if (s.shortMarkdown && calls.filter(call => call.url === url).length === 1) {
						const body = s.markdownBodyDeadline ? new ReadableStream({
							pull(controller) {
								mock.timers.setTime(101);
								controller.enqueue(new TextEncoder().encode('# Short negotiated Markdown'));
								controller.close();
							},
						}) : '# Short negotiated Markdown';
						return new Response(body, {headers: {'content-type': 'text/markdown'}});
					}
					if (s.pdf) return new Response(s.invalidPdf ? 'bad PDF' : makePdf('Actual PDF body', s.pages ?? 1), {headers: {'content-type': 'application/pdf', ...(s.length ? {'content-length': String(s.length)} : {})}});
					if (s.blocked) return new Response('blocked', {status: 403});
					if (s.unusedBody) return new Response(new ReadableStream({cancel() {cancelledBody = true;}}), {headers: {'content-type': 'text/html', ...(s.declared ? {link: '</docs>; rel=service-doc'} : {})}});
					return new Response(s.thin ? '<html><body><div>Loading...</div><script></script><script></script><script></script><script></script></body></html>' : '<html><head><title>HTTP page</title></head><body><article><p>' + 'Useful ordinary page content. '.repeat(100) + '</p></article></body></html>', {headers: {'content-type': 'text/html', ...(s.declared ? {link: '</docs>; rel=service-doc'} : {})}});
				}
				if (address === 'https://crawl4ai.example/md') return Response.json({success: true, markdown: '# Crawl4AI page'});
				if (address === 'https://api.fetch.tinyfish.ai') return Response.json({results: [{url, final_url: url, title: 'TinyFish page', text: '# TinyFish page', format: 'markdown'}], errors: []});
				if (address === 'https://api.search1api.com/crawl') return Response.json({crawlParameters: {url}, results: {title: 'Search1API page', link: url, content: '# Search1API page'}});
				if (address === 'https://api.querit.ai/v1/contents') return Response.json({error_code: 200, error_msg: '', results: [{id: 'page', url, content: '# Querit page', extrasMeta: {title: 'Querit page'}}], statuses: [{id: 'page', status: 'success'}]});
				if (address === 'https://kagi.com/api/v1/extract') return Response.json({data: [{url, title: 'Kagi page', markdown: '# Kagi page'}]});
				if (address === 'https://ollama.com/api/web_fetch') return Response.json({title: 'Ollama page', content: '# Ollama page', links: []});
				if (address === 'https://api.parallel.ai/v1/extract') return Response.json({results: [{url, title: 'Parallel page', excerpts: ['# Parallel page ' + 'Substantial content. '.repeat(40)], full_content: '# Parallel full content ' + 'Substantial content. '.repeat(40)}]});
				if (address === 'https://search.parallel.ai/mcp') return Response.json({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: JSON.stringify({results: [{url, title: 'Parallel MCP page', full_content: '# Parallel MCP page'}]})}]}});
				if (address === 'https://api.brightdata.com/request') return new Response('# Bright Data page');
				if (address === 'http://127.0.0.1:9/parse') {
					if (s.pdfEndpointDeadline) {
						if (s.elapsedOnly) mock.timers.setTime(101);
						else mock.timers.tick(101);
						if (s.cancelAtPdfEndpoint) controller.abort();
						if (s.pdfEndpointDeadline === 'failure') return new Response('unavailable', {status: 503});
					}
					return Response.json({markdown: 'Endpoint PDF content', pages: 1});
				}
				if (address.includes('paddleocr.aistudio-app.com')) return new Response('unavailable', {status: 503});
				if (address.includes('generativelanguage.googleapis.com') && s.localVideo) {
					if (address.includes('/upload/')) return new Response(null, {headers: {'x-goog-upload-url': 'https://generativelanguage.googleapis.com/synthetic-upload'}});
					if (address.endsWith('/synthetic-upload')) return Response.json({file: {name: 'files/synthetic-video', uri: 'https://generativelanguage.googleapis.com/files/synthetic-video'}});
					if (address.endsWith('/files/synthetic-video')) return init.method === 'DELETE' ? new Response(null) : Response.json({state: 'ACTIVE'});
				}
				if (address === 'https://api.perplexity.ai/chat/completions') return Response.json({choices: [{message: {content: s.emptyPerplexity ? '' : 'Synthetic video summary'}}]});
				if (address.includes('generativelanguage.googleapis.com')) {
					if (s.cancelYoutube) controller.abort();
					if (s.youtubeFailure) return Response.json({error: {message: 'Synthetic Gemini failure'}}, {status: 503});
					return Response.json({candidates: [{finishReason: 'STOP', content: {parts: [{text: '# Specialized YouTube video\\n\\nSynthetic transcript.'}]}}]});
				}
				if (address === 'https://firecrawl.example/v2/scrape') return Response.json({success: true, data: {markdown: '# Firecrawl page\\n\\nHosted content.', metadata: {title: 'Firecrawl page'}}});
				if (address === 'https://api.tavily.com/extract') {
					if (s.failHosted) throw new Error('Authorization: Bearer private-hosted-secret at /private/config');
					if (s.cancelHosted) controller.abort();
					return Response.json({results: [{url, title: 'Tavily page', raw_content: '# Tavily page\\n\\nHosted content.'}]});
				}
				if (address.startsWith('https://r.jina.ai/') && s.failJina) return new Response('unavailable', {status: 503});
				if (address.startsWith('https://r.jina.ai/')) return new Response('Markdown Content:\\n# Jina page\\n\\n' + 'Fallback content. '.repeat(30));
				throw new Error('Unexpected external request ' + address);
			};
			try {
				const { extractContent } = await import(${JSON.stringify(extractUrl)});
				if (s.pdfEndpointDeadline || s.markdownBodyDeadline) mock.timers.enable({apis: ['Date', 'setTimeout'], now: 0});
				const result = await extractContent(url, controller.signal, {lookup: async () => [{address: '93.184.216.34', family: 4}], ...s.options});
				console.log(JSON.stringify({result, calls, cancelledBody, resizeCalls: globalThis.resizeCalls}));
			} finally { mock.timers.reset(); await rm(root, {recursive: true, force: true}); }
		`,
	});
	assert.equal(child.status, 0, child.stderr || child.error?.message);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("extractContent auto uses one HTTP response and identifies its ordinary extraction", () => {
	const { result, calls } = run();
	assert.equal(result.error, null);
	assert.equal(result.title, "HTTP page");
	assert.equal(result.provider, "http");
	assert.deepEqual(result.attempts, [{provider: "http", outcome: "succeeded"}]);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page"]);
});

test("extractContent explicit Tavily ignores discovery HTML outside the auto provider list", () => {
	const { result, calls } = run({
		options: {provider: "tavily"},
		config: {tavilyApiKey: "synthetic-tavily-key", fetchRouting: {providers: ["http"], allowRemoteHostedProviders: true}},
	});
	assert.equal(result.error, null);
	assert.equal(result.title, "Tavily page");
	assert.equal(result.provider, "tavily");
	assert.deepEqual(result.attempts, [{provider: "tavily", outcome: "succeeded"}]);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://api.tavily.com/extract"]);
	assert.equal(calls[1].headers.authorization, "Bearer synthetic-tavily-key");
	assert.deepEqual(calls[1].body, {urls: ["https://example.com/page"], extract_depth: "basic", format: "markdown"});
});

test("extractContent auto continues insufficient HTTP content once through the configured order", () => {
	const {result, calls} = run({thin: true, config: {fetchRouting: {providers: ["jina", "http"], allowRemoteHostedProviders: true}}});
	assert.equal(result.provider, "jina");
	assert.deepEqual(result.attempts, [
		{provider: "http", outcome: "failed", error: "HTTP extraction failed"},
		{provider: "jina", outcome: "succeeded"},
	]);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://r.jina.ai/https://example.com/page"]);
});

for (const provider of ["auto", "http"]) {
	test(`extractContent ${provider} retains one failed HTTP attempt after a negotiation retry transport failure`, () => {
		const {result, calls} = run({shortMarkdown: true, retryDiscoveryError: true, options: {provider}});
		assert.deepEqual(result.attempts, [
			{provider: "http", outcome: "failed", error: "HTTP extraction failed"},
			...(provider === "auto" ? [{provider: "jina", outcome: "succeeded"}] : []),
		]);
		assert.equal(result.provider, provider === "auto" ? "jina" : null);
		if (provider === "auto") {
			assert.equal(result.error, null);
			assert.match(result.content, /^# Jina page/);
		} else {
			assert.equal(result.content, "# Short negotiated Markdown");
			assert.equal(result.error, "Extracted content appears incomplete\nBrowser retry failed: network failed");
		}
		assert.deepEqual(calls.map(call => call.url), [
			"https://example.com/page", "https://example.com/page",
			...(provider === "auto" ? ["https://r.jina.ai/https://example.com/page"] : []),
		]);
		assert.match(calls[0].headers.accept, /^text\/markdown/);
		assert.match(calls[1].headers.accept, /^text\/html/);
	});
}

test("extractContent negotiation retry preflight and PDF failures never invent ordinary HTTP attempts", () => {
	for (const scenario of [
		{pdf: true, config: {pdf: {enabled: false}}},
		{pdf: true, length: 2 * 1024 * 1024, config: {pdf: {maxSizeMB: 1}}},
		{pdf: true, invalidPdf: true, config: {pdf: {provider: "unpdf"}}},
		{pdf: true, config: {pdf: {provider: "paddleocr"}, paddleocrApiKey: "$MISSING_UNUSED_PADDLE_KEY"}},
		{retryRedirect: "http://127.0.0.1/private"},
	]) {
		const {result, calls} = run({shortMarkdown: true, options: {provider: "auto"}, ...scenario});
		assert.ok(result.error);
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, scenario.invalidPdf
			? [{provider: null, extractionProvider: "unpdf", outcome: "failed", error: "PDF unpdf extraction failed"}]
			: []);
		assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://example.com/page"]);
	}
});

test("extractContent rejects invalid selections and raw/auth conflicts before any extraction", () => {
	for (const options of [
		{provider: "unknown"}, {provider: ["http"]}, {provider: null},
		{provider: "tavily", mode: "raw"},
		{provider: "tavily", authFetchProfile: {name: "test"}},
		{provider: "tavily", forceClone: true},
		{provider: "http", model: "video-only"},
	]) {
		const {result, calls} = run({options});
		assert.ok(result.error, JSON.stringify(options));
		assert.deepEqual(result.attempts, []);
		assert.equal(result.provider, null);
		assert.deepEqual(calls, []);
	}
});

test("extractContent discovers an extensionless PDF once before unused Tavily credentials", () => {
	const {result, calls} = run({pdf: true, options: {provider: "tavily", mode: "answer"}, config: {pdf: {provider: "unpdf"}, tavilyApiKey: "$MISSING_UNUSED_TAVILY_KEY"}});
	assert.equal(result.error, null);
	assert.match(result.content, /Actual PDF body/);
	assert.equal(result.provider, null);
	assert.equal(result.extractionProvider, "unpdf");
	assert.deepEqual(result.attempts, [{provider: null, extractionProvider: "unpdf", outcome: "succeeded"}]);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page"]);
});

for (const provider of ["auto", "http"]) {
	test(`extractContent ${provider} preserves null ordinary provenance when short Markdown retries as PDF`, () => {
		const {result, calls} = run({
			shortMarkdown: true, pdf: true, options: {provider, mode: "answer"}, config: {pdf: {provider: "unpdf"}},
		});
		assert.equal(result.error, null);
		assert.match(result.content, /Actual PDF body/);
		assert.equal(result.provider, null);
		assert.equal(result.extractionProvider, "unpdf");
		assert.deepEqual(result.attempts, [{provider: null, extractionProvider: "unpdf", outcome: "succeeded"}]);
		assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://example.com/page"]);
		assert.match(calls[0].headers.accept, /^text\/markdown/);
		assert.match(calls[1].headers.accept, /^text\/html/);
	});
}

test("extractContent refuses PDF web fallback even when Firecrawl v2 caps pages but cannot bind input size", () => {
	const {result, calls} = run({
		pdf: true, invalidPdf: true, options: {provider: "firecrawl"},
		config: {pdf: {provider: "unpdf", maxPages: 2, maxSizeMB: 1}, firecrawlBaseUrl: "https://firecrawl.example", firecrawlApiVersion: "v2", firecrawlPdfMaxPages: 2},
	});
	assert.equal(result.provider, null);
	assert.match(result.error, /PDF extraction failed/);
	assert.match(result.error, /fallback.*(?:bytes|size)/i);
	assert.deepEqual(result.attempts, [{provider: null, extractionProvider: "unpdf", outcome: "failed", error: "PDF unpdf extraction failed"}]);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page"]);
});

const githubUrl = "https://github.com/owner/repo/blob/" + "a".repeat(40) + "/README.md";

test("extractContent GitHub specialization precedes explicit Tavily without unused credentials", () => {
	const {result, calls} = run({url: githubUrl, github: true, options: {provider: "tavily", forceClone: true}, config: {tavilyApiKey: "$MISSING_UNUSED_TAVILY_KEY"}});
	assert.equal(result.error, null);
	assert.match(result.content, /Specialized GitHub file/);
	assert.equal(result.provider, null);
	assert.equal(result.extractionProvider, "github");
	assert.deepEqual(result.attempts, [{provider: null, extractionProvider: "github", outcome: "succeeded"}]);
	assert.deepEqual(calls, []);
});

test("extractContent never substitutes HTTP for an explicit provider under same-origin policy", () => {
	const {result, calls} = run({options: {provider: "tavily", redirects: "same-origin"}, config: {tavilyApiKey: "synthetic-key"}});
	assert.match(result.error, /same-origin/);
	assert.equal(result.provider, null);
	assert.deepEqual(result.attempts, []);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page"]);
});

test("extractContent PDF size and enablement preflight never become HTTP or hosted attempts", () => {
	for (const scenario of [
		{config: {pdf: {enabled: false}}},
		{length: 2 * 1024 * 1024, config: {pdf: {maxSizeMB: 1}}},
		{config: {pdf: {maxSizeMB: 0.0001}}},
	]) {
		const {result, calls} = run({pdf: true, ...scenario});
		assert.match(result.error, /PDF (?:extraction is disabled|exceeds configured pdf.maxSizeMB limit)/);
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, []);
		assert.deepEqual(calls.map(call => call.url), ["https://example.com/page"]);
	}
});

test("extractContent raw HTTP records the actual HTTP route without hosted fallback", () => {
	const {result, calls} = run({options: {provider: "http", mode: "raw"}});
	assert.equal(result.error, null);
	assert.match(result.content, /<html>/);
	assert.equal(result.provider, "http");
	assert.deepEqual(result.attempts, [{provider: "http", outcome: "succeeded"}]);
	assert.equal(calls.length, 1);
});


test("extractContent explicit Firecrawl never accepts populated discovery HTML", () => {
	const {result, calls} = run({options: {provider: "firecrawl"}, config: {firecrawlBaseUrl: "https://firecrawl.example", firecrawlApiVersion: "v2"}});
	assert.equal(result.error, null);
	assert.equal(result.title, "Firecrawl page");
	assert.equal(result.provider, "firecrawl");
	assert.deepEqual(result.attempts, [{provider: "firecrawl", outcome: "succeeded"}]);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://firecrawl.example/v2/scrape"]);
});

test("extractContent explicit hosted extraction cancels unused discovery bodies", () => {
	const {result, cancelledBody} = run({unusedBody: true, options: {provider: "tavily"}, config: {tavilyApiKey: "synthetic-key"}});
	assert.equal(result.provider, "tavily");
	assert.equal(result.error, null);
	assert.equal(cancelledBody, true);
});

test("extractContent explicit HTTP is single-response and strict even with insufficient content", () => {
	for (const thin of [false, true]) {
		const {result, calls} = run({thin, options: {provider: "http"}, config: {fetchRouting: {providers: ["jina"], allowRemoteHostedProviders: true}}});
		assert.equal(result.provider, thin ? null : "http");
		assert.equal(Boolean(result.error), thin);
		assert.deepEqual(result.attempts, [thin ? {provider: "http", outcome: "failed", error: "HTTP extraction failed"} : {provider: "http", outcome: "succeeded"}]);
		assert.deepEqual(calls.map(call => call.url), ["https://example.com/page"]);
	}
});

test("extractContent does not revisit a late HTTP entry after exhausting ordinary routes", () => {
	const {result, calls} = run({thin: true, failJina: true, config: {fetchRouting: {providers: ["jina", "http"], allowRemoteHostedProviders: true}}});
	assert.ok(result.error);
	assert.equal(result.provider, null);
	assert.deepEqual(result.attempts, [
		{provider: "http", outcome: "failed", error: "HTTP extraction failed"},
		{provider: "jina", outcome: "failed", error: "jina extraction failed"},
	]);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://r.jina.ai/https://example.com/page"]);
});

test("extractContent reports failed explicit extraction safely and never substitutes ordinary providers", () => {
	const {result, calls} = run({failHosted: true, options: {provider: "tavily"}, config: {tavilyApiKey: "synthetic-key"}});
	assert.ok(result.error);
	assert.equal(result.provider, null);
	assert.equal(result.content, "");
	assert.deepEqual(result.attempts, [{provider: "tavily", outcome: "failed", error: "tavily extraction failed"}]);
	assert.doesNotMatch(JSON.stringify(result.attempts), /private-|Authorization|Bearer|stack|cause/);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://api.tavily.com/extract"]);
});

test("extractContent recoverable discovery failure still uses the selected ordinary provider", () => {
	for (const provider of ["tavily", "auto"]) {
		const {result, calls} = run({discoveryError: true, options: {provider}, config: {tavilyApiKey: "synthetic-key"}});
		assert.equal(result.error, null);
		assert.deepEqual(result.attempts, [{provider: provider === "auto" ? "jina" : "tavily", outcome: "succeeded"}]);
		assert.equal(calls.length, 2);
	}
});

test("extractContent unavailable explicit providers and missing credentials are not extraction attempts", () => {
	for (const config of [{}, {tavilyApiKey: "$MISSING_UNUSED_TAVILY_KEY"}]) {
		const {result, calls} = run({options: {provider: "tavily"}, config});
		assert.match(result.error, /unavailable|credential resolution failed/);
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, []);
		assert.deepEqual(calls.map(call => call.url), ["https://example.com/page"]);
	}
});

test("extractContent recoverable GitHub failure falls through to selected Tavily", () => {
	const {result, calls} = run({url: githubUrl, github: true, githubFailure: true, options: {provider: "tavily"}, config: {tavilyApiKey: "synthetic-key"}});
	assert.equal(result.error, null);
	assert.equal(result.provider, "tavily");
	assert.deepEqual(result.attempts, [
		{provider: null, extractionProvider: "github", outcome: "failed", error: "github extraction failed"},
		{provider: "tavily", outcome: "succeeded"},
	]);
	assert.deepEqual(calls.map(call => call.url), [githubUrl, "https://api.tavily.com/extract"]);
});

test("extractContent skips disabled GitHub specialization without inventing attempts", () => {
	const {result} = run({url: githubUrl, github: true, options: {provider: "tavily"}, config: {githubClone: {enabled: false}, tavilyApiKey: "synthetic-key"}});
	assert.equal(result.provider, "tavily");
	assert.deepEqual(result.attempts, [{provider: "tavily", outcome: "succeeded"}]);
});

for (const provider of ["http", "tavily"]) {
	test(`extractContent skips unavailable YouTube backends before ordinary ${provider} extraction`, () => {
		const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
		const {result, calls} = run({
			url, options: {provider}, config: {allowBrowserCookies: false, image: {enabled: false}, tavilyApiKey: "synthetic-key"},
		});
		assert.equal(result.error, null);
		assert.equal(result.provider, provider);
		assert.equal(result.extractionProvider, undefined);
		assert.deepEqual(result.attempts, [{provider, outcome: "succeeded"}]);
		assert.deepEqual(calls.map(call => call.url), [url, ...(provider === "tavily" ? ["https://api.tavily.com/extract"] : [])]);
	});
}

test("extractContent YouTube specialization preserves legitimate model options before unused Tavily", () => {
	const {result, calls} = run({url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", options: {provider: "tavily", model: "gemini-3-flash", prompt: "Read the video"}, config: {image: {enabled: false}, geminiApiKey: "synthetic-gemini-key", tavilyApiKey: "$MISSING_UNUSED_TAVILY_KEY"}});
	assert.equal(result.error, null);
	assert.equal(result.provider, null);
	assert.equal(result.extractionProvider, "youtube");
	assert.deepEqual(result.attempts, [{provider: null, extractionProvider: "youtube", outcome: "succeeded"}]);
	assert.equal(calls.length, 1);
	assert.match(calls[0].url, /generativelanguage.googleapis.com/);
});

test("extractContent recoverable YouTube failure continues to explicit hosted extraction", () => {
	const {result} = run({youtubeFailure: true, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", options: {provider: "tavily"}, config: {image: {enabled: false}, geminiApiKey: "synthetic-gemini-key", tavilyApiKey: "synthetic-key"}});
	assert.equal(result.error, null);
	assert.equal(result.provider, "tavily");
	assert.deepEqual(result.attempts, [
		{provider: null, extractionProvider: "youtube", outcome: "failed", error: "youtube extraction failed"},
		{provider: "tavily", outcome: "succeeded"},
	]);
});

for (const geminiFailure of [false, true]) {
	test(`extractContent counts invoked empty YouTube extraction once${geminiFailure ? " after another backend fails" : ""}`, () => {
		const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
		const {result, calls} = run({
			url, emptyPerplexity: true, youtubeFailure: geminiFailure, options: {provider: "tavily"},
			config: {allowBrowserCookies: false, image: {enabled: false}, perplexityApiKey: "synthetic-key", tavilyApiKey: "synthetic-key", ...(geminiFailure ? {geminiApiKey: "synthetic-key"} : {})},
		});
		assert.equal(result.error, null);
		assert.equal(result.provider, "tavily");
		assert.deepEqual(result.attempts, [
			{provider: null, extractionProvider: "youtube", outcome: "failed", error: "youtube extraction failed"},
			{provider: "tavily", outcome: "succeeded"},
		]);
		assert.deepEqual(calls.slice(geminiFailure ? 1 : 0).map(call => call.url), ["https://api.perplexity.ai/chat/completions", url, "https://api.tavily.com/extract"]);
		if (geminiFailure) assert.match(calls[0].url, /generativelanguage.googleapis.com/);
	});
}

test("extractContent YouTube credential preflight remains terminal without invented attempts", () => {
	for (const config of [{geminiApiKey: "$MISSING_UNUSED_GEMINI_KEY"}, {perplexityApiKey: "$MISSING_UNUSED_PERPLEXITY_KEY"}]) {
		const {result, calls} = run({
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", options: {provider: "tavily"},
			config: {allowBrowserCookies: false, image: {enabled: false}, tavilyApiKey: "synthetic-key", ...config},
		});
		assert.match(result.error, /credential resolution failed:/);
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, []);
		assert.deepEqual(calls, []);
	}
});

test("extractContent cancellation after actual YouTube invocation records one aborted specialized attempt", () => {
	const {result, calls} = run({
		url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", cancelYoutube: true, options: {provider: "tavily"},
		config: {allowBrowserCookies: false, image: {enabled: false}, geminiApiKey: "synthetic-key", tavilyApiKey: "synthetic-key"},
	});
	assert.equal(result.error, "Aborted");
	assert.equal(result.provider, null);
	assert.deepEqual(result.attempts, [{provider: null, extractionProvider: "youtube", outcome: "failed", error: "Aborted"}]);
	assert.equal(calls.length, 1);
	assert.match(calls[0].url, /generativelanguage.googleapis.com/);
});

test("extractContent permits safely discovered PDF specialization under same-origin and unused hosted opt-out", () => {
	const {result, calls} = run({pdf: true, options: {provider: "tavily", redirects: "same-origin", mode: "answer"}, config: {pdf: {provider: "unpdf"}, fetchRouting: {providers: ["jina"], allowRemoteHostedProviders: false}}});
	assert.equal(result.error, null);
	assert.equal(result.provider, null);
	assert.equal(result.extractionProvider, "unpdf");
	assert.equal(calls.length, 1);
});

test("extractContent safety, same-origin discovery redirects, and cancellation remain terminal", () => {
	for (const scenario of [
		{url: "http://127.0.0.1/private"},
		{redirect: "http://127.0.0.1/private"},
		{redirect: "https://other.example/page", options: {provider: "tavily", redirects: "same-origin"}},
		{aborted: true}, {cancelDuringDiscovery: true},
	]) {
		const {result, calls} = run({options: {provider: "tavily"}, config: {tavilyApiKey: "synthetic-key"}, ...scenario});
		assert.ok(result.error);
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, []);
		assert.ok(calls.length <= 1);
	}
});

test("extractContent PDF preflight processing limits and credentials stop before any engine or hosted submission", () => {
	for (const config of [
		{pdf: {provider: "paddleocr", maxPages: 1001}, paddleocrApiKey: "synthetic-paddle-key"},
		{pdf: {provider: "paddleocr"}, paddleocrApiKey: "$MISSING_UNUSED_PADDLE_KEY"},
	]) {
		const {result, calls} = run({pdf: true, pages: 1001, options: {provider: "tavily"}, config: {...config, tavilyApiKey: "synthetic-key"}});
		assert.match(result.error, /1-1000 selected pages|credential resolution failed/);
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, []);
		assert.deepEqual(calls.map(call => call.url), ["https://example.com/page"]);
	}
});

test("extractContent successful hosted PDF engines retain actual null-route provenance", () => {
	const {result, calls} = run({pdf: true, options: {provider: "http", mode: "answer"}, config: {pdf: {provider: "endpoint", endpointUrl: "http://127.0.0.1:9/parse"}}});
	assert.equal(result.error, null);
	assert.match(result.content, /Endpoint PDF content/);
	assert.equal(result.provider, null);
	assert.equal(result.extractionProvider, "endpoint");
	assert.deepEqual(result.attempts, [{provider: null, extractionProvider: "endpoint", outcome: "succeeded"}]);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "http://127.0.0.1:9/parse"]);
});

for (const outcome of ["success", "failure"]) {
	for (const elapsedOnly of [false, true]) {
		test(`extractContent PDF ${outcome} after the HTTP deadline remains terminal (${elapsedOnly ? "elapsed" : "timer"})`, () => {
			const {result, calls} = run({
				pdf: true, invalidPdf: outcome === "failure", pdfEndpointDeadline: outcome, elapsedOnly,
				options: {provider: "tavily", timeoutMs: 100},
				config: {pdf: {provider: "endpoint", endpointUrl: "http://127.0.0.1:9/parse"}, tavilyApiKey: "synthetic-key"},
			});
			assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "http://127.0.0.1:9/parse"]);
			assert.equal(result.error, "The operation was aborted.");
			assert.equal(result.content, "");
			assert.equal(result.provider, null);
			assert.deepEqual(result.attempts, outcome === "success"
				? [{provider: null, extractionProvider: "endpoint", outcome: "succeeded"}]
				: [
					{provider: null, extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed"},
					{provider: null, extractionProvider: "unpdf", outcome: "failed", error: "PDF unpdf extraction failed"},
				]);
		});
	}
}

for (const outcome of ["success", "failure"]) {
	test(`extractContent negotiated PDF ${outcome} after the retry deadline remains terminal`, () => {
		const {result, calls} = run({
			shortMarkdown: true, pdf: true, invalidPdf: outcome === "failure", pdfEndpointDeadline: outcome,
			options: {provider: "auto", timeoutMs: 100},
			config: {pdf: {provider: "endpoint", endpointUrl: "http://127.0.0.1:9/parse"}},
		});
		assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://example.com/page", "http://127.0.0.1:9/parse"]);
		assert.equal(result.error, "The operation was aborted.");
		assert.equal(result.content, "");
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, outcome === "success"
			? [{provider: null, extractionProvider: "endpoint", outcome: "succeeded"}]
			: [
				{provider: null, extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed"},
				{provider: null, extractionProvider: "unpdf", outcome: "failed", error: "PDF unpdf extraction failed"},
			]);
	});
}

test("extractContent outer Markdown deadline blocks web fallback after an on-time PDF retry success", () => {
	const {result, calls} = run({
		shortMarkdown: true, markdownBodyDeadline: true, pdf: true,
		options: {provider: "auto", timeoutMs: 100},
		config: {pdf: {provider: "endpoint", endpointUrl: "http://127.0.0.1:9/parse"}},
	});
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://example.com/page", "http://127.0.0.1:9/parse"]);
	assert.equal(result.error, "The operation was aborted.");
	assert.equal(result.content, "");
	assert.equal(result.provider, null);
	assert.deepEqual(result.attempts, [{provider: null, extractionProvider: "endpoint", outcome: "succeeded"}]);
});

test("extractContent caller cancellation takes precedence over a PDF deadline without hosted fallback", () => {
	const {result, calls} = run({
		pdf: true, pdfEndpointDeadline: "success", cancelAtPdfEndpoint: true,
		options: {provider: "tavily", timeoutMs: 100},
		config: {pdf: {provider: "endpoint", endpointUrl: "http://127.0.0.1:9/parse"}, tavilyApiKey: "synthetic-key"},
	});
	assert.equal(result.error, "Aborted");
	assert.equal(result.content, "");
	assert.equal(result.provider, null);
	assert.ok(result.attempts.every(attempt => attempt.provider === null && attempt.extractionProvider === "endpoint"));
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "http://127.0.0.1:9/parse"]);
});

test("extractContent pinned PaddleOCR failure keeps safe actual attempts without restarting PDF or ordinary extraction", () => {
	const {result, calls} = run({pdf: true, options: {provider: "tavily"}, config: {pdf: {provider: "paddleocr"}, paddleocrApiKey: "synthetic-paddle-key", tavilyApiKey: "synthetic-key"}});
	assert.equal(result.provider, null);
	assert.match(result.error, /PaddleOCR.*HTTP 503/);
	assert.match(result.error, /fallback.*size/i);
	assert.deepEqual(result.attempts, [{provider: null, extractionProvider: "paddleocr", outcome: "failed", error: "PDF paddleocr extraction failed"}]);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"]);
});


test("extractContent auto accepts declared-link partial content from its single HTTP attempt after later failures", () => {
	const {result, calls} = run({thin: true, declared: true, failJina: true, config: {fetchRouting: {providers: ["jina", "http"], allowRemoteHostedProviders: true}}});
	assert.equal(result.error, null);
	assert.match(result.content, /Declared links/);
	assert.equal(result.provider, "http");
	assert.deepEqual(result.attempts, [
		{provider: "http", outcome: "succeeded"},
		{provider: "jina", outcome: "failed", error: "jina extraction failed"},
	]);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://r.jina.ai/https://example.com/page"]);
});

test("extractContent ordinary provider configuration failures stop routing without invented invocations", () => {
	for (const providerConfig of [
		{firecrawlBaseUrl: "file:///invalid"},
		{firecrawlBaseUrl: "https://firecrawl.example", firecrawlApiVersion: "invalid"},
	]) {
		const {result, calls} = run({thin: true, config: {...providerConfig, fetchRouting: {providers: ["firecrawl", "jina"], allowRemoteHostedProviders: true}}});
		assert.match(result.error, /Invalid Firecrawl|Unsupported Firecrawl/);
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, [{provider: "http", outcome: "failed", error: "HTTP extraction failed"}]);
		assert.deepEqual(calls.map(call => call.url), ["https://example.com/page"]);
	}
});


test("extractContent YouTube and local-video frame handlers report response-only specialized identities", () => {
	for (const localVideo of [false, true]) {
		for (const options of [{frames: 2}, {timestamp: "1"}, {timestamp: "1-10", frames: 2}]) {
			const {result, calls} = run({localVideo, framesRuntime: true, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", options: {provider: "tavily", ...options}});
			assert.equal(result.error, null);
			assert.equal(result.provider, null);
			assert.equal(result.extractionProvider, localVideo ? "local-video" : "youtube");
			assert.deepEqual(result.attempts, [{provider: null, extractionProvider: localVideo ? "local-video" : "youtube", outcome: "succeeded"}]);
			assert.deepEqual(calls, []);
		}
	}
});


test("extractContent local-video analysis reports its actual response-only handler", () => {
	const {result, calls} = run({localVideo: true, options: {provider: "tavily"}, config: {geminiApiKey: "synthetic-gemini-key", image: {enabled: false}}});
	assert.equal(result.error, null);
	assert.equal(result.provider, null);
	assert.equal(result.extractionProvider, "local-video");
	assert.deepEqual(result.attempts, [{provider: null, extractionProvider: "local-video", outcome: "succeeded"}]);
	assert.ok(calls.every(call => call.url.startsWith("https://generativelanguage.googleapis.com/")));
});


test("extractContent explicit non-HTTP image discovery never decodes or accepts the HTTP payload", () => {
	const {result, calls, resizeCalls} = run({image: true, options: {provider: "tavily"}, config: {tavilyApiKey: "synthetic-key"}});
	assert.equal(result.error, null);
	assert.equal(result.provider, "tavily");
	assert.equal(result.thumbnail, undefined);
	assert.deepEqual(result.attempts, [{provider: "tavily", outcome: "succeeded"}]);
	assert.equal(resizeCalls, 0);
	assert.deepEqual(calls.map(call => call.url), ["https://example.com/page", "https://api.tavily.com/extract"]);
});

test("extractContent disabled YouTube frame specialization stops before runtime or provider attempts", () => {
	const {result, calls} = run({framesRuntime: true, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", options: {provider: "tavily", frames: 2}, config: {youtube: {enabled: false}}});
	assert.match(result.error, /YouTube.*disabled/);
	assert.equal(result.provider, null);
	assert.deepEqual(result.attempts, []);
	assert.deepEqual(calls, []);
});


test("extractContent permits every known ordinary route explicitly outside its automatic list", () => {
	for (const [provider, config] of [
		["jina", {}],
		["crawl4ai", {crawl4aiBaseUrl: "https://crawl4ai.example"}],
		["tinyfish", {tinyfishApiKey: "synthetic-key"}],
		["search1api", {search1apiApiKey: "synthetic-key"}],
		["querit", {queritApiKey: "synthetic-key"}],
		["kagi", {kagiApiKey: "synthetic-key"}],
		["ollama", {ollamaApiKey: "synthetic-key"}],
		["parallel", {parallelApiKey: "synthetic-key"}],
		["parallel-mcp", {}],
		["brightdata", {brightdataApiKey: "synthetic-key", brightdataUnlockerZone: "synthetic-zone"}],
		["gemini", {geminiApiKey: "synthetic-key"}],
	]) {
		const {result, calls} = run({options: {provider}, config: {...config, fetchRouting: {providers: ["http"], allowRemoteHostedProviders: true}}});
		assert.equal(result.error, null, provider);
		assert.equal(result.provider, provider);
		assert.deepEqual(result.attempts, [{provider, outcome: "succeeded"}]);
		assert.equal(calls.filter(call => call.url === "https://example.com/page").length, 1);
	}
});

test("extractContent direct images remain HTTP extractions in auto and explicit HTTP modes", () => {
	for (const provider of ["auto", "http"]) {
		const {result, calls, resizeCalls} = run({image: true, options: {provider}});
		assert.equal(result.error, null);
		assert.equal(result.provider, "http");
		assert.equal(result.extractionProvider, undefined);
		assert.equal(result.mimeType, "image/png");
		assert.deepEqual(result.attempts, [{provider: "http", outcome: "succeeded"}]);
		assert.equal(resizeCalls, 1);
		assert.equal(calls.length, 1);
	}
});

test("extractContent disabled image, invalid frame timestamps, and unavailable local analysis do not invent attempts", () => {
	for (const scenario of [
		{image: true, config: {image: {enabled: false}}},
		{framesRuntime: true, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", options: {timestamp: "invalid"}},
		{framesRuntime: true, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", options: {timestamp: "61"}},
		{localVideo: true},
		{localVideo: true, config: {video: {maxSizeMB: 0.000001}}},
	]) {
		const {result} = run(scenario);
		assert.ok(result.error);
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, []);
	}
});


test("extractContent failed transport for a known PDF cannot bypass PDF limits through URL-only web extraction", () => {
	for (const scenario of [{pdfHttpError: true}, {discoveryError: true, url: "https://example.com/report.pdf"}]) {
		const {result, calls} = run({...scenario, options: {provider: "tavily"}, config: {tavilyApiKey: "synthetic-key"}});
		assert.ok(result.error);
		assert.match(result.error, /PDF.*(?:bytes|size)/);
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, []);
		assert.equal(calls.length, 1);
		assert.doesNotMatch(JSON.stringify(result), /private-transport-secret|Authorization|Bearer/);
	}
});

test("extractContent rejects non-HTTP remote protocols before any routing attempt", () => {
	for (const provider of ["auto", "tavily"]) {
		const {result, calls} = run({url: "ftp://example.com/document", options: {provider}, config: {tavilyApiKey: "synthetic-key"}});
		assert.match(result.error, /Only HTTP and HTTPS/);
		assert.equal(result.provider, null);
		assert.deepEqual(result.attempts, []);
		assert.deepEqual(calls, []);
	}
});

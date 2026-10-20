import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const coreUrl = new URL("../web-tool-core.ts", import.meta.url).href;
const fixtureUrl = new URL("./pdf-fixture.mjs", import.meta.url).href;
const indexUrl = new URL("../index.ts", import.meta.url).href;
const mcpUrl = new URL("../mcp-server.ts", import.meta.url).href;

// Real files, shared execution and PDF processing; no internal-module mocks.
function run(scenario = {}) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^(PI_|GOOGLE|GEMINI|PDF_ENDPOINT|PADDLEOCR|DATALAB|TAVILY|CLOUDFLARE)|(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(key)) delete env[key];
	}
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
		env,
		input: `
			import fs, { appendFile, mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
			import { syncBuiltinESMExports } from 'node:module';
			import dns from 'node:dns/promises';
			dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
			import { pathToFileURL } from 'node:url';
			import { tmpdir } from 'node:os';
			import { join } from 'node:path';
			const s = ${JSON.stringify(scenario)};
			const root = await mkdtemp(join(tmpdir(), 'local-pdf-fetch-'));
			for (const key of ['HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) process.env[key] = root;
			const work = join(root, 'work');
			await mkdir(work);
			process.chdir(work);
			await writeFile(join(root, 'web-search.json'), JSON.stringify({
				pdf: { provider: 'unpdf' }, ...s.config,
			}));
			const { makePdf } = await import(${JSON.stringify(fixtureUrl)});
			const path = join(work, 'report.PDF');
			const bytes = new Uint8Array(makePdf('Local PDF source content', s.pages ?? 1));
			await writeFile(path, bytes);
			await writeFile(join(root, 'outside.pdf'), bytes);
			await writeFile(join(work, 'Team\\u202freport.pdf'), bytes);
			await symlink(join(root, 'outside.pdf'), join(work, 'linked.pdf'));
			await mkdir(join(work, 'directory.pdf'));
			await writeFile(join(work, 'unreadable.pdf'), bytes);
			await writeFile(join(work, 'document'), bytes);
			await writeFile(join(work, 'document.txt'), bytes);
			await writeFile(join(work, 'invalid.pdf'), 'Not a PDF document');
			const realOpen = fs.open;
			fs.open = async (file, ...args) => {
				if (String(file).endsWith('/unreadable.pdf')) throw Object.assign(new Error('Synthetic file permission denial'), { code: 'EACCES' });
				const handle = await realOpen(file, ...args);
				if (s.readFailure && file === path) handle.read = async () => { throw Object.assign(new Error('Synthetic read failure'), { code: 'EIO' }); };
				if (s.grow && file === path) {
					const realStat = handle.stat.bind(handle);
					handle.stat = async () => { const stat = await realStat(); await appendFile(file, new Uint8Array(2048)); return stat; };
				}
				return handle;
			};
			syncBuiltinESMExports();
			const inputs = {
				absolute: path, relative: './report.PDF', parent: '../outside.pdf',
				uri: pathToFileURL(path).href, encoded: pathToFileURL(join(work, 'Team\\u202freport.pdf')).href,
				symlink: './linked.pdf', spaces: './Team report.pdf',
				missing: './missing.pdf', directory: './directory.pdf', unreadable: './unreadable.pdf',
				bare: 'report.PDF', tilde: '~/report.PDF', extensionless: './document', other: './document.txt', invalid: './invalid.pdf',
				malformed: 'file:///%zz.pdf', remote: 'https://93.184.216.34/page', remotePdf: 'https://93.184.216.34/remote.pdf',
			};
			const input = inputs[s.input ?? 'absolute'];
			const calls = [], uploads = [], answers = [];
			const controller = new AbortController();
			if (s.preAbort) controller.abort();
			globalThis.fetch = async (target, init = {}) => {
				const url = String(target);
				calls.push(url);
				if (url === 'https://93.184.216.34/parse') {
					uploads.push({ text: await init.body.get('file').text(), maxPages: init.body.get('max_pages') });
					if (s.abort) { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }
					if (s.unsafeRedirect) return new Response(null, { status: 307, headers: { location: 'http://10.0.0.8/private' } });
					if (s.endpointFailure) return new Response('synthetic-provider-secret', { status: 503 });
					return Response.json({ markdown: '# Parsed\\n\\nRemote PDF engine content', pages: 2 });
				}
				if (url === inputs.remote) return new Response('Remote page source content. '.repeat(30), { headers: { 'content-type': 'text/plain' } });
				if (url === inputs.remotePdf) return new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
				if (url.startsWith('https://paddleocr.aistudio-app.com/')) return new Response('synthetic-provider-secret', { status: 503 });
				throw new Error('Unexpected external HTTP request');
			};
			try {
				const { createStandaloneWebToolCore } = await import(${JSON.stringify(coreUrl)});
				const core = createStandaloneWebToolCore();
				const params = { ...(s.inputs ? { urls: s.inputs.map(name => inputs[name]) } : { url: input }), ...s.params };
				let result, retrieved, schema;
				if (s.host === 'pi') {
					const { default: initialize } = await import(${JSON.stringify(indexUrl)});
					const tools = [];
					initialize({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
					const tool = tools.find(t => t.name === 'fetch_content');
					const model = { provider: 'answer-fixture', id: 'answer-model', api: 'fixture-api', input: ['text'], contextWindow: 32000 };
					const ctx = { model, scopedModels: [], modelRegistry: {
						getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'synthetic-answer-key' }),
						complete: async (_model, context) => {
							answers.push(context.messages[0].content[0].text);
							if (s.answerFailure) throw new Error('Synthetic answer failure');
							return { stopReason: 'stop', content: [{ type: 'text', text: 'Answer about the local PDF.' }] };
						},
					} };
					result = await tool.execute('fetch', params, controller.signal, undefined, ctx);
					if (result.details.responseId) retrieved = await tools.find(t => t.name === 'get_search_content').execute('read', { responseId: result.details.responseId, urlIndex: 0 });
				} else if (s.host === 'mcp') {
					const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
					const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
					const { createMcpServer } = await import(${JSON.stringify(mcpUrl)});
					const server = createMcpServer(core, { name: 'test', version: '0' });
					const client = new Client({ name: 'test', version: '0' });
					const [a, b] = InMemoryTransport.createLinkedPair();
					await Promise.all([server.connect(b), client.connect(a)]);
					schema = (await client.listTools()).tools.find(t => t.name === 'fetch_content');
					result = await client.callTool({ name: 'fetch_content', arguments: params });
					await client.close(); await server.close();
				} else result = await core.fetchContent(params, controller.signal);
				const source = result.structuredContent?.urls[0];
				const savedPath = source?.content?.match(/^PDF extracted and saved to: (.+)/)?.[1];
				const saved = savedPath ? await readFile(savedPath, 'utf8') : undefined;
				console.log(JSON.stringify({ result, calls, uploads, answers, retrieved, schema, path: input, saved }));
			} finally { process.chdir('/'); await rm(root, { recursive: true, force: true }); }
		`,
	});
	assert.equal(child.status, 0, child.stderr || child.error?.message);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("HTTP cookie authentication does not process local PDF files", () => {
	const { result, calls } = run({
		input: "uri", params: { auth: "work" }, config: { authFetch: { work: ["example.com"] } },
	});
	const source = result.structuredContent.urls[0];
	assert.match(source.error, /Only HTTP and HTTPS URLs can be fetched remotely/);
	assert.deepEqual(source.attempts, []);
	assert.deepEqual(calls, []);
});

test("distinct local PDF filenames retain source-derived titles and separate saved Markdown paths", () => {
	const { result, saved } = run({ inputs: ["relative", "parent"] });
	const [report, outside] = result.structuredContent.urls;
	assert.equal(report.error, null);
	assert.equal(outside.error, null);
	assert.match(report.title, /report/i);
	assert.match(outside.title, /outside/i);
	assert.notEqual(report.content.match(/saved to: (.+)/)[1], outside.content.match(/saved to: (.+)/)[1]);
	assert.match(saved, /> Source: file:\/\//);
});

test("local PDF recognition does not expand to bare names, tilde paths or arbitrary local files", () => {
	for (const input of ["bare", "tilde", "extensionless", "other", "malformed"]) {
		const { result, calls } = run({ input });
		const source = result.structuredContent.urls[0];
		assert.ok(source.error, input);
		assert.deepEqual(source.attempts, []);
		assert.deepEqual(calls, []);
	}
});

test("local PDF specialization ignores unused ordinary credentials and video processing settings", () => {
	for (const provider of [undefined, "auto", "http", "tavily"]) {
		const { result, calls } = run({
			params: { ...(provider ? { provider } : {}), redirects: "same-origin" },
			config: {
				tavilyApiKey: "$LOCAL_PDF_UNSET_CREDENTIAL",
				fetchRouting: { providers: ["tavily"], allowRemoteHostedProviders: false },
				video: { enabled: false, maxSizeMB: 0.0001 },
			},
		});
		const source = result.structuredContent.urls[0];
		assert.equal(source.error, null);
		assert.equal(source.provider, null);
		assert.deepEqual(source.attempts, [{ provider: null, extractionProvider: "unpdf", outcome: "succeeded" }]);
		assert.deepEqual(calls, []);
	}
});

test("local PDFs retain the configured PDF page-processing limit", () => {
	const { result, saved } = run({ pages: 3, config: { pdf: { provider: "unpdf", maxPages: 1 } } });
	assert.equal(result.structuredContent.urls[0].error, null);
	assert.match(saved, /Pages: 3 \(extracted first 1\)/);
	assert.match(saved, /Only first 1 of 3 pages extracted/);
	assert.equal(saved.match(/Local PDF source content/g).length, 1);
	assert.doesNotMatch(saved, /<!-- Page [23] -->/);
});

test("a configured remote PDF engine receives local bytes and the PDF page cap, not a source URL fetch", () => {
	const { result, calls, uploads, saved } = run({
		params: { provider: "tavily" },
		config: { pdf: { provider: "endpoint", endpointUrl: "https://93.184.216.34/parse", maxPages: 2 } },
	});
	const source = result.structuredContent.urls[0];
	assert.equal(source.error, null);
	assert.equal(source.provider, null);
	assert.equal(source.extractionProvider, "endpoint");
	assert.deepEqual(source.attempts, [{ provider: null, extractionProvider: "endpoint", outcome: "succeeded" }]);
	assert.deepEqual(calls, ["https://93.184.216.34/parse"]);
	assert.equal(uploads[0].maxPages, "2");
	assert.match(uploads[0].text, /^%PDF-1\.4/);
	assert.match(uploads[0].text, /Local PDF source content/);
	assert.match(saved, /Remote PDF engine content/);
});

test("recoverable local PDF engine errors preserve the existing PDF fallback chain", () => {
	const { result, calls } = run({
		endpointFailure: true,
		config: { pdf: { provider: "auto", endpointUrl: "https://93.184.216.34/parse" } },
	});
	const source = result.structuredContent.urls[0];
	assert.equal(source.error, null);
	assert.equal(source.extractionProvider, "unpdf");
	assert.deepEqual(source.attempts, [
		{ provider: null, extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed" },
		{ provider: null, extractionProvider: "unpdf", outcome: "succeeded" },
	]);
	assert.deepEqual(calls, ["https://93.184.216.34/parse"]);
	assert.doesNotMatch(JSON.stringify(result), /synthetic-provider-secret/);
});

test("local PDF engine safety refusals are terminal before and after actual submission", () => {
	for (const afterSubmission of [false, true]) {
		const { result, calls } = run({
			unsafeRedirect: afterSubmission,
			config: { pdf: { provider: "auto", endpointUrl: afterSubmission ? "https://93.184.216.34/parse" : "http://10.0.0.8/parse" } },
		});
		const source = result.structuredContent.urls[0];
		assert.match(source.error, /Blocked internal address/);
		assert.equal(source.extractionProvider, undefined);
		assert.deepEqual(source.attempts, afterSubmission ? [{ provider: null, extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed" }] : []);
		assert.deepEqual(calls, afterSubmission ? ["https://93.184.216.34/parse"] : []);
	}
});

test("local PDF cancellation retains only actual PDF engine invocations", () => {
	for (const preAbort of [true, false]) {
		const { result, calls } = run({
			preAbort, abort: !preAbort,
			config: { pdf: { provider: "auto", endpointUrl: "https://93.184.216.34/parse" } },
		});
		const source = result.structuredContent.urls[0];
		assert.match(source.error, /Aborted/);
		assert.equal(source.extractionProvider, undefined);
		assert.deepEqual(source.attempts, preAbort ? [] : [{ provider: null, extractionProvider: "endpoint", outcome: "failed", error: "PDF endpoint extraction failed" }]);
		assert.deepEqual(calls, preAbort ? [] : ["https://93.184.216.34/parse"]);
	}
});

test("local PDF processing-limit and configuration failures do not invent engine attempts", () => {
	for (const [scenario, error] of [
		[{ pages: 1001, config: { pdf: { provider: "paddleocr", maxPages: 1001 }, paddleocrApiKey: "synthetic-paddle-key" } }, /PaddleOCR requires 1-1000 selected pages/],
		[{ config: { pdf: { provider: "endpoint" } } }, /PDF provider "endpoint" requires/],
		[{ config: { pdf: { provider: "paddleocr" }, paddleocrApiKey: "$LOCAL_PDF_UNSET_CREDENTIAL" } }, /credential resolution failed/i],
	]) {
		const { result, calls } = run(scenario);
		const source = result.structuredContent.urls[0];
		assert.match(source.error, error);
		assert.deepEqual(source.attempts, []);
		assert.deepEqual(calls, []);
	}
});

test("invalid local PDFs remain terminal PDF failures rather than ordinary web content", () => {
	const { result, calls } = run({ input: "invalid", params: { provider: "tavily" } });
	const source = result.structuredContent.urls[0];
	assert.match(source.error, /PDF extraction failed: unpdf extraction failed/);
	assert.deepEqual(source.attempts, [{ provider: null, extractionProvider: "unpdf", outcome: "failed", error: "PDF unpdf extraction failed" }]);
	assert.deepEqual(calls, []);
});

test("Pi answers use local PDF Markdown and preserve stored originals and extraction provenance", () => {
	const { result, answers, retrieved, calls } = run({
		host: "pi", params: { mode: "answer", prompt: "What does the PDF say?", provider: "tavily" },
	});
	const source = result.structuredContent.urls[0];
	assert.equal(source.error, null);
	assert.equal(source.content, "Answer about the local PDF.");
	assert.equal(source.provider, null);
	assert.equal(source.extractionProvider, "unpdf");
	assert.deepEqual(source.attempts, [{ provider: null, extractionProvider: "unpdf", outcome: "succeeded" }]);
	assert.equal(answers.length, 1);
	assert.match(answers[0], /Local PDF source content/);
	assert.doesNotMatch(answers[0], /PDF extracted and saved to/);
	assert.match(retrieved.content[0].text, /Local PDF source content/);
	assert.doesNotMatch(retrieved.content[0].text, /Answer about the local PDF/);
	assert.deepEqual(calls, []);
});

test("a local PDF answer failure does not rewrite source extraction success", () => {
	const { result, retrieved } = run({ host: "pi", answerFailure: true, params: { mode: "answer", prompt: "Summarize the PDF" } });
	const source = result.structuredContent.urls[0];
	assert.match(source.error, /Page answer failed: Synthetic answer failure/);
	assert.equal(source.extractionProvider, "unpdf");
	assert.deepEqual(source.attempts, [{ provider: null, extractionProvider: "unpdf", outcome: "succeeded" }]);
	assert.match(retrieved.content[0].text, /Local PDF source content/);
});

test("MCP reads server-side local PDFs through shared execution without changing wire presentation", () => {
	const { result, calls, schema } = run({ host: "mcp", input: "relative" });
	assert.equal(result.isError, undefined);
	assert.equal(result.structuredContent, undefined);
	assert.equal(result.details, undefined);
	assert.match(result.content[0].text, /^PDF extracted and saved to:/);
	assert.equal(schema.inputSchema.properties.url.type, "string");
	assert.doesNotMatch(JSON.stringify(result.content), /extractionProvider|"attempts"/);
	assert.deepEqual(calls, []);
});

test("local and remote PDF/page batches keep per-source results and actual attempts independent", () => {
	const { result, calls } = run({ inputs: ["relative", "remote", "remotePdf", "missing"], params: { provider: "http" } });
	const [local, page, remote, missing] = result.structuredContent.urls;
	assert.equal(local.error, null);
	assert.equal(local.extractionProvider, "unpdf");
	assert.deepEqual(local.attempts, [{ provider: null, extractionProvider: "unpdf", outcome: "succeeded" }]);
	assert.equal(page.error, null);
	assert.equal(page.provider, "http");
	assert.deepEqual(page.attempts, [{ provider: "http", outcome: "succeeded" }]);
	assert.equal(remote.error, null);
	assert.equal(remote.provider, null);
	assert.deepEqual(remote.attempts, [{ provider: null, extractionProvider: "unpdf", outcome: "succeeded" }]);
	assert.match(missing.error, /not found/);
	assert.deepEqual(missing.attempts, []);
	assert.equal(result.details.successful, 3);
	assert.deepEqual(calls.sort(), ["https://93.184.216.34/page", "https://93.184.216.34/remote.pdf"]);
});

test("local PDF read failures remain a file-access preflight error", () => {
	const { result, calls } = run({ readFailure: true });
	const source = result.structuredContent.urls[0];
	assert.match(source.error, /Local PDF.*unreadable.*EIO/);
	assert.deepEqual(source.attempts, []);
	assert.deepEqual(calls, []);
});

test("local PDF input limits also bound files that grow after metadata inspection", () => {
	const { result, calls } = run({ grow: true, config: { pdf: { provider: "unpdf", maxSizeMB: 0.001 } } });
	const source = result.structuredContent.urls[0];
	assert.match(source.error, /pdf.maxSizeMB/);
	assert.deepEqual(source.attempts, []);
	assert.deepEqual(calls, []);
});

test("local PDFs reject raw mode and active video-only options without invoking a PDF engine", () => {
	for (const [params, error] of [
		[{ mode: "raw" }, /Unsupported content type in raw mode: application\/pdf/],
		[{ model: "video-model" }, /model only works with YouTube and local video/],
		[{ frames: 2 }, /Frame extraction only works/],
		[{ timestamp: "1" }, /Timestamp extraction only works/],
		[{ forceClone: true }, /forceClone only works with GitHub/],
	]) {
		const { result, calls } = run({ params });
		const source = result.structuredContent.urls[0];
		assert.match(source.error, error);
		assert.deepEqual(source.attempts, []);
		assert.deepEqual(calls, []);
	}
});

test("local PDF strict-engine failures are sanitized, terminal and retain actual attempts", () => {
	const { result, calls } = run({
		params: { provider: "tavily" },
		config: { pdf: { provider: "paddleocr" }, paddleocrApiKey: "synthetic-paddle-key" },
	});
	const source = result.structuredContent.urls[0];
	assert.match(source.error, /PDF extraction failed: PaddleOCR HTTP 503 extraction failed/);
	assert.doesNotMatch(JSON.stringify(result), /synthetic-provider-secret|synthetic-paddle-key/);
	assert.equal(source.provider, null);
	assert.equal(source.extractionProvider, undefined);
	assert.deepEqual(source.attempts, [{ provider: null, extractionProvider: "paddleocr", outcome: "failed", error: "PDF paddleocr extraction failed" }]);
	assert.equal(calls.length, 1);
	assert.match(calls[0], /^https:\/\/paddleocr.aistudio-app.com\//);
});

test("local PDF preflight fails clearly without invoking any extraction engine", () => {
	for (const [scenario, error] of [
		[{ config: { pdf: { provider: "unpdf", enabled: false } } }, /PDF extraction is disabled/],
		[{ config: { pdf: { provider: "unpdf", maxSizeMB: 0.0001 } } }, /pdf.maxSizeMB/],
		[{ input: "missing" }, /not found|ENOENT|unreadable/i],
		[{ input: "directory" }, /regular file/i],
		[{ input: "unreadable" }, /unreadable|EACCES|permission/i],
	]) {
		const { result, calls } = run(scenario);
		const source = result.structuredContent.urls[0];
		assert.match(source.error, error);
		assert.equal(source.provider, null);
		assert.equal(source.extractionProvider, undefined);
		assert.deepEqual(source.attempts, []);
		assert.deepEqual(calls, []);
	}
});

test("local PDF sources match video path forms, symlinks and normalized-space resolution", () => {
	for (const input of ["relative", "parent", "uri", "encoded", "symlink", "spaces"]) {
		const { result, calls, path, saved } = run({ input });
		const source = result.structuredContent.urls[0];
		assert.equal(source.error, null, `${input}: ${source.error}`);
		assert.equal(source.url, path);
		assert.equal(source.extractionProvider, "unpdf");
		assert.match(saved, /Local PDF source content/);
		assert.deepEqual(calls, []);
	}
});

test("shared fetch_content extracts a local PDF source and saves the existing Markdown result", () => {
	const { result, calls, path, saved } = run();
	const source = result.structuredContent.urls[0];
	assert.equal(source.error, null);
	assert.equal(source.url, path);
	assert.equal(source.provider, null);
	assert.equal(source.extractionProvider, "unpdf");
	assert.deepEqual(source.attempts, [{ provider: null, extractionProvider: "unpdf", outcome: "succeeded" }]);
	assert.match(source.content, /PDF extracted and saved to:.*\n\nPages: 1\nCharacters: \d+/);
	assert.match(saved, /Local PDF source content/);
	assert.match(saved, /^# .+\n\n> Source: /);
	assert.deepEqual(calls, []);
});

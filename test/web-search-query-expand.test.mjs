import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const coreUrl = new URL("../web-tool-core.ts", import.meta.url).href;
const mcpUrl = new URL("../mcp-server.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"XCRAWL_API_KEY",
		"OPENAI_API_KEY",
		"BRAVE_API_KEY",
		"PARALLEL_API_KEY",
		"TINYFISH_API_KEY",
		"TAVILY_API_KEY",
		"JINA_API_KEY",
		"EXA_API_KEY",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

async function setupHome() {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-317-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({ xcrawlApiKey: "xc-test-key" }) + "\n", "utf8");
	return home;
}

// Runs web_search with the given params and returns the result plus queries XCrawl received.
function runWebSearch(home, params, host = "pi") {
	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (url, init) => {
			if (String(url) !== "https://run.xcrawl.com/v1/serp") throw new Error("Unexpected external HTTP destination");
			let q = null;
			try { q = JSON.parse(init.body).q; } catch {}
			requests.push({ url: String(url), q });
			return new Response(JSON.stringify({
				search_metadata: { status: "completed" },
				total_credits_used: 1,
				organic_results: [
					{ position: 1, title: "R1", link: "https://example.com/1", snippet: "s1" },
					{ position: 2, title: "R2", link: "https://example.com/2", snippet: "s2" },
				],
			}), { status: 200 });
		};
		const params = ${JSON.stringify(params)};
		const host = ${JSON.stringify(host)};
		let result, rendered;
		if (host === "pi") {
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			const tools = [];
			initializeExtension({
				registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {},
				on() {}, appendEntry() {}, sendMessage() {}, exec() { return { code: 0 }; },
			});
			const webSearch = tools.find(tool => tool.name === "web_search");
			const prepared = webSearch.prepareArguments ? webSearch.prepareArguments(params) : params;
			result = await webSearch.execute("call", prepared);
			rendered = webSearch.renderCall(prepared, { fg: (_kind, text) => text, bold: text => text }).render(120).join("\\n");
		} else {
			const { createStandaloneWebToolCore } = await import(${JSON.stringify(coreUrl)});
			const core = createStandaloneWebToolCore();
			if (host === "mcp") {
				const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
				const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
				const { createMcpServer } = await import(${JSON.stringify(mcpUrl)});
				const server = createMcpServer(core, { name: "query-probe", version: "0" });
				const client = new Client({ name: "query-probe", version: "0" });
				const [a, b] = InMemoryTransport.createLinkedPair();
				await Promise.all([server.connect(b), client.connect(a)]);
				try {
					const { workflow: _workflow, ...args } = params;
					result = await client.callTool({ name: "web_search", arguments: args });
				} finally { await client.close(); await server.close(); }
			} else result = await core.webSearch(params);
		}
		const queries = requests
			.filter((request) => request.url === "https://run.xcrawl.com/v1/serp")
			.map((request) => request.q);
		console.log(JSON.stringify({ result, queries, rendered }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

function capturedQueries(home, params) {
	return runWebSearch(home, params).queries;
}

test("web_search uses a valid query when queries is an empty array", async () => {
	const home = await setupHome();
	const { result, queries } = runWebSearch(home, {
		query: "single query survives", queries: [], provider: "xcrawl", workflow: "none", numResults: 2,
	});
	assert.deepEqual(queries, ["single query survives"]);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.queryCount, 1);
});

test("Pi normalizes empty plural inputs before falling back and renders the effective query", async () => {
	const home = await setupHome();
	for (const plural of [[], [""], [" ", "\t"], "[]", '[" "]']) {
		const { result, queries, rendered } = runWebSearch(home, {
			query: "single query survives", queries: plural, provider: "xcrawl", workflow: "none",
		});
		assert.deepEqual(queries, ["single query survives"]);
		assert.equal(result.details.queryCount, 1);
		assert.match(rendered, /single query survives/);
		assert.doesNotMatch(rendered, /no query/);
	}
	const expanded = runWebSearch(home, { query: '["alpha", "beta"]', queries: [], provider: "xcrawl", workflow: "none" });
	assert.deepEqual(expanded.queries, ["alpha", "beta"]);
	assert.equal(expanded.result.details.queryCount, 2);
});

test("meaningful plural queries keep precedence and wholly empty inputs keep the no-query error", async () => {
	const home = await setupHome();
	for (const host of ["pi", "core", "mcp"]) {
		const valid = runWebSearch(home, { query: "ignored singular", queries: [" ", " plural wins "], provider: "xcrawl", workflow: "none" }, host);
		assert.deepEqual(valid.queries, ["plural wins"]);
		assert.notEqual(valid.result.isError, true);
		const empty = runWebSearch(home, { query: " ", queries: [""], provider: "xcrawl", workflow: "none" }, host);
		assert.deepEqual(empty.queries, []);
		assert.match(empty.result.content[0].text, /No query provided/);
	}
});

test("shared execution and real MCP calls fall back to query for empty and blank queries", async () => {
	const home = await setupHome();
	for (const host of ["core", "mcp"]) {
		for (const plural of [[], [" "]]) {
			const { result, queries } = runWebSearch(home, { query: "fallback query", queries: plural, provider: "xcrawl", workflow: "none" }, host);
			assert.deepEqual(queries, ["fallback query"]);
			assert.notEqual(result.isError, true);
			assert.match(result.content[0].text, /R1/);
		}
	}
	const invalid = runWebSearch(home, { query: ["wrong type"], queries: [], provider: "xcrawl" }, "mcp");
	assert.equal(invalid.result.isError, true);
	assert.match(invalid.result.content[0].text, /Invalid arguments.*web_search/);
	assert.deepEqual(invalid.queries, []);
});

test("web_search expands a JSON-array string in query into separate searches", async () => {
	const home = await setupHome();
	// What a small/local model actually sends: the queries array serialized as
	// a JSON string inside the single-string `query` field.
	const queries = capturedQueries(home, {
		query: '["AGP version", "Compose BOM", "CameraX"]',
		provider: "xcrawl",
		workflow: "none",
		numResults: 2,
	});
	assert.deepEqual(queries, ["AGP version", "Compose BOM", "CameraX"]);
});

test("web_search keeps mixed JSON arrays in query as a single literal query", async () => {
	const home = await setupHome();
	const queries = capturedQueries(home, {
		query: '["AGP version", 5]',
		provider: "xcrawl",
		workflow: "none",
		numResults: 2,
	});
	// Not an unambiguous string array — keep it verbatim rather than silently
	// dropping the non-string member.
	assert.deepEqual(queries, ['["AGP version", 5]']);
});

test("web_search does not reinterpret already-structured queries entries", async () => {
	const home = await setupHome();
	const queries = capturedQueries(home, {
		queries: ['["AGP version", "Compose BOM"]'],
		provider: "xcrawl",
		workflow: "none",
		numResults: 2,
	});
	// The plural `queries` field is already structured — expansion stays scoped
	// to the malformed singular `query` field.
	assert.deepEqual(queries, ['["AGP version", "Compose BOM"]']);
});

test("web_search reports the existing no-query error for empty JSON-array strings", async () => {
	const home = await setupHome();
	for (const query of ["[]", '["   "]']) {
		const { result, queries } = runWebSearch(home, {
			query,
			provider: "xcrawl",
			workflow: "none",
			numResults: 2,
		});
		assert.deepEqual(queries, []);
		assert.equal(result.details.error, "No query provided");
		assert.equal(result.content[0].text, "Error: No query provided. Use 'query' or 'queries' parameter.");
	}
});

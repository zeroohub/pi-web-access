import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Value } from "typebox/value";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const originalEnv = { ...process.env };
const root = await mkdtemp(join(tmpdir(), "pi-fetch-provider-registration-"));
process.env.PI_CODING_AGENT_DIR = root;
await writeFile(join(root, "web-search.json"), JSON.stringify({ fetchRouting: { providers: ["http"] } }));
const { createStandaloneWebToolCore } = await import("../web-tool-core.ts");
const { createMcpServer } = await import("../mcp-server.ts");
after(async () => {
	process.env = originalEnv;
	await rm(root, { recursive: true, force: true });
});

test("MCP fetch_content registration accepts scalar providers and rejects invalid selections before extraction", async t => {
	const server = createMcpServer(createStandaloneWebToolCore(), { name: "fetch-provider-test", version: "0.0.0" });
	const client = new Client({ name: "fetch-provider-client", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	t.after(async () => { await client.close(); await server.close(); });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	const schema = tools.find(tool => tool.name === "fetch_content").inputSchema;
	assert.ok(schema.properties.provider, "MCP fetch_content must expose provider");
	assert.deepEqual(schema.properties.provider.enum, ["auto", "http", "firecrawl", "crawl4ai", "jina", "tinyfish", "search1api", "querit", "kagi", "ollama", "parallel", "parallel-mcp", "brightdata", "gemini", "tavily"]);
	assert.match(schema.properties.provider.description, /specialized.*first/i);
	assert.match(schema.properties.provider.description, /HTTP-first/);
	assert.equal(Value.Check(schema, { url: "https://example.com" }), true);
	for (const provider of schema.properties.provider.enum) {
		assert.equal(Value.Check(schema, { url: "https://example.com", provider }), true, provider);
	}
	const originalFetch = globalThis.fetch;
	let extractionRequests = 0;
	globalThis.fetch = async () => { extractionRequests++; throw new Error("Unexpected network request"); };
	t.after(() => { globalThis.fetch = originalFetch; });
	for (const provider of ["unknown", "all", "Tavily", " tavily ", "", null, false, 1, {}, [], ["http"], ["http", "tavily"]]) {
		const args = { url: "https://example.com", provider };
		assert.equal(Value.Check(schema, args), false, JSON.stringify(provider));
		const result = await client.callTool({ name: "fetch_content", arguments: args });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Invalid arguments for fetch_content.*\n.*\/provider/);
		assert.equal(result.structuredContent, undefined);
	}
	assert.equal(extractionRequests, 0);
});

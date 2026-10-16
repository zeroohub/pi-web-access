import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;
async function run(scenario = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-tavily-extract-"));
	try {
		await writeFile(join(root, "web-search.json"), JSON.stringify({
			tavilyApiKey: scenario.explicitCredential ? "$MISSING_TAVILY_SECRET" : "standalone-key",
			tavilyBaseUrl: scenario.gateway ? "https://gateway.example/tavily" : undefined,
			fetch: scenario.configTimeout ? { timeout: 0.005 } : undefined,
			fetchRouting: { providers: scenario.defaultRoute ? undefined : (scenario.providers ?? ["tavily", "jina"]), allowRemoteHostedProviders: scenario.optIn ?? true },
			fetchContent: { ...(scenario.deny ? { domainPolicy: { deny: ["example.com"] } } : {}), ...(scenario.configRedirects ? {redirects: scenario.configRedirects} : {}) },
		}));
		const env = { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root };
		for (const key of Object.keys(env)) if (key.startsWith("TAVILY_") || key === "MISSING_TAVILY_SECRET") delete env[key];
		if (scenario.pool) { env.TAVILY_API_KEY_1 = "pool-one"; env.TAVILY_API_KEY_2 = "pool-two"; }
		if (scenario.environmentGateway) env.TAVILY_BASE_URL = "https://env-gateway.example/tavily";
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			encoding: "utf8", env,
			input: `
				const s = ${JSON.stringify(scenario)};
				const calls = [];
				const controller = new AbortController();
				if (s.abort) controller.abort();
				const url = s.private ? 'http://127.0.0.1/private' : 'https://example.com/page';
				globalThis.fetch = async (target, init = {}) => {
					const address = String(target);
					const headers = Object.fromEntries(new Headers(init.headers));
					calls.push({ url: address, headers, body: init.body && JSON.parse(init.body) });
					if (address.endsWith('/extract')) {
						if (s.abortDuring) { controller.abort(); return new Response('limited', {status: 429}); }
						if (s.timeout || s.configTimeout || s.deadlineRetry) {
							await new Promise((resolve) => setTimeout(resolve, s.deadlineRetry ? 35 : 30));
							init.signal.throwIfAborted();
						}
						if (s.redirect && !address.startsWith('https://redirect.example')) return new Response(null, {status: 307, headers: {location: 'https://redirect.example/extract'}});
						if (s.pool && headers.authorization !== 'Bearer standalone-key') return new Response('limited', {status: 429});
						if (s.fail) return new Response('failed standalone-key', {status: 500});
						if (s.malformed) return new Response('not json');
						return Response.json({results: s.empty ? [] : [{url: s.wrongUrl ? 'https://other.example' : url, raw_content: s.blank ? ' ' : '# Tavily page\\n\\nExtracted content.', title: s.invalidTitle ? 123 : 'Tavily page'}]});
					}
					if (address.startsWith('https://r.jina.ai/')) return new Response('Markdown Content:\\n# Jina\\n\\n' + 'Fallback content. '.repeat(30));
					return new Response('blocked', {status: 403});
				};
				const options = { ...(s.redirects ? {redirects: s.redirects} : {}), lookup: async () => [{address: '93.184.216.34', family: 4}], ...(s.timeout ? {timeoutMs: 5} : s.deadlineRetry ? {timeoutMs: 60} : {}) };
				const {extractContent} = await import(${JSON.stringify(extractUrl)});
				const result = await extractContent(url, controller.signal, options);
				console.log(JSON.stringify({calls, result}));
			`,
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim());
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("Tavily fetch route sends basic markdown extraction after HTTP safety gate", async () => {
	const output = await run();
	assert.deepEqual(output.calls.map(c => c.url), ["https://example.com/page", "https://api.tavily.com/extract"]);
	assert.deepEqual(output.calls[1].body, { urls: ["https://example.com/page"], extract_depth: "basic", format: "markdown" });
	assert.equal(output.calls[1].headers.authorization, "Bearer standalone-key");
	assert.equal(output.result.title, "Tavily page");
	assert.equal(output.result.content, "# Tavily page\n\nExtracted content.");
	assert.equal(output.result.error, null);
});

for (const scenario of [{redirects: "follow"}, {configRedirects: "follow"}]) {
	test(`follow permits Tavily extraction without an HTTP route: ${JSON.stringify(scenario)}`, async () => {
		const output = await run({...scenario, providers: ["tavily"]});
		assert.equal(output.result.error, null);
		assert.equal(output.result.title, "Tavily page");
	});
}

test("Tavily extraction accepts content without a valid provider title", async () => {
	const output = await run({invalidTitle: true});
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "");
});

test("Tavily extraction reuses configured gateway and key failover", async () => {
	const output = await run({gateway: true, pool: true});
	const attempts = output.calls.filter(c => c.url.endsWith("/extract"));
	assert.equal(output.result.error, null);
	assert.deepEqual(attempts.map(c => c.headers.authorization), ["Bearer pool-one", "Bearer pool-two", "Bearer standalone-key"]);
	assert.ok(attempts.every(c => c.url === "https://gateway.example/tavily/extract"));
});

test("Tavily extraction honors environment gateway precedence", async () => {
	const output = await run({gateway: true, environmentGateway: true});
	assert.equal(output.result.error, null);
	assert.equal(output.calls[1].url, "https://env-gateway.example/tavily/extract");
});

test("Tavily extraction strips credentials on cross-origin redirect", async () => {
	const output = await run({redirect: true});
	assert.equal(output.result.error, null);
	assert.equal(output.calls[2].url, "https://redirect.example/extract");
	assert.equal(output.calls[2].headers.authorization, undefined);
});

for (const scenario of [{empty: true}, {blank: true}, {wrongUrl: true}, {fail: true}, {malformed: true}]) {
	test(`Tavily fetch continues on unusable extraction: ${JSON.stringify(scenario)}`, async () => {
		const output = await run(scenario);
		assert.equal(output.result.error, null);
		assert.equal(output.result.title, "Jina");
		assert.ok(output.calls.at(-1).url.startsWith("https://r.jina.ai/"));
	});
}

test("Tavily extraction diagnostics redact credentials", async () => {
	const output = await run({fail: true, providers: ["tavily"]});
	assert.match(output.result.error, /Tavily API error 500/);
	assert.ok(!output.result.error.includes("standalone-key"));
});

test("Tavily explicit credential resolution fails closed", async () => {
	const output = await run({explicitCredential: true});
	assert.ok(output.result.error);
	assert.equal(output.calls.length, 1);
});

test("Tavily fetch requires remote hosted opt-in", async () => {
	const output = await run({optIn: false, providers: ["tavily"]});
	assert.equal(output.calls.length, 0);
	assert.match(output.result.error, /Remote hosted fetch providers are disabled/);
});

for (const scenario of [{private: true}, {deny: true}, {abort: true}]) {
	test(`Tavily fetch refuses unsafe or cancelled targets: ${JSON.stringify(scenario)}`, async () => {
		const output = await run(scenario);
		assert.ok(output.result.error);
		assert.equal(output.calls.length, 0);
	});
}

test("Tavily is not used by the default fetch route despite configured credentials", async () => {
	const output = await run({defaultRoute: true});
	assert.equal(output.result.title, "Jina");
	assert.ok(!output.calls.some(c => c.url.endsWith("/extract")));
});

test("Tavily caller cancellation prevents key retries and later providers", async () => {
	const output = await run({abortDuring: true, pool: true});
	assert.match(output.result.error, /Aborted/i);
	assert.equal(output.calls.length, 2);
});

test("Tavily key retries share one fetch deadline", async () => {
	const output = await run({deadlineRetry: true, pool: true, providers: ["tavily"]});
	assert.ok(output.result.error);
	assert.ok(output.calls.length <= 3);
	assert.ok(!output.calls.some(c => c.headers.authorization === "Bearer standalone-key"));
});

test("Tavily extraction honors configured fetch timeout", async () => {
	const output = await run({configTimeout: true, providers: ["tavily"]});
	assert.ok(output.result.error);
	assert.equal(output.calls.length, 2);
});

test("Tavily extraction honors fetch timeout across attempts", async () => {
	const output = await run({timeout: true, pool: true, providers: ["tavily"]});
	assert.ok(output.result.error);
	assert.equal(output.calls.length, 2);
});

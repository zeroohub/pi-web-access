import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../openai-search.ts", import.meta.url).href;
const scenarios = [
	{ name: "unset preserves request", expected: undefined },
	{ name: "standalone high", level: "high", expected: "high" },
	{ name: "standalone minimal", level: "minimal", expected: "minimal" },
	{ name: "standalone low", level: "low", expected: "low" },
	{ name: "standalone off maps to none", level: "off", expected: "none" },
	{ name: "standalone xhigh", level: "xhigh", expected: "xhigh" },
	{ name: "invalid level", level: "none", error: /must be off/ },
	{ name: "null is invalid", level: null, error: /must be off/ },
	{ name: "numeric value is invalid", level: 1, error: /must be off/ },
	{ name: "mapped off is rejected when unsupported", level: "off", map: { off: null }, error: /does not support/ },
	{ name: "unmapped max", level: "max", error: /requires a model thinkingLevelMap/ },
	{ name: "registry custom mapping", level: "max", map: { max: "custom-effort" }, expected: "custom-effort" },
	{ name: "registry disallows level", level: "low", map: { low: null }, error: /does not support/ },
	{ name: "registry requires explicit extended level", level: "xhigh", map: {}, error: /does not support/ },
	{ name: "registry default mapping", level: "medium", map: {}, expected: "medium" },
	{ name: "pinned model uses its own mapping", level: "high", map: { high: "wrong" }, pin: true, expected: "pinned-effort" },
	{ name: "unknown pinned model uses fallback", level: "high", map: { high: "wrong" }, pin: "unknown", expected: "high" },
	{ name: "current model mapping", level: "high", map: { high: "current-effort" }, current: true, expected: "current-effort" },
	{ name: "source check uses Responses thinking", level: "high", map: { high: "check-effort" }, sourceCheck: true, expected: "check-effort" },
	{ name: "non-reasoning model rejects enabled level", level: "high", map: {}, reasoning: false, error: /does not support/ },
	{ name: "standalone credentials retain registry mapping", level: "max", map: { max: "registry-max" }, standaloneRegistry: true, pin: "registered", expected: "registry-max" },
	{ name: "alpha ignores setting", level: "high", alpha: true, expected: undefined },
];
for (const scenario of scenarios) {
	test(`OpenAI search thinking: ${scenario.name}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-search-thinking-"));
		try {
			await writeFile(join(root, "web-search.json"), JSON.stringify({
				openaiApiKey: "test-key", openaiSearchThinkingLevel: scenario.level,
				openaiSearchModel: scenario.pin ? (scenario.pin === true ? "pinned-model" : scenario.pin === "registered" ? "gpt-6" : "unknown") : undefined,
				openaiUseAlphaSearch: scenario.alpha,
			}));
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: root, OPENAI_API_KEY: "" },
				input: `
					const s = ${JSON.stringify(scenario)};
					const requests = [];
					const model = { id: 'gpt-6', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', reasoning: s.reasoning ?? true, thinkingLevelMap: s.map };
					const ctx = s.map ? { model, modelRegistry: {
						getAll: () => [model, { ...model, id: 'pinned-model', thinkingLevelMap: { high: 'pinned-effort' } }],
						getApiKeyAndHeaders: async () => s.standaloneRegistry ? ({ ok: false, error: 'No Pi login' }) : ({ ok: true, apiKey: 'test-key' }),
					} } : undefined;
					globalThis.fetch = async (url, init) => {
						requests.push({url: String(url), body: JSON.parse(init.body)});
						return Response.json(s.alpha ? {output: 'Answer', results: []} : {output: [{type: 'web_search_call'}, {type: 'message', content: [{type:'output_text', text:'Answer'}]}]});
					};
					const mod = await import(${JSON.stringify(moduleUrl)});
					let error;
					try {
						if (s.sourceCheck) {
							const {default: initializeExtension} = await import(${JSON.stringify(new URL('../index.ts', import.meta.url).href)});
							const tools = [];
							initializeExtension({ registerTool: tool => tools.push(tool), registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
							await tools.find(tool => tool.name === 'source_check').execute('call', {claim: 'test claim', provider: 'openai'}, undefined, undefined, ctx);
						} else {
							await mod[s.current ? 'searchWithCurrentModelOpenAI' : 'searchWithOpenAI']('test', {}, ctx);
						}
					} catch (err) { error = err.message; }
					console.log(JSON.stringify({requests, error}));
				`,
			});
			assert.equal(child.status, 0, child.stderr);
			const output = JSON.parse(child.stdout.trim());
			if (scenario.error) {
				assert.match(output.error, scenario.error);
				assert.equal(output.requests.length, 0);
			} else {
				assert.equal(output.error, undefined);
				assert.equal(output.requests.length, 1);
				assert.deepEqual(output.requests[0].body.reasoning, scenario.expected ? { effort: scenario.expected } : undefined);
				assert.equal(output.requests[0].url.endsWith(scenario.alpha ? '/alpha/search' : '/responses'), true);
			}
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}

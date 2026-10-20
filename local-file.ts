import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The explicit local input forms accepted by video and PDF extraction. */
export function parseLocalFilePath(input: string): string | null {
	if (input.startsWith("file://")) {
		try {
			return decodeURIComponent(new URL(input).pathname);
		} catch {
			return null;
		}
	}
	return input.startsWith("/") || input.startsWith("./") || input.startsWith("../") ? input : null;
}

export function resolveLocalFilePath(filePath: string): string | null {
	const absolutePath = resolve(filePath);
	if (existsSync(absolutePath)) return absolutePath;

	const dir = dirname(absolutePath);
	const base = basename(absolutePath);
	if (!existsSync(dir)) return null;

	try {
		const normalizedBase = normalizeSpaces(base);
		const match = readdirSync(dir).find(f => normalizeSpaces(f) === normalizedBase);
		return match ? join(dir, match) : null;
	} catch {
		return null;
	}
}

function normalizeSpaces(s: string): string {
	return s.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ");
}

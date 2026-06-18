/**
 * Boundary glob-matching (v3.2).
 *
 * Provides a single function `isPathInBoundary` used by the tool_call hook to
 * block edit/write on files outside a task's declared boundary. Empty boundary
 * string means unrestricted.
 *
 * The boundary is a comma-separated list of relative paths or globs set from
 * `proposedTargetFiles.join(",")` on the "ready" path. Because picomatch is
 * used, `app/auth.py` matches exactly `app/auth.py` and `app/**` matches any
 * nested path. Dot-files (`.github/`) are matched with `dot: true`.
 */

import { sep } from "node:path";
import picomatch from "picomatch";

/**
 * Is `filePath` (relative to workspace root) allowed by the `boundary` glob
 * expression? Empty boundary = unrestricted.
 *
 * The path is normalized to posix before matching (Windows `\` → `/`). The
 * boundary string is split on `,`, each segment trimmed and matched against
 * the path (one positive match is sufficient).
 */
export function isPathInBoundary(filePath: string, boundary: string): boolean {
	if (!boundary || boundary.trim().length === 0) return true;
	const posix = filePath.split(sep).join("/");
	const patterns = boundary
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	if (patterns.length === 0) return true;
	return picomatch.isMatch(posix, patterns, { dot: true });
}

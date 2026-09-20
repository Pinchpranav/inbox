// piExtensions.ts — the optional pi extensions this app loads.
//
// Only index.ts (the composition root) calls into this file: it decides which extras
// the agent gets, then injects the result into PiSessionManager as plain data.
// Adding an extension is a single row in OPTIONAL_EXTENSIONS.
//
// A row carries two things because a working extension tool needs both: `package`
// gets the extension's code loaded, and `tools` names what that code registers. pi
// enables only the tool names a session asks for, so loading an extension without
// naming its tool leaves the session without that tool.
//
// The entry point comes from the package's own `pi.extensions` manifest key rather
// than a hardcoded path, so pnpm's hashed store path and any file move inside the
// package are both handled. A row that can't be resolved is skipped with a logged
// reason, never fatal — no browser must not mean no sidebar.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** One optional extension: its npm package, and the tools it adds. */
export interface OptionalPiExtension {
  package: string;
  tools: string[];
}

/** Add a row here to give the agent another tool. */
export const OPTIONAL_EXTENSIONS: readonly OptionalPiExtension[] = [
  { package: "pi-agent-browser-native", tools: ["agent_browser"] },
];

/** What index.ts injects into the session manager: extensions to load, tools to enable. */
export interface PiExtensions {
  paths: string[];
  toolNames: string[];
}

/** Entry points declared by a package's `pi.extensions` manifest key. */
function entryPaths(packageName: string): string[] {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const entries = (require(manifestPath) as { pi?: { extensions?: string[] } }).pi?.extensions;
  if (!entries?.length) throw new Error('declares no "pi.extensions" entry point');
  return entries.map((entry) => join(dirname(manifestPath), entry));
}

/** Resolve every row: loadable ones are logged and returned, the rest logged and skipped. */
export function resolvePiExtensions(): PiExtensions {
  const paths: string[] = [];
  const toolNames: string[] = [];
  for (const { package: name, tools } of OPTIONAL_EXTENSIONS) {
    try {
      paths.push(...entryPaths(name));
      toolNames.push(...tools);
      console.log(`[extensions] ${name}: on (tools: ${tools.join(", ")})`);
    } catch (err) {
      // First line only: require.resolve() appends a "Require stack:" block.
      const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      console.log(`[extensions] ${name}: off (${reason})`);
    }
  }
  return { paths, toolNames };
}

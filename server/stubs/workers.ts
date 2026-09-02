/**
 * Stand-in for the `cloudflare:workers` built-in module, which exists only
 * inside the Workers runtime.
 *
 * `src/mcp.ts` imports one symbol from the `agents` package: `createMcpHandler`.
 * That function is stateless and builds on the MCP SDK's Web-standard
 * Streamable HTTP transport, so it runs on Node unchanged. But it ships in a
 * module graph that also exports Agent, RPC, Workflow and PartyServer classes,
 * and those statically import `cloudflare:workers`. Node rejects the unknown
 * URL scheme at load time, before any Canopy code runs.
 *
 * The exports below are the complete set that Canopy's dependency graph imports
 * (`agents` and `partyserver`). Every one of them is a base class for
 * Durable-Object-backed features Canopy does not use. Declaring a subclass of a
 * stub is harmless; constructing one throws, so a code path that genuinely
 * needed the real thing fails loudly instead of silently misbehaving.
 */

const unavailable = (name: string): never => {
  throw new Error(`${name} is a Cloudflare Workers primitive and is unavailable on Node`);
};

/** Base class for Durable Objects. Subclassed by partyserver; never constructed. */
export class DurableObject {
  constructor(..._args: unknown[]) {
    unavailable("DurableObject");
  }
}

/** Base class for Cloudflare's RPC targets. */
export class RpcTarget {
  constructor(..._args: unknown[]) {
    unavailable("RpcTarget");
  }
}

/** Base class for Worker entrypoints (service bindings). */
export class WorkerEntrypoint {
  constructor(..._args: unknown[]) {
    unavailable("WorkerEntrypoint");
  }
}

/** Base class for Workflow entrypoints. */
export class WorkflowEntrypoint {
  constructor(..._args: unknown[]) {
    unavailable("WorkflowEntrypoint");
  }
}

/**
 * On Workers this is the bindings object. Canopy builds its own bindings in
 * server/index.ts and passes them to the handler explicitly, so nothing reads
 * this; an empty object keeps property access from throwing during module init.
 */
export const env: Record<string, unknown> = {};

/** The Workers `exports` namespace for service bindings. Unused here. */
export const exports: Record<string, unknown> = {};

export default { DurableObject, RpcTarget, WorkerEntrypoint, WorkflowEntrypoint, env, exports };

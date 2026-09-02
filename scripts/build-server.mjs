/**
 * Bundles the Node entry point for Railway.
 *
 * This is an esbuild script rather than a CLI one-liner because the build needs
 * one plugin. `src/mcp.ts` imports `createMcpHandler` from the `agents`
 * package; that function is stateless and runs on Node unchanged, but it ships
 * in a module that also statically imports Cloudflare's built-in `cloudflare:*`
 * modules for its Durable-Object-backed features. Node rejects those URL
 * schemes at load time, before any Canopy code runs.
 *
 * The plugin redirects the specifiers Canopy provably does not use to inert
 * stubs, and hard-fails the build on any other `cloudflare:` module so a new
 * one cannot slip into a deployed image unnoticed.
 *
 * Dependencies are bundled rather than left external so the stubs actually
 * apply to `agents`; if it were external, Node would resolve it at runtime and
 * bypass the alias entirely.
 */
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Workers built-ins Canopy never executes, mapped to stubs that throw if used. */
const STUBS = {
  "cloudflare:workers": "server/stubs/workers.ts",
  "cloudflare:email": "server/stubs/email.ts",
};

const cloudflareStubs = {
  name: "cloudflare-stubs",
  setup(b) {
    b.onResolve({ filter: /^cloudflare:/ }, (args) => {
      const stub = STUBS[args.path];
      if (stub) return { path: resolve(root, stub) };
      // An unmapped Workers module is a real dependency nobody has reasoned
      // about. Fail the build rather than ship an image that dies on boot.
      return {
        errors: [{
          text: `unstubbed Workers module "${args.path}" imported by ${args.importer}. `
              + `Add a stub under server/stubs/ and map it in scripts/build-server.mjs, `
              + `but only after confirming Canopy never executes that code path.`,
        }],
      };
    });
  },
};

const result = await build({
  entryPoints: [resolve(root, "server/index.ts")],
  outfile: resolve(root, "dist-server/index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  plugins: [cloudflareStubs],
  banner: {
    // Some bundled CommonJS dependencies expect `require` to exist.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

if (result.errors.length) process.exit(1);

// The GitHub repo this Canopy instance tracks. Used to build issue / PR / commit /
// milestone links across the UI so the app feels connected to the real repo.
// Keep in sync with the GITHUB_REPO var in wrangler.toml.
export const REPO_URL = "https://github.com/anticipation-labs/Anticipy";

// The GitHub org whose active members may sign in. Keep in sync with the
// GITHUB_ORG var in wrangler.toml (and DEFAULT_ORG in src/auth/github.ts).
export const ORG = "anticipation-labs";

// The repo hosting the Canopy plugin marketplace (skills + MCP).
export const PLUGIN_REPO = "anticipation-labs/canopy";

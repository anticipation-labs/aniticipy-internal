/**
 * Stand-in for the `cloudflare:email` built-in module.
 *
 * Reached for the same reason as ./workers: the `agents` package imports
 * `EmailMessage` at module scope for its Agent email-reply feature, which
 * Canopy does not use. Constructing one throws rather than pretending to send.
 */
export class EmailMessage {
  constructor(_from?: string, _to?: string, _raw?: unknown) {
    throw new Error("EmailMessage is a Cloudflare Workers primitive and is unavailable on Node");
  }
}

export default { EmailMessage };

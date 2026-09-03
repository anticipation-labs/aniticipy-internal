/**
 * Toast render tests.
 *
 * Regression guard: toastBlock once hardcoded a green accent checkmark, so
 * every failure — a Sync that never reached GitHub, a token that wouldn't
 * mint — rendered with a success tick. A failed action must never look like
 * it worked, so the icon and color are asserted per kind here.
 *
 * Pure (no D1 / Miniflare); assertions are HTML-string based. markdown is
 * mocked for the same reason as the other render tests (DOMPurify needs DOM
 * globals).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${body}</div>`,
}));

import { render, initialState } from "../web/src/render";

const CHECK = "M20 6 9 17l-5-5";      // check path, success only
const ALERT = '<circle cx="12" cy="12" r="9">'; // alert-circle, failure only

describe("toast", () => {
  it("renders nothing when idle", () => {
    const html = render({ ...initialState(), toast: null });
    expect(html).not.toContain(CHECK);
    expect(html).not.toContain(ALERT);
  });

  it("an ok toast gets the accent check", () => {
    const html = render({ ...initialState(), toast: { msg: "Synced: 12 captured", kind: "ok" } });
    expect(html).toContain("Synced: 12 captured");
    expect(html).toContain(CHECK);
    expect(html).not.toContain(ALERT);
    expect(html).toContain('stroke="var(--accent)"');
  });

  it("an error toast gets the red alert, never the check", () => {
    const html = render({ ...initialState(), toast: { msg: "service token or repo not configured", kind: "error" } });
    expect(html).toContain("service token or repo not configured");
    expect(html).toContain(ALERT);
    expect(html).not.toContain(CHECK);
    expect(html).toContain('stroke="var(--red)"');
  });

  it("escapes the message", () => {
    const html = render({ ...initialState(), toast: { msg: '<img src=x onerror=alert(1)>', kind: "error" } });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

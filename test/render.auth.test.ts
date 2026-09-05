import { describe, expect, it, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => body,
}));

import { initialState, render } from "../web/src/render";

describe("authentication screen branding", () => {
  it("uses Anticipy branding on the login screen", () => {
    const html = render(initialState());
    expect(html).toContain("Anticipy team workspace");
    expect(html).toContain("shared source of truth for the Anticipy team");
    expect(html).not.toContain("Sapling team");
  });

  it("uses Anticipy branding while membership is verified", () => {
    const state = initialState();
    state.authStep = "verifying";
    const html = render(state);
    expect(html).toContain("Verifying Anticipy membership");
    expect(html).not.toContain("Verifying Sapling membership");
  });
});

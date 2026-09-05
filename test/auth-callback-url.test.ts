import { describe, it, expect } from "vitest";
import { callbackUrl } from "../src/auth/routes";

describe("callbackUrl", () => {
  it("forces https for a public host reached over http", () => {
    expect(callbackUrl("http://canopy.saplinglearn.com/auth/login")).toBe(
      "https://canopy.saplinglearn.com/auth/callback",
    );
  });

  it("keeps https when already https", () => {
    expect(callbackUrl("https://canopy.saplinglearn.com/auth/login")).toBe(
      "https://canopy.saplinglearn.com/auth/callback",
    );
  });

  it("preserves http (and port) for localhost dev", () => {
    expect(callbackUrl("http://localhost:8787/auth/login")).toBe("http://localhost:8787/auth/callback");
    expect(callbackUrl("http://127.0.0.1:8787/auth/login")).toBe("http://127.0.0.1:8787/auth/callback");
  });

  it("includes the public /internal base path", () => {
    expect(callbackUrl("https://www.anticipy.ai/auth/login", "/internal")).toBe(
      "https://www.anticipy.ai/internal/auth/callback",
    );
  });
});

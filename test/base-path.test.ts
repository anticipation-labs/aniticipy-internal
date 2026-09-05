import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { appPath } from "../web/src/paths";

describe("the /internal domain route", () => {
  it("redirects the bare path to the trailing-slash asset base", async () => {
    const res = await SELF.fetch("https://www.anticipy.ai/internal", { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://www.anticipy.ai/internal/");
  });

  it("serves the SPA shell and its relative assets below /internal", async () => {
    const page = await SELF.fetch("https://www.anticipy.ai/internal/");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Canopy</title>");

    const script = html.match(/src="(\.\/assets\/[^"]+\.js)"/)?.[1];
    expect(script).toBeTruthy();
    const asset = await SELF.fetch(new URL(script!, "https://www.anticipy.ai/internal/"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
  });

  it("routes a prefixed API request through the normal auth gate", async () => {
    const res = await SELF.fetch("https://www.anticipy.ai/internal/auth/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("builds the right browser paths at the root and below /internal", () => {
    expect(appPath("/auth/me", "/")).toBe("/auth/me");
    expect(appPath("/auth/me", "/internal/")).toBe("/internal/auth/me");
    expect(appPath("/guide/docs-dark.png", "/internal/#docs")).toBe("/internal/guide/docs-dark.png");
  });

  it("scopes OAuth state to /internal and asks GitHub to return there", async () => {
    const res = await SELF.fetch("https://www.anticipy.ai/internal/auth/login", { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://www.anticipy.ai/internal/auth/callback",
    );
    expect(res.headers.get("set-cookie")).toContain("Path=/internal");
  });
});

/**
 * Render tests for the Assign-work compose form (My Work). Pure — the panel is a
 * string builder over AppState, no D1 and no DOM.
 */
import { describe, it, expect } from "vitest";
import { assignWorkPanel, render, initialState, type AppState } from "../web/src/render";
import type { DashboardData } from "@shared/dashboard";

const EMPTY: DashboardData = { person: "alice", previousActivity: [], todo: [], degraded: false };

function stateWith(over: Partial<AppState> = {}, admin = false): AppState {
  return {
    ...initialState(),
    view: "app",
    screen: "mywork",
    me: { login: "alice", name: "Alice", avatar_url: null, org: "SaplingLearn", admin },
    mywork: { status: "ok", data: EMPTY },
    ...over,
  };
}

describe("Assign work — entry point", () => {
  it("offers the button to a NON-admin member (assigning is not an admin action)", () => {
    const html = render(stateWith({}, false));
    expect(html).toContain('data-act="assignWorkToggle"');
    expect(html).toContain("Assign work");
    // and specifically not gated behind the admin Sync control
    expect(html).not.toContain('data-act="adminBackfill"');
  });

  it("is scoped to My Work — no assign button on other screens", () => {
    expect(render(stateWith({ screen: "feed" }))).not.toContain('data-act="assignWorkToggle"');
  });

  it("renders the panel only once opened", () => {
    expect(render(stateWith({ assignWorkOpen: false }))).not.toContain('data-act="assignWorkSubmit"');
    expect(render(stateWith({ assignWorkOpen: true }))).toContain('data-act="assignWorkSubmit"');
  });
});

describe("assignWorkPanel — new-task mode", () => {
  it("renders the title, details and priority fields", () => {
    const html = assignWorkPanel(stateWith({ assignWorkOpen: true, assignWorkMode: "new" }));
    expect(html).toContain('data-act="assignWorkTitle"');
    expect(html).toContain('data-act="assignWorkBody"');
    expect(html).toContain('data-arg="P0"');
    expect(html).toContain('data-arg="P3"');
    expect(html).toContain("Create &amp; assign");
  });

  it("disables submit until BOTH a title and an assignee are present", () => {
    const base = { assignWorkOpen: true, assignWorkMode: "new" as const };
    expect(assignWorkPanel(stateWith(base))).toContain("disabled");
    expect(assignWorkPanel(stateWith({ ...base, assignWorkTitle: "Fix it" }))).toContain("disabled");
    expect(assignWorkPanel(stateWith({ ...base, assignWorkAssignee: "jose" }))).toContain("disabled");
    // whitespace is not a title
    expect(assignWorkPanel(stateWith({ ...base, assignWorkTitle: "   ", assignWorkAssignee: "jose" }))).toContain("disabled");

    const ready = assignWorkPanel(stateWith({ ...base, assignWorkTitle: "Fix it", assignWorkAssignee: "jose" }));
    expect(ready).not.toContain("disabled");
  });

  it("stays disabled and shows progress while a submit is in flight", () => {
    const html = assignWorkPanel(stateWith({
      assignWorkOpen: true, assignWorkTitle: "Fix it", assignWorkAssignee: "jose", assignWorkBusy: true,
    }));
    expect(html).toContain("disabled");
    expect(html).toContain("Assigning");
  });

  it("escapes a draft body rather than injecting it as markup", () => {
    const html = assignWorkPanel(stateWith({
      assignWorkOpen: true, assignWorkBody: "<img src=x onerror=alert(1)>",
    }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

describe("assignWorkPanel — existing-issue mode", () => {
  it("swaps the task fields for an issue-number field", () => {
    const html = assignWorkPanel(stateWith({ assignWorkOpen: true, assignWorkMode: "existing" }));
    expect(html).toContain('data-act="assignWorkIssue"');
    expect(html).not.toContain('data-act="assignWorkTitle"');
    expect(html).toContain("Assign issue");
  });

  it("requires a numeric issue number", () => {
    const base = { assignWorkOpen: true, assignWorkMode: "existing" as const, assignWorkAssignee: "jose" };
    expect(assignWorkPanel(stateWith({ ...base, assignWorkIssue: "abc" }))).toContain("disabled");
    expect(assignWorkPanel(stateWith({ ...base, assignWorkIssue: "" }))).toContain("disabled");
    expect(assignWorkPanel(stateWith({ ...base, assignWorkIssue: "42" }))).not.toContain("disabled");
  });
});

describe("assignWorkPanel — assignee picker", () => {
  it("renders a quick-pick chip per mapped person, marking the current pick", () => {
    const html = assignWorkPanel(stateWith({
      assignWorkOpen: true,
      assignWorkAssignee: "jose",
      people: { status: "ok", data: [{ login: "jose", person: "Jose" }, { login: "omize10", person: "Omar" }] },
    }));
    expect(html).toContain('data-act="assignWorkPickPerson" data-arg="jose"');
    expect(html).toContain('data-act="assignWorkPickPerson" data-arg="omize10"');
    expect(html).toContain("Omar");
    // the picked chip carries the accent treatment
    expect(html).toMatch(/data-arg="jose"[^>]*var\(--accent\)/);
  });

  it("still offers the free-text login field when the roster is empty", () => {
    // A teammate with no captured event yet is not in `people` and must remain
    // assignable — an empty roster must not mean "nobody can be assigned".
    const html = assignWorkPanel(stateWith({ assignWorkOpen: true, people: { status: "ok", data: [] } }));
    expect(html).not.toContain('data-act="assignWorkPickPerson"');
    expect(html).toContain('data-act="assignWorkAssignee"');
  });
});

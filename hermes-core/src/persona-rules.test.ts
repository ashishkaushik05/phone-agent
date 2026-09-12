import { describe, it, expect } from "vitest";
import { HARD_RULES, withHardRules, stripHardRules } from "./persona-rules.ts";

describe("stripHardRules", () => {
  it("removes an appended HARD RULES block, leaving the base instruction", () => {
    const wrapped = withHardRules("You are an appointment booker.");
    expect(wrapped).toContain(HARD_RULES);
    expect(stripHardRules(wrapped)).toBe("You are an appointment booker.");
  });

  it("is a no-op when the instruction has no HARD RULES block", () => {
    expect(stripHardRules("Plain instruction, no rules.")).toBe("Plain instruction, no rules.");
  });

  it("round-trips: strip then re-wrap keeps a single HARD RULES block", () => {
    const wrapped = withHardRules("Base.");
    const rewrapped = withHardRules(`${stripHardRules(wrapped)}\n\nExtra goal.`);
    expect((rewrapped.match(/HARD RULES/g) || []).length).toBe(1);
    expect(rewrapped.indexOf("HARD RULES")).toBeGreaterThan(rewrapped.indexOf("Extra goal."));
  });

  it("strips a stale block whose wording differs from the current HARD_RULES", () => {
    const stale = "You are the front desk.\n\nHARD RULES (never break, whatever): stale wording here.";
    expect(stripHardRules(stale)).toBe("You are the front desk.");
  });
});

describe("withHardRules", () => {
  it("refreshes an outdated HARD RULES block instead of stacking a second one", () => {
    const stale = "You are the front desk.\n\nHARD RULES (never break, whatever): stale wording here.";
    const fixed = withHardRules(stale);
    expect((fixed.match(/HARD RULES \(never break/g) || []).length).toBe(1);
    expect(fixed).toContain("You are the front desk.");
    expect(fixed).toContain(HARD_RULES);
    expect(fixed).not.toContain("stale wording here.");
  });

  it("tells the agent to speak slowly", () => {
    expect(withHardRules("You are a receptionist.")).toMatch(/slowly/i);
  });
});

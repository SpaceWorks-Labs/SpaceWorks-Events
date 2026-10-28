import { describe, expect, it } from "vitest";
import { advanceSummary, entrySourceLine, nextRoundAction, panelLine, roundOptionLabel, roundOptions, roundStatusLabel } from "@/components/event-dashboard/panels/judgingRoundsCopy";
import { AUTO_ASSIGN_STRATEGY_COPY, autoAssignSeedLine } from "@/components/event-dashboard/panels/judgingOpsCopy";

// docs/HACKATHON.md "Rounds": the copy of Judging → Rounds and the round switchers.

describe("judging rounds copy", () => {
  it("labels switcher options with position, status and the current round", () => {
    expect(roundOptionLabel({ name: "Finals", position: 2, judgingStatus: "OPEN", isCurrent: true })).toBe("2. Finals · Open (current)");
    expect(roundOptionLabel({ name: "Main", position: 1, judgingStatus: "CLOSED", isCurrent: false })).toBe("1. Main · Closed");
  });

  it("maps round statuses to the judging vocabulary for the switchers", () => {
    const options = roundOptions([{ id: "r1", name: "Main", position: 1, status: "DRAFT", isCurrent: true, criteria: [] }]);
    expect(options[0]).toMatchObject({ judgingStatus: "NOT_STARTED", isCurrent: true });
  });

  it("always gives a status word, Finalised once finalised", () => {
    expect(roundStatusLabel({ status: "CLOSED", finalizedAt: null })).toBe("Closed");
    expect(roundStatusLabel({ status: "CLOSED", finalizedAt: "2026-11-01T00:00:00.000Z" })).toBe("Finalised");
    expect(roundStatusLabel({ status: "DRAFT", finalizedAt: null })).toBe("Draft");
  });

  it("describes the projects a round judges and its panel default", () => {
    expect(entrySourceLine({ entrySource: "ALL_SUBMITTED", finalists: 0, position: 1 })).toBe("Judges every submitted project");
    expect(entrySourceLine({ entrySource: "ADVANCED", finalists: 0, position: 2 })).toMatch(/none advanced yet/);
    expect(entrySourceLine({ entrySource: "ADVANCED", finalists: 1, position: 2 })).toBe("Judges 1 finalist from the previous round");
    expect(panelLine(0)).toBe("Panel: all invited judges (no panel chosen)");
    expect(panelLine(3)).toBe("Panel: 3 chosen judges");
  });

  it("offers the next status step, and none once finalised", () => {
    expect(nextRoundAction({ status: "DRAFT", finalizedAt: null })).toEqual({ status: "OPEN", label: "Open round" });
    expect(nextRoundAction({ status: "OPEN", finalizedAt: null })).toEqual({ status: "CLOSED", label: "Close round" });
    expect(nextRoundAction({ status: "CLOSED", finalizedAt: null })).toEqual({ status: "OPEN", label: "Reopen round" });
    expect(nextRoundAction({ status: "CLOSED", finalizedAt: "2026-11-01T00:00:00.000Z" })).toBeNull();
  });

  it("summarises an advancement preview and a random seed", () => {
    expect(advanceSummary({ finalists: 5, added: 3, kept: 2, removed: 1 })).toBe("5 finalists · 3 new · 2 already in · 1 removed");
    expect(advanceSummary({ finalists: 1, added: 1, kept: 0, removed: 0 })).toBe("1 finalist · 1 new");
    expect(autoAssignSeedLine("abc")).toMatch(/^Random seed abc\./);
    expect(AUTO_ASSIGN_STRATEGY_COPY.random.label).toBe("Random");
  });
});

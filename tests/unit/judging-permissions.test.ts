import { describe, expect, it } from "vitest";
import { EventPermission } from "@prisma/client";
import { judgingPermissionsFor } from "@/lib/judgingPermissions";
import { eventCapabilities } from "@/lib/eventDashboard/capabilities";

/** Every dashboard flag except the judging ones. */
const JUDGING_FLAGS = new Set(["canJudge", "canManageJudging", "isJudgeOnly"]);

function outsideJudging(role: null, grant: EventPermission[]) {
  return Object.fromEntries(Object.entries(eventCapabilities(role, grant)).filter(([key]) => !JUDGING_FLAGS.has(key)));
}
import { PERMISSION_OPTIONS, permissionChipLabels } from "@/components/event-dashboard/settings/helpers";

const ALL = Object.values(EventPermission);

describe("JUDGE permission isolation", () => {
  it("a JUDGE-only collaborator can judge and nothing else", () => {
    expect(judgingPermissionsFor(false, false, [EventPermission.JUDGE])).toEqual({ canJudge: true, canManageJudging: false, isJudgeOnly: true });
    // The rest of the event dashboard stays closed to a judge.
    expect(Object.values(outsideJudging(null, [EventPermission.JUDGE])).every((value) => value === false)).toBe(true);
  });

  it("JUDGE never stands in for another permission, and others never imply JUDGE", () => {
    for (const permission of ALL.filter((value) => value !== EventPermission.JUDGE)) {
      expect(judgingPermissionsFor(false, false, [permission])).toEqual({ canJudge: false, canManageJudging: false, isJudgeOnly: false });
      expect(outsideJudging(null, [EventPermission.JUDGE, permission])).toEqual(outsideJudging(null, [permission]));
    }
  });

  it("is not judge-only with another grant or an organisation membership", () => {
    expect(judgingPermissionsFor(false, false, [EventPermission.JUDGE, EventPermission.CHECK_IN]).isJudgeOnly).toBe(false);
    expect(judgingPermissionsFor(false, true, [EventPermission.JUDGE]).isJudgeOnly).toBe(false);
  });

  it("organisation owners and admins can judge and manage judging", () => {
    expect(judgingPermissionsFor(true, true, [])).toEqual({ canJudge: true, canManageJudging: true, isJudgeOnly: false });
    expect(judgingPermissionsFor(false, true, []).canJudge).toBe(false);
  });

  it("offers Judge in the collaborator invite form", () => {
    expect(PERMISSION_OPTIONS.map((option) => option.value)).toContain("JUDGE");
    expect(permissionChipLabels(["JUDGE"])).toEqual(["Judge"]);
  });
});

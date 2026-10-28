import { describe, expect, it } from "vitest";
import { passLabel } from "@/components/rsvp/TicketPicker";

describe("series pass label", () => {
  it("never repeats “remaining” when the number of dates is unknown", () => {
    expect(passLabel(null)).toBe("Pass for all remaining dates");
  });

  it("counts the dates it covers", () => {
    expect(passLabel(1)).toBe("Pass for the 1 remaining date");
    expect(passLabel(6)).toBe("Pass for all 6 remaining dates");
  });
});

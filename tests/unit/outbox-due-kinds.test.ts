import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { ADMISSION_NOTICE_KIND } from "@/lib/outbox/admission";
import { BULK_OUTBOX_KINDS } from "@/lib/outbox/due";
import { REIMBURSEMENT_AVAILABLE_KIND } from "@/lib/outbox/reimbursement";

describe("bulk outbox kinds", () => {
  it("queue reimbursement notices behind transactional email", () => {
    expect(REIMBURSEMENT_AVAILABLE_KIND).toBe("reimbursement-available");
    expect(BULK_OUTBOX_KINDS).toContain(REIMBURSEMENT_AVAILABLE_KIND);
  });

  it("keep admission notices urgent: their offers carry a deadline", () => {
    expect(ADMISSION_NOTICE_KIND).toBe("admission-notice");
    expect(BULK_OUTBOX_KINDS).not.toContain(ADMISSION_NOTICE_KIND);
  });
});

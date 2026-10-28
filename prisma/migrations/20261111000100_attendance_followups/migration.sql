-- Attendance confirmation follow-ups (docs/ATTENDANCE.md). Additive: three
-- nullable columns on AttendanceCheck, one index and one foreign key; no
-- existing row is rewritten.
-- organisersNotifiedAt and refundRequestOpenedAt are set once and never
-- cleared, so changing an answer back and forth never repeats the organiser
-- notice or opens a second refund request. refundRequestId remembers the
-- request a "No" opened, so a later "Yes" can withdraw it while it is open.
ALTER TABLE "AttendanceCheck" ADD COLUMN "organisersNotifiedAt" TIMESTAMP(3),
ADD COLUMN "refundRequestOpenedAt" TIMESTAMP(3),
ADD COLUMN "refundRequestId" TEXT;

CREATE INDEX "AttendanceCheck_refundRequestId_idx" ON "AttendanceCheck"("refundRequestId");

ALTER TABLE "AttendanceCheck" ADD CONSTRAINT "AttendanceCheck_refundRequestId_fkey" FOREIGN KEY ("refundRequestId") REFERENCES "RefundRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

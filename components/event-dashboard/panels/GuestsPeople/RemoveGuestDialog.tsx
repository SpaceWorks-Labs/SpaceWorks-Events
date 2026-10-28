"use client";

import type { Dispatch, SetStateAction, TransitionStartFunction } from "react";
import type { useRouter } from "next/navigation";
import type { AttendeeRow } from "@/components/attendees/types";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import type { useToast } from "@/components/feedback/ToastProvider";
import { deleteRsvp, restoreRsvp } from "@/app/actions/rsvp-admin";

/** Confirms removing a registration, then offers Undo in the toast. */
export function RemoveGuestDialog({
  organisationSlug,
  scope,
  removeGuest,
  setRemoveGuest,
  pending,
  startTransition,
  showToast,
  router,
}: {
  organisationSlug: string;
  scope: { eventId: string } | { eventInstanceId: string };
  removeGuest: AttendeeRow | null;
  setRemoveGuest: Dispatch<SetStateAction<AttendeeRow | null>>;
  pending: boolean;
  startTransition: TransitionStartFunction;
  showToast: ReturnType<typeof useToast>["showToast"];
  router: ReturnType<typeof useRouter>;
}) {
  return (
    <ConfirmationDialog
      open={Boolean(removeGuest)}
      title="Remove Attendee"
      message={`Are you sure you want to remove ${removeGuest?.user?.name ?? removeGuest?.guestName ?? removeGuest?.guestEmail ?? "this attendee"}'s RSVP registration?`}
      confirmLabel="Remove"
      loading={pending}
      onCancel={() => setRemoveGuest(null)}
      onConfirm={() => {
        if (!removeGuest) return;
        const guest = removeGuest;
        setRemoveGuest(null);
        startTransition(async () => {
          const res = await deleteRsvp({ organisationSlug, rsvpId: guest.id, ...scope });
          if (!res.ok) {
            showToast(res.error, "error");
            return;
          }
          showToast(
            "Attendee removed",
            "success",
            {
              label: "Undo",
              onClick: () => {
                startTransition(async () => {
                  const restored = await restoreRsvp({ organisationSlug, undoId: res.data!.undoId });
                  if (restored.ok) {
                    showToast("Attendee restored", "success");
                    router.refresh();
                  } else {
                    showToast(restored.error, "error");
                  }
                });
              },
            },
            10000,
          );
          router.refresh();
        });
      }}
    />
  );
}

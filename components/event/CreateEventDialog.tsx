"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EventPrivacyType, EventStatus } from "@prisma/client";
import { Plus } from "lucide-react";
import { createEvent } from "@/app/actions/event";
import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/ui/choice";
import { Callout } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import {
  DEFAULT_TEAM_SETTINGS,
  TeamSettingsFields,
  teamSettingsPayload,
  focusTeamSettingsProblem,
  teamSettingsProblem,
  type TeamSettingsDraft,
} from "./TeamSettingsFields";
import { DEFAULT_TIMEZONE, STEP_LABELS, STEP_TITLES, addWallClockHours, checkSchedule, isRichTextEmpty, nextWholeHour } from "./CreateEventDialog/helpers";
import { BasicsStep, ScheduleStep } from "./CreateEventDialog/steps";

export function CreateEventDialog(props: {
  organisationSlug: string;
  variant?: "button" | "fab";
}) {
  const { organisationSlug, variant = "button" } = props;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // `datetime-local` values on the event's clock (`timezone`).
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [tagsPreview, setTagsPreview] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [formKey, setFormKey] = useState(0);
  const formRef = useRef<HTMLFormElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /** Set when Next/Back (or a schedule error) changes the step, so focus follows into it. */
  const stepMoved = useRef(false);

  // Wizard States
  const [activeStep, setActiveStep] = useState(0);
  const [isOnline, setIsOnline] = useState(false);
  const [teamSettings, setTeamSettings] = useState<TeamSettingsDraft>(DEFAULT_TEAM_SETTINGS);

  // Keyboard and screen-reader users land in the step they moved to, not on
  // the Next button that is still under focus.
  useEffect(() => {
    if (!stepMoved.current) return;
    stepMoved.current = false;
    formRef.current?.querySelector<HTMLElement>(`[data-step="${activeStep}"] :is(input:not([type=hidden]), select, textarea, [contenteditable=true], button)`)?.focus();
  }, [activeStep]);

  const resetDraft = () => {
    setActiveStep(0);
    setError(null);
    setStart("");
    setEnd("");
    setTimezone(DEFAULT_TIMEZONE);
    setTagsPreview([]);
    setTagInput("");
    setIsOnline(false);
    setTeamSettings(DEFAULT_TEAM_SETTINGS);
    setFormKey((current) => current + 1);
  };

  const closeDialog = () => {
    if (pending) return;
    setOpen(false);
    resetDraft();
  };

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (activeStep !== 2) return;
    setError(null);
    if (teamSettingsProblem(teamSettings)) {
      // The message is already shown (and announced) under the size inputs; move focus to the field.
      focusTeamSettingsProblem(e.currentTarget, teamSettings);
      return;
    }
    const form = e.currentTarget;
    const fd = new FormData(form);
    // The picked wall-clock times belong to the chosen event timezone, not the browser's or the server's.
    const schedule = checkSchedule(start, end, timezone);
    if ("error" in schedule) {
      setError(schedule.error);
      stepMoved.current = true;
      setActiveStep(1);
      return;
    }
    const { startIso: startDateTime, endIso: endDateTime } = schedule;
    startTransition(async () => {
      const res = await createEvent({
        organisationSlug,
        title: String(fd.get("title") ?? ""),
        aboutHtml: String(fd.get("aboutHtml") ?? ""),
        tags: String(fd.get("tags") ?? ""),
        coverImageUrl: "",
        startDateTime,
        endDateTime,
        timezone,
        location: String(fd.get("location") ?? ""),
        mapLinkUrl: String(fd.get("mapLinkUrl") ?? ""),
        isOnline: isOnline,
        capacity: "",
        status: EventStatus.DRAFT,
        privacyType: EventPrivacyType.PUBLIC,
        ...teamSettingsPayload(teamSettings),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      closeDialog();
      if (res.data?.id) {
        router.push(`/dashboard/${organisationSlug}/event/${res.data.id}`);
      } else {
        router.refresh();
      }
    });
  }

  const handleOpen = () => {
    resetDraft();
    const base = nextWholeHour(DEFAULT_TIMEZONE);
    setStart(base);
    setEnd(addWallClockHours(base, 1));
    setOpen(true);
  };

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (tag && !tagsPreview.includes(tag) && tagsPreview.length < 12) {
      setTagsPreview([...tagsPreview, tag]);
    }
    setTagInput("");
  };

  return (
    <>
      {variant === "fab" ? (
        <button
          ref={triggerRef}
          type="button"
          aria-label="Create event"
          onClick={handleOpen}
          className="inline-flex size-14 items-center justify-center rounded-full bg-primary text-on-primary shadow-float transition-colors hover:bg-primary-hover"
        >
          <Plus aria-hidden className="size-6" />
        </button>
      ) : (
        <Button ref={triggerRef} variant="primary" startIcon={<Plus />} onClick={handleOpen}>
          New event
        </Button>
      )}
      <Dialog open={open} onOpenChange={(next) => { if (!next) closeDialog(); }}>
        <DialogContent
          size="md"
          // The dialog is opened from our own button, not a Radix trigger, so
          // hand focus back to it on close (Escape, Cancel, the close icon).
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <form
            key={formKey}
            ref={formRef}
            onSubmit={onSubmit}
            onKeyDown={(event) => {
              if (activeStep === 2 && event.key === "Enter" && event.target instanceof HTMLInputElement) {
                event.preventDefault();
              }
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <DialogHeader title={STEP_TITLES[activeStep]} />
            <DialogBody className="flex flex-col gap-5">
              <div>
                <div className="mb-2 flex items-center justify-between text-caption text-ink-muted">
                  <span className="text-overline">{STEP_LABELS[activeStep]}</span>
                  <span className="font-semibold">Step {activeStep + 1} of 3</span>
                </div>
                <div className="flex gap-1.5" aria-hidden>
                  {[0, 1, 2].map((stepIndex) => (
                    <span key={stepIndex} className={cn("h-1 flex-1 rounded-full transition-colors", stepIndex <= activeStep ? "bg-primary" : "bg-emphasis")} />
                  ))}
                </div>
              </div>

              {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}

              {/* Step 1: Basics */}
              <BasicsStep activeStep={activeStep} tagInput={tagInput} setTagInput={setTagInput} addTag={addTag} tagsPreview={tagsPreview} setTagsPreview={setTagsPreview} />

              {/* Step 2: Schedule */}
              <ScheduleStep activeStep={activeStep} start={start} setStart={setStart} end={end} setEnd={setEnd} timezone={timezone} setTimezone={setTimezone} />

              {/* Step 3: Location */}
              <div data-step="2" className={cn("flex-col gap-4", activeStep === 2 ? "flex" : "hidden")}>
                <SwitchRow
                  name="isOnline"
                  label="Online event"
                  checked={isOnline}
                  onCheckedChange={setIsOnline}
                />
                <Field
                  label={isOnline ? "Online meeting link" : "Location"}
                  required
                  helperText={isOnline ? "Enter a valid HTTP(S) meeting URL." : "Enter the venue or street address."}
                >
                  <Input
                    name="location"
                    type={isOnline ? "url" : "text"}
                    placeholder={isOnline ? "https://meet.google.com/..." : "e.g., 123 Main St, San Francisco, CA"}
                  />
                </Field>
                {!isOnline && (
                  <Field label="Map link" optional helperText="Paste a Google Maps link for directions (physical events only).">
                    <Input name="mapLinkUrl" type="url" />
                  </Field>
                )}
                <div className="border-t border-line pt-4">
                  <TeamSettingsFields value={teamSettings} onChange={setTeamSettings} />
                </div>
              </div>
            </DialogBody>
            <DialogFooter className="sm:justify-between">
              <div>
                {activeStep > 0 && (
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setError(null);
                      stepMoved.current = true;
                      setActiveStep((prev) => prev - 1);
                    }}
                    disabled={pending}
                  >
                    Back
                  </Button>
                )}
              </div>
              <div className="flex flex-col-reverse gap-2.5 sm:flex-row">
                <Button variant="secondary" onClick={closeDialog} disabled={pending}>
                  Cancel
                </Button>
                {activeStep < 2 ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setError(null);
                      if (activeStep === 0) {
                        const titleInput = formRef.current?.elements.namedItem(
                          "title",
                        ) as HTMLInputElement | null;
                        if (!titleInput?.value.trim()) {
                          titleInput?.focus();
                          titleInput?.reportValidity();
                          return;
                        }
                        const aboutInput = formRef.current?.elements.namedItem(
                          "aboutHtml",
                        ) as HTMLInputElement | null;
                        if (isRichTextEmpty(aboutInput?.value ?? "")) {
                          setError("Add a short description for your event.");
                          return;
                        }
                      }
                      if (activeStep === 1) {
                        const schedule = checkSchedule(start, end, timezone);
                        if ("error" in schedule) {
                          setError(schedule.error);
                          return;
                        }
                      }
                      stepMoved.current = true;
                      setActiveStep((prev) => prev + 1);
                    }}
                  >
                    Next
                  </Button>
                ) : (
                  <Button type="submit" variant="primary" disabled={pending} loading={pending}>
                    Create
                  </Button>
                )}
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

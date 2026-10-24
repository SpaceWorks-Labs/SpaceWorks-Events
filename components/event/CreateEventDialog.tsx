"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EventPrivacyType, EventStatus } from "@prisma/client";
import { Plus } from "lucide-react";
import { createEvent } from "@/app/actions/event";
import { zonedInputToIso } from "@/lib/timeZone";
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
import { STEP_LABELS, STEP_TITLES, isRichTextEmpty, toDatetimeLocalValue } from "./CreateEventDialog/helpers";
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
  const [start, setStart] = useState<Date | null>(null);
  const [end, setEnd] = useState<Date | null>(null);
  const [tagsPreview, setTagsPreview] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [formKey, setFormKey] = useState(0);
  const formRef = useRef<HTMLFormElement | null>(null);

  // Wizard States
  const [activeStep, setActiveStep] = useState(0);
  const [isOnline, setIsOnline] = useState(false);
  const [teamSettings, setTeamSettings] = useState<TeamSettingsDraft>(DEFAULT_TEAM_SETTINGS);

  const resetDraft = () => {
    setActiveStep(0);
    setError(null);
    setStart(null);
    setEnd(null);
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
    const timezone = String(fd.get("timezone") ?? "Asia/Kolkata");
    const startDateTime = start ? zonedInputToIso(toDatetimeLocalValue(start), timezone) : null;
    const endDateTime = end ? zonedInputToIso(toDatetimeLocalValue(end), timezone) : null;
    if (!startDateTime || new Date(startDateTime) < new Date()) {
      setError(startDateTime ? "Start time must be now or in the future." : "Choose a valid start time in the event timezone.");
      setActiveStep(1);
      return;
    }
    if (!endDateTime || new Date(endDateTime) <= new Date(startDateTime)) {
      setError(endDateTime ? "End time must be after start time." : "Choose a valid end time in the event timezone.");
      setActiveStep(1);
      return;
    }
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
    const now = new Date();
    const base = new Date(now);
    base.setMinutes(0, 0, 0);
    base.setHours(base.getHours() + 1);
    setStart(base);
    const e = new Date(base);
    e.setHours(e.getHours() + 1);
    setEnd(e);
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
          type="button"
          aria-label="Create event"
          onClick={handleOpen}
          className="inline-flex size-14 items-center justify-center rounded-full bg-primary text-on-primary shadow-float transition-colors hover:bg-primary-hover"
        >
          <Plus aria-hidden className="size-6" />
        </button>
      ) : (
        <Button variant="primary" startIcon={<Plus />} onClick={handleOpen}>
          New event
        </Button>
      )}
      <Dialog open={open} onOpenChange={(next) => { if (!next) closeDialog(); }}>
        <DialogContent size="md">
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
              <ScheduleStep activeStep={activeStep} start={start} setStart={setStart} end={end} setEnd={setEnd} />

              {/* Step 3: Location */}
              <div className={cn("flex-col gap-4", activeStep === 2 ? "flex" : "hidden")}>
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
                        if (!start || !end) {
                          setError("Please select both start and end times.");
                          return;
                        }
                        const timezoneInput = formRef.current?.elements.namedItem("timezone") as HTMLSelectElement | null;
                        const startInstant = zonedInputToIso(toDatetimeLocalValue(start), timezoneInput?.value || "Asia/Kolkata");
                        if (!startInstant || new Date(startInstant) < new Date()) {
                          setError("Start time must be now or in the future.");
                          return;
                        }
                        if (end <= start) {
                          setError("End time must be after start time.");
                          return;
                        }
                      }
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

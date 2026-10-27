"use client";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { saveScheduleItem, setScheduleDelay } from "@/app/actions/schedule";
import { useToast } from "@/components/feedback/ToastProvider";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import { zonedDatetimeLocalValue, zonedInputToIso } from "@/lib/timeZone";

type ScheduleItem = { id: string; title: string; description: string; startDateTime: string; endDateTime: string; delayMinutes: number };

function nextSessionTimes(items: ScheduleItem[], defaultDate: string, timeZone: string) {
  if (items.length === 0) return { start: defaultDate ? `${defaultDate}T09:00` : "", end: defaultDate ? `${defaultDate}T10:00` : "" };
  let cumulativeDelay = 0;
  let latestEnd = new Date(items[0]!.endDateTime);
  for (const item of items) {
    cumulativeDelay += item.delayMinutes;
    latestEnd = new Date(item.endDateTime);
  }
  const start = new Date(latestEnd.getTime() + (cumulativeDelay + 5) * 60_000);
  const end = new Date(start.getTime() + 60 * 60_000);
  return { start: zonedDatetimeLocalValue(start, timeZone), end: zonedDatetimeLocalValue(end, timeZone) };
}

export function ScheduleManager({ organisationSlug, eventId, eventSeriesId, items, defaultDate = "", timeZone }: { organisationSlug: string; eventId?: string; eventSeriesId?: string; items: Array<{ id: string; title: string; description: string; startDateTime: string; endDateTime: string; delayMinutes: number }>; defaultDate?: string; timeZone: string }) {
  const defaults = nextSessionTimes(items, defaultDate, timeZone);
  const router = useRouter(); const { showToast } = useToast(); const [pending, startTransition] = useTransition(); const [title, setTitle] = useState(""); const [start, setStart] = useState(defaults.start); const [end, setEnd] = useState(defaults.end);
  const target = { organisationSlug, eventId, eventSeriesId };
  return (
    <section aria-labelledby="schedule-manager-title" className="flex flex-col gap-3">
      <Card as="section">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const res = await saveScheduleItem({ ...target, title, startDateTime: start, endDateTime: end });
              if (!res.ok) return showToast(res.error, "error");
              // The fields hold wall-clock times on the series' clock, not the browser's.
              const endIso = zonedInputToIso(end, timeZone);
              setTitle("");
              if (endIso) {
                const nextStart = new Date(new Date(endIso).getTime() + 5 * 60_000);
                setStart(zonedDatetimeLocalValue(nextStart, timeZone));
                setEnd(zonedDatetimeLocalValue(new Date(nextStart.getTime() + 60 * 60_000), timeZone));
              }
              showToast("Schedule item added", "success");
              router.refresh();
            });
          }}
        >
          <div>
            <h2 id="schedule-manager-title" className="text-h4 text-ink">Schedule</h2>
            <p className="mt-1 text-body-ui text-ink-muted">New sessions begin five minutes after the previous session’s effective end time.</p>
          </div>
          <Field label="Session title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts" required>
              <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Ends" required>
              <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <div>
            <Button type="submit" disabled={pending} variant="primary" startIcon={<Plus />}>
              Add session
            </Button>
          </div>
        </form>
      </Card>
      {items.length > 0 ? (
        <ol className="flex flex-col gap-2.5">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-semibold text-ink">{item.title}</p>
                <p className="text-sm text-ink-muted">{new Date(item.startDateTime).toLocaleString()} – {new Date(item.endDateTime).toLocaleTimeString()}</p>
              </div>
              <Field label="Cascade delay (min)" className="sm:w-44">
                <Input
                  type="number"
                  defaultValue={item.delayMinutes}
                  disabled={pending}
                  className="py-2"
                  onBlur={(e) => {
                    const delayMinutes = Number(e.target.value);
                    if (!Number.isInteger(delayMinutes) || delayMinutes === item.delayMinutes) return;
                    startTransition(async () => {
                      const res = await setScheduleDelay({ ...target, itemId: item.id, delayMinutes });
                      if (!res.ok) showToast(res.error, "error");
                      else {
                        showToast("Schedule delay updated", "success");
                        router.refresh();
                      }
                    });
                  }}
                />
              </Field>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

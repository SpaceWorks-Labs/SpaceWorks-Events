"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { deleteReimbursementPolicyAction, setReimbursementPolicyActiveAction } from "@/app/actions/finance";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { formatDayTime } from "@/lib/format/datetime";
import type { PolicyAdminRow } from "@/lib/claims/policies/view";
import { PolicyDialog, type PolicyOptions } from "./PolicyDialog";
import { useSave, type FinanceScope } from "./shared";

/**
 * The Finance tab's "Reimbursement policies" (docs/FINANCE.md): per-stage
 * travel grants and the like, each with who qualifies, a cap per person, a
 * claim window and an optional budget. Owners and admins only.
 */

const WINDOW: Record<string, string> = { upcoming: "Opens later", open: "Open", closed: "Window closed" };

export function ReimbursementPolicies({ scope, policies, options, currency, timezone }: { scope: FinanceScope; policies: PolicyAdminRow[]; options: PolicyOptions; currency: string; timezone: string; }) {
  const [editing, setEditing] = useState<PolicyAdminRow["input"] | "new" | null>(null);
  const change = useSave();
  return (
    <div className="flex flex-col gap-4">
      {change.error ? <Callout tone="danger" role="alert">{change.error}</Callout> : null}
      {policies.length === 0 ? (
        <p className="text-caption text-ink-muted">No policies yet. Add one to pay back travel for finalists, mentored teams, crew or everyone confirmed.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {policies.map((policy) => (
            <li key={policy.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-body-ui font-semibold text-ink">{policy.name} · up to {policy.cap} each</p>
                  <p className="text-caption text-ink-muted">{policy.who} · {policy.categories}{policy.attendanceRequired ? " · must be checked in" : ""}</p>
                  <p className="text-caption text-ink-muted">
                    {policy.claimOpensAt ? `From ${formatDayTime(policy.claimOpensAt, timezone)}` : "From now"}
                    {policy.claimClosesAt ? ` until ${formatDayTime(policy.claimClosesAt, timezone)}` : ""}
                    {" · "}
                    {policy.budget ? `${policy.budget.used} of ${policy.budget.total} budget used, ${policy.budget.left} left` : `${policy.used} claimed, no budget limit`}
                    {` · ${policy.claimCount} ${policy.claimCount === 1 ? "claim" : "claims"}`}
                  </p>
                </div>
                <Chip tone={!policy.active ? "neutral" : policy.window === "open" ? "success" : "warning"} size="sm">{policy.active ? WINDOW[policy.window] : "Closed"}</Chip>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" startIcon={<Pencil aria-hidden />} onClick={() => setEditing(policy.input)}>Edit…</Button>
                <Button size="sm" variant="quiet" loading={change.pending} onClick={() => change.save(() => setReimbursementPolicyActiveAction(scope, { policyId: policy.id, active: !policy.active }), policy.active ? "Policy closed to new claims." : "Policy open again.")}>
                  {policy.active ? "Close to new claims" : "Open again"}
                </Button>
                {policy.claimCount === 0 ? (
                  <Button size="sm" variant="quiet" startIcon={<Trash2 aria-hidden />} loading={change.pending} onClick={() => change.save(() => deleteReimbursementPolicyAction(scope, policy.id), "Policy deleted.")}>Delete</Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div><Button variant="secondary" startIcon={<Plus aria-hidden />} onClick={() => setEditing("new")}>Add a policy</Button></div>
      {editing ? <PolicyDialog scope={scope} initial={editing === "new" ? null : editing} options={options} currency={currency} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

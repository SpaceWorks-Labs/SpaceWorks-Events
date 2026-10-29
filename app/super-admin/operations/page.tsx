import { requireSuperAdminMfa } from "@/lib/permissions";
import { loadSuperAdminOperationsView } from "@/lib/views/app__super-admin__operations__page";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { OutboxStatus } from "@prisma/client";
import { InstanceOperationsControls } from "@/components/super-admin/InstanceOperationsControls";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import { AdminPanel } from "@/components/super-admin/AdminPanel";
import { Callout, Chip, EmptyState, PageHeader } from "@/components/ui/display";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

function StatusChip(props: { ok: boolean; ready: string; missing: string; }) {
  return <Chip tone={props.ok ? "success" : "warning"} icon={props.ok ? <CheckCircle2 /> : <AlertTriangle />} className="whitespace-normal">{props.ok ? props.ready : props.missing}</Chip>;
}

function ageLabel(value: Date | null) {
  if (!value) return "Not recorded";
  const hours = Math.max(0, Math.floor((Date.now() - value.getTime()) / 3_600_000));
  if (hours < 1) return "Less than an hour ago";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function safeErrorSummary(value: string | null) {
  return value ? redactSensitiveText(value).slice(0, 500) : "No error detail recorded.";
}

export default async function SuperAdminOperationsPage() {
  await requireSuperAdminMfa();
  const { prerequisites, backupProvider, backupFresh, backupRetentionDays, reportedBackupAt, lastRestoreDrill, outbox, failedCount, expiredTokens, schedulerFresh, schedulerHeartbeat, beatFresh, beatHeartbeat, oldestPending, failedMessages, serverBackup, serverBackupProblem } = await loadSuperAdminOperationsView();
  const time = (value: string | null) => (value ? `${new Date(value).toLocaleString()} (${ageLabel(new Date(value))})` : "none yet");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Operations" description="Backup posture, queue health, retention jobs, and safe maintenance controls for this deployment." />

      {serverBackup ? (
        <AdminPanel title="Server backups" description="Made by the VPS installer on this server. Change them by running the installer again and choosing Backups.">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <StatusChip ok={!serverBackupProblem} ready="Backups are healthy" missing={serverBackupProblem?.subject ?? ""} />
              <StatusChip ok={serverBackup.scheduled} ready="Nightly schedule on" missing="Not scheduled: backups run only by hand" />
              <StatusChip ok={serverBackup.encrypted} ready="Encrypted" missing="Not encrypted" />
              <StatusChip ok={serverBackup.offsite === "ok"} ready="Copied off-site" missing={serverBackup.offsite === "off" ? "No off-site copy" : "Off-site copy failed"} />
            </div>
            {serverBackupProblem ? <p className="text-sm text-danger-fg">{serverBackupProblem.detail} The super admin is emailed once about it.</p> : null}
            <p className="text-sm text-ink-secondary">Newest full backup: {time(serverBackup.lastFullSuccessAt)}. Newest of any kind: {time(serverBackup.lastSuccessAt)}.</p>
            <p className="text-sm text-ink-secondary">Last run: {time(serverBackup.lastAttemptAt)}, {serverBackup.lastStatus === "ok" ? `succeeded (${serverBackup.lastKind === "full" ? "database, configuration and uploads" : "database and configuration"}, ${(serverBackup.sizeBytes / 1_048_576).toFixed(1)} MB)` : serverBackup.reason ? "refused because encryption is not working" : "failed"}. Kept on the server for {serverBackup.keepDays} days.</p>
          </div>
        </AdminPanel>
      ) : null}

      <div className="grid gap-6 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <AdminPanel title="Database backups">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <StatusChip ok={Boolean(backupProvider)} ready={`Provider: ${backupProvider}`} missing="Backup provider not configured" />
              <StatusChip ok={backupFresh} ready="Latest backup is fresh" missing="Backup status is stale or unknown" />
              <StatusChip ok={Boolean(backupRetentionDays)} ready={`${backupRetentionDays} day retention`} missing="Retention not configured" />
            </div>
            <p className="text-sm text-ink-secondary">Last successful backup: {reportedBackupAt ? `${reportedBackupAt.toLocaleString()} (${ageLabel(reportedBackupAt)})` : "not reported by the backup job"}.</p>
            <p className="text-sm text-ink-secondary">Last restore drill: {lastRestoreDrill ? `${lastRestoreDrill.createdAt.toLocaleString()} (${ageLabel(lastRestoreDrill.createdAt)})` : "not recorded"}.</p>
            <p className="text-caption text-ink-muted">Update backup posture in Instance settings; backup creation remains external to the application.</p>
          </div>
        </AdminPanel>
        <AdminPanel title="Service prerequisites">
          <div className="flex flex-col items-start gap-2">
            <StatusChip ok={prerequisites.redis} ready="Redis configured" missing="Redis missing — production writes will fail closed" />
            <StatusChip ok={prerequisites.scheduler} ready="Recovery endpoint secret configured" missing="Recovery endpoint secret (CRON_SECRET) missing" />
            <StatusChip ok={prerequisites.readiness} ready="Readiness probe protected" missing="Readiness probe secret missing" />
            <StatusChip ok={prerequisites.smtp} ready={`Transactional email configured (${prerequisites.smtpSource})`} missing="Transactional email not configured" />
          </div>
        </AdminPanel>
      </div>

      <AdminPanel title="Delivery and retention">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Chip>{`${outbox.get(OutboxStatus.PENDING) ?? 0} queued`}</Chip>
            <Chip tone={failedCount > 0 ? "danger" : "success"}>{`${failedCount} failed`}</Chip>
            <Chip tone="outline">{`${outbox.get(OutboxStatus.SENT) ?? 0} sent`}</Chip>
            <Chip tone={expiredTokens > 0 ? "warning" : "success"}>{`${expiredTokens} expired verification token${expiredTokens === 1 ? "" : "s"}`}</Chip>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusChip ok={schedulerFresh} ready="Email worker healthy" missing="Email worker stale or unknown" />
            {schedulerHeartbeat ? <Chip tone="outline">{`Last batch: ${schedulerHeartbeat.lastSent} sent, ${schedulerHeartbeat.lastFailed} failed`}</Chip> : null}
            <StatusChip ok={beatFresh} ready="Beat (timed jobs) healthy" missing="Beat (timed jobs) stale or unknown" />
            {beatHeartbeat && beatHeartbeat.lastFailed > 0 ? <Chip tone="warning">{`${beatHeartbeat.lastFailed} job${beatHeartbeat.lastFailed === 1 ? "" : "s"} failed in the last run`}</Chip> : null}
          </div>
          <p className="text-caption text-ink-muted">The worker sends queued email within seconds; the beat expires payment holds, sends reminders and cleans up. Without them, holds stay open and email waits in the queue.</p>
          <p className="text-sm text-ink-secondary">
            Last worker success: {schedulerHeartbeat?.lastSucceededAt ? `${schedulerHeartbeat.lastSucceededAt.toLocaleString()} (${ageLabel(schedulerHeartbeat.lastSucceededAt)})` : "not recorded"}.
          </p>
          <p className="text-sm text-ink-secondary">
            Last worker start: {schedulerHeartbeat?.lastStartedAt ? `${schedulerHeartbeat.lastStartedAt.toLocaleString()} (${ageLabel(schedulerHeartbeat.lastStartedAt)})` : "not recorded"}.
          </p>
          {schedulerHeartbeat?.lastError ? <p className="text-sm text-danger-fg">Last worker error: {safeErrorSummary(schedulerHeartbeat.lastError)}</p> : null}
          <p className="text-sm text-ink-secondary">Oldest queued message: {oldestPending ? `${oldestPending.createdAt.toLocaleString()} (${ageLabel(oldestPending.createdAt)})` : "none"}.</p>
          <div className="mt-1 border-t border-line pt-4">
            <InstanceOperationsControls />
          </div>
        </div>
      </AdminPanel>

      <AdminPanel title="Failed email deliveries" description="Recipient addresses, message payloads, and bearer links are never shown here.">
        {failedMessages.length === 0 ? (
          <EmptyState mood="sleepy">No failed email deliveries.</EmptyState>
        ) : (
          <Table label="Failed email deliveries">
            <THead>
              <tr>
                <TH>Kind</TH>
                <TH>Attempts</TH>
                <TH>Failed</TH>
                <TH>Last error</TH>
              </tr>
            </THead>
            <TBody>
              {failedMessages.map((message) => (
                <TR key={message.id}>
                  <TD className="align-top tabular-nums text-sm">{message.kind}</TD>
                  <TD className="align-top tabular-nums">{message.attempts}</TD>
                  <TD className="align-top whitespace-nowrap text-ink-secondary">{message.createdAt.toLocaleString()}</TD>
                  <TD className="align-top text-ink-secondary [overflow-wrap:anywhere]">{safeErrorSummary(message.lastError)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </AdminPanel>

      <Callout tone="info" title="Operational guardrail" className="rounded-xl">
        These controls do not create or delete provider backups. Backup creation, retention, encryption, and restore access must remain controlled by the managed database provider and deployment credentials. Use this page to verify posture and record evidence, not to expose infrastructure secrets in the application.
      </Callout>
    </div>
  );
}

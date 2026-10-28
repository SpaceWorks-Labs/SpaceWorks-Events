import { requireSuperAdminMfa } from "@/lib/permissions";
import { loadSuperAdminSettingsView } from "@/lib/views/app__super-admin__settings__page";
import { InstanceServiceSettingsForm } from "@/components/super-admin/InstanceServiceSettingsForm";
import { OpsWebhookSettingsForm } from "@/components/super-admin/OpsWebhookSettingsForm";
import { PaidEventsControl } from "@/components/super-admin/PaidEventsControl";
import { PageHeader } from "@/components/ui/display";
import { HelpLink } from "@/components/help/HelpLink";

export default async function SuperAdminSettingsPage() {
  await requireSuperAdminMfa();
  const { initial, fallback, paidEventsEnabled, opsWebhook } = await loadSuperAdminSettingsView();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Instance settings" description="Configure email delivery, Google sign-in, paid events, backup status, and operational alerts for this instance. Secrets are encrypted and never displayed." actions={<HelpLink article="instance/settings" />} />
      <InstanceServiceSettingsForm initial={initial} fallback={fallback} />
      <PaidEventsControl initialEnabled={paidEventsEnabled} />
      <OpsWebhookSettingsForm initial={opsWebhook} />
    </div>
  );
}

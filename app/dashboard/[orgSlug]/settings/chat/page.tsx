import type { Metadata } from "next";
import { AddChatChannelForm } from "@/components/settings/chat/AddChatChannelForm";
import { ChatChannelList } from "@/components/settings/chat/ChatChannelList";
import { PageHeader } from "@/components/ui/display";
import { loadChatSettingsView } from "@/lib/views/app__dashboard__orgSlug__settings__chat__page";
import { HelpLink } from "@/components/help/HelpLink";

export const metadata: Metadata = { title: "Chat notifications", description: "Send your organisation's updates to Slack, Discord, Mattermost, Telegram or WhatsApp." };

export default async function ChatSettingsPage({ params }: { params: Promise<{ orgSlug: string; }>; }) {
  const { organisation, channels } = await loadChatSettingsView({ params });
  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader
        title="Chat notifications"
        description="Tell your team's chat when people register, ask to join, pay, cancel or ask for a refund. Each chat chooses what it hears about."
        actions={<HelpLink article="organisations/chat-notifications" />}
      />
      <ChatChannelList organisationSlug={organisation.slug} channels={channels} />
      <AddChatChannelForm organisationSlug={organisation.slug} />
    </div>
  );
}

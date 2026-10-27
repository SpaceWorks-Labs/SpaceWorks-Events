import "server-only";

import { cache } from "react";
import * as guards from "@/lib/views/dashboardGuards";

/*
 * The dashboard route guards (lib/views/dashboardGuards.ts) wrapped in React
 * `cache`, keyed on plain strings, so nested guard layouts in one render (the
 * event layout and its check-in layout, say) share one check. Each layout
 * beside a dashboard `loading.tsx` awaits one of these; see the view readers
 * for why.
 */

const org = (orgSlug: string) => ({ params: Promise.resolve({ orgSlug }) });
const event = (orgSlug: string, eventId: string) => ({ params: Promise.resolve({ orgSlug, eventId }) });

export const guardDashboardHome = cache(() => guards.guardDashboardHome());
export const guardOrgDashboard = cache((orgSlug: string) => guards.guardOrgDashboard(org(orgSlug)));
export const guardOrgMember = cache((orgSlug: string) => guards.guardOrgMember(org(orgSlug)));
export const guardOrgAdmin = cache((orgSlug: string) => guards.guardOrgAdmin(org(orgSlug)));
export const guardOrgOwner = cache((orgSlug: string) => guards.guardOrgOwner(org(orgSlug)));
export const guardEventDashboard = cache((orgSlug: string, eventId: string) => guards.guardEventDashboard(event(orgSlug, eventId)));
export const guardEventCheckIn = cache((orgSlug: string, eventId: string) => guards.guardEventCheckIn(event(orgSlug, eventId)));
export const guardEventSchedule = cache((orgSlug: string, eventId: string) => guards.guardEventSchedule(event(orgSlug, eventId)));
export const guardSeriesDashboard = cache((orgSlug: string, seriesId: string) => guards.guardSeriesDashboard({ params: Promise.resolve({ orgSlug, seriesId }) }));
export const guardWebhookEndpoint = cache((orgSlug: string, endpointId: string) => guards.guardWebhookEndpoint({ params: Promise.resolve({ orgSlug, endpointId }) }));
export const guardIdProgramme = cache((orgSlug: string, programmeId: string) => guards.guardIdProgramme({ params: Promise.resolve({ orgSlug, programmeId }) }));
export const guardTicketDesign = cache((orgSlug: string, designId: string) => guards.guardTicketDesign({ params: Promise.resolve({ orgSlug, designId }) }));

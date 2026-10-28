import { PrismaClient } from "@prisma/client";
import { reservedOrganisationSlugs, reservedSlugProblem } from "./reserved-slugs.mjs";

const prisma = new PrismaClient();

try {
  const [certificateFormColumns, feedbackAnswerColumns, userColumns, feedbackColumns, assetColumns, apiCredentialColumns, featureTables, eventColumns, eventPageColumns, eventSessionColumns, instanceSettingColumns, constraints, indexes, triggers] = await Promise.all([
    prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'EventFeedbackForm'`,
    prisma.$queryRaw`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'EventFeedbackAnswer'
    `,
    prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'User'
    `,
    prisma.$queryRaw`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'EventFeedbackResponse'
    `,
    prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Asset'
    `,
    prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ApiCredential'
    `,
    prisma.$queryRaw`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'EventCollaborator', 'EventCollaboratorInvite', 'EventScheduleItem',
        'EventPage', 'EventPageSection', 'EventHighlight', 'EventVenue',
        'EventVenueRoom', 'EventSession', 'EventSpeaker',
        'EventSessionSpeaker', 'EventSponsor', 'EventFaq', 'EventResource',
        'EventBroadcast', 'ShortLinkClickDay', 'CheckInList', 'CheckInListRecord', 'CheckInListEvent', 'Team', 'TeamSeekerProfile', 'TeamJoinRequest', 'Submission', 'SubmissionLink', 'JudgingCriterion', 'JudgeAssignment', 'JudgeScore', 'JudgeReview', 'JudgingRound', 'JudgingRoundEntry', 'JudgingRoundJudge', 'JudgingAssignmentRun', 'JudgingFinalistNotice', 'EventAward', 'EventAwardWinner', 'SavedView', 'PrizePayout', 'ExpenseClaim', 'ExpenseReceipt', 'ClaimPayout', 'RefundRequest', 'TicketDesign', 'EventCrewMember', 'EventCrewJoinLink', 'MobileSession', 'MobileIdempotencyKey', 'MentorProfile', 'HelpCategory', 'HelpRequest', 'HelpRequestActivity', 'HelpRequestComment', 'MentorAssignmentRun', 'MentorTeamAssignment', 'MentorConflict', 'OfficeHourSlot', 'OfficeHourBooking', 'OfficeHourChange', 'MentoringRound', 'MentoringRoundMentor', 'MentoringVisit', 'MentoringCheckIn', 'MentorNomination', 'VolunteerShift', 'VolunteerShiftSignup', 'VolunteerAttendanceCorrection', 'VolunteerHours', 'VolunteerHoursEntry', 'ContributorCertificate', 'AdmissionStage', 'AdmissionApplication', 'AdmissionStageEntry', 'AdmissionStageReviewer', 'AdmissionReviewAssignment', 'AdmissionReview', 'AdmissionReviewConflict', 'AdmissionAssignmentRun', 'AdmissionDecisionBatch', 'AdmissionDecision', 'AdmissionAnswerRevision', 'AdmissionStatusEvent'
      )
    `,
    prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Event'
    `,
    prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'EventPage'
    `,
    prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'EventSession'
    `,
    prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'InstanceSetting'
    `,
    prisma.$queryRaw`
      SELECT conname, confdeltype
      FROM pg_constraint
      WHERE conname IN (
        'RSVP_exactly_one_target', 'CheckInEvent_rsvpId_fkey',
        'AuditEvent_organisationId_fkey', 'ApiClient_organisationId_fkey',
        'AuditEvent_actorApiClientId_fkey', 'ApiCredential_secret_hash_length',
        'AuditEvent_single_actor', 'Event_registration_cutoff_mode',
        'EventCollaborator_one_target', 'EventCollaboratorInvite_one_target',
        'EventResource_one_parent', 'EventResource_one_source',
        'Event_valid_time_range', 'Event_positive_capacity',
        'EventSeries_positive_duration', 'EventInstance_valid_time_range',
        'EventSession_valid_time_range', 'OrganisationInvite_usage_pair',
        'EventCollaboratorInvite_usage_pair', 'CheckInEvent_known_action',
        'CheckInEvent_known_source', 'EventFeedbackAnswer_fieldId_fkey',
        'EventFeedbackResponse_identity_capability_pair',
        'EventFeedbackAnswer_typed_value', 'OutboxMessage_attempts_nonnegative',
        'OutboxMessage_state_shape', 'Event_team_min_size_positive', 'Event_team_max_size_at_least_two', 'Event_team_size_order', 'Event_team_mode_requires_max_size', 'TeamSeekerProfile_skills_limit', 'RSVP_teamId_fkey', 'Team_eventId_fkey', 'Team_leaderRsvpId_fkey', 'Submission_exactly_one_entrant', 'Submission_links_https', 'Event_submission_window_order', 'SubmissionLink_token_hash_shape', 'JudgingCriterion_weight_range', 'JudgingCriterion_max_score_range', 'JudgeScore_score_range', 'EventAwardWinner_place_positive', 'Event_reviews_per_project_range', 'JudgingRound_name_length', 'JudgingRound_position_positive', 'JudgingRound_reviews_per_project_range', 'JudgingRound_window_order', 'JudgingRound_first_takes_all', 'JudgingRound_finalized_shape', 'JudgingRoundEntry_source_rank_positive', 'JudgingAssignmentRun_shape', 'JudgingFinalistNotice_email_hash_shape', 'JudgingCriterion_round_required', 'JudgeAssignment_round_required', 'JudgeReview_round_required', 'Submission_teamId_fkey', 'Submission_rsvpId_fkey', 'OrganisationPaymentSettings_online_provider',
        'OrganisationPaymentSettings_currency_code', 'OrganisationPaymentSettings_webhook_path_shape',
        'ProcessedWebhookEvent_online_provider', 'Order_pending_hold', 'Order_nonnegative_amounts', 'OrderLine_amounts', 'RSVP_pending_payment_hold', 'Payment_positive_amount', 'Payment_paid_shape', 'PaymentRefund_positive_amount', 'TicketType_price_nonnegative', 'RSVP_ticketTypeId_fkey', 'EventInstance_positive_capacity', 'EventSeries_currency_code', 'EventSeries_refund_policy_shape', 'Order_one_target', 'PromoCode_one_target', 'TicketType_one_target', 'TicketType_access_code_shape', 'TicketType_pricing_shape', 'TicketType_group_and_fee', 'OrderLine_kind_target', 'AddOn_one_target', 'AddOn_amounts', 'Event_transfer_cutoff', 'EventSeries_transfer_cutoff', 'PaymentDispute_shape', 'Event_refund_policy_shape', 'Payment_offline_shape', 'PromoCode_discount_shape', 'PromoCode_digest_shape', 'PaymentAmendment_known_field', 'ShortLinkClickDay_count_nonnegative', 'OrganisationPaymentSettings_receipt_shape', 'Payment_method_shape', 'OrganisationEmailSettings_shape', 'UserDevice_shape', 'ChatChannel_shape', 'CheckInListRecord_known_source', 'CheckInListEvent_known_action', 'CheckInListEvent_known_source', 'SavedView_name_length', 'SavedView_params_object', 'SavedView_eventId_fkey', 'Order_team_or_submission', 'PrizePayout_shape', 'Event_submission_fee_positive', 'EventAward_prize_positive', 'Event_finance_amounts', 'ExpenseClaim_shape', 'ExpenseReceipt_shape', 'ClaimPayout_shape', 'RefundRequest_shape', 'TicketDesign_shape', 'MobileSession_shape', 'MobileSession_refresh_history_limit', 'MobileIdempotencyKey_shape', 'Event_manual_close_snapshot_mode', 'RSVP_crew_shape', 'EventCrewMember_rsvpId_fkey', 'MentorProfile_shape', 'HelpCategory_policy_bounds', 'HelpRequest_one_origin', 'HelpRequest_claim_shape', 'HelpRequest_text_bounds', 'HelpRequestComment_shape', 'MentorTeamAssignment_end_shape', 'MentorConflict_reason_length', 'OfficeHourSlot_shape', 'OfficeHourBooking_cancel_shape', 'MentoringRound_window', 'MentorTeamAssignment_activation_shape', 'VolunteerShift_shape', 'VolunteerShiftSignup_attendance_shape', 'VolunteerAttendanceCorrection_shape', 'VolunteerHours_shape', 'VolunteerHoursEntry_shape', 'ContributorCertificate_shape', 'Event_admission_shape', 'AdmissionStage_shape', 'AdmissionApplication_shape', 'AdmissionStageEntry_shape', 'AdmissionReview_shape', 'AdmissionReviewConflict_known_reason', 'AdmissionAssignmentRun_shape', 'AdmissionDecision_shape', 'AdmissionAnswerRevision_person_key_shape', 'AdmissionApplication_rsvpId_fkey', 'AdmissionApplication_teamId_fkey'
      )
    `,
    prisma.$queryRaw`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN ('Asset_key_key', 'RSVP_event_attendee_unique', 'RSVP_instance_attendee_unique', 'ApiClient_organisationId_status_idx', 'ApiCredential_apiClientId_revokedAt_idx', 'OrganisationPaymentSettings_webhookPathId_key', 'ProcessedWebhookEvent_organisationId_provider_eventId_key', 'Payment_one_pending_per_order', 'PaymentCheckoutAttempt_provider_externalId_key', 'PromoCode_eventId_codeDigest_key', 'PromoCode_eventSeriesId_codeDigest_key', 'CheckInList_eventId_active_name_key', 'CheckInListRecord_listId_rsvpId_key', 'Team_eventId_nameKey_key', 'Team_joinToken_key', 'Team_manageTokenHash_key', 'TeamJoinRequest_one_pending_per_team_rsvp', 'Submission_teamId_key', 'Submission_rsvpId_key', 'SubmissionLink_tokenHash_key', 'JudgeScore_submissionId_judgeUserId_criterionId_key', 'JudgeReview_roundId_submissionId_judgeUserId_key', 'JudgeAssignment_roundId_judgeUserId_submissionId_key', 'JudgingRound_eventId_position_key', 'JudgingRound_one_open_per_event', 'JudgingRoundEntry_roundId_submissionId_key', 'JudgingFinalistNotice_roundId_emailHash_key', 'EventAwardWinner_awardId_place_key', 'EventAwardWinner_awardId_submissionId_key', 'SavedView_eventId_surface_idx', 'RefundRequest_one_open_per_order', 'ExpenseReceipt_storageKey_key', 'RSVP_eventId_createdAt_id_idx', 'RSVP_eventId_checkedInAt_id_idx', 'Team_eventId_createdAt_id_idx', 'Submission_eventId_createdAt_id_idx', 'Submission_eventId_status_submittedAt_id_idx', 'EventInvite_eventId_createdAt_id_idx', 'HelpRequest_one_claim_per_mentor', 'MentorTeamAssignment_live_unique', 'MentorConflict_live_kind', 'OfficeHourBooking_live_team_slot', 'MentoringRound_one_live', 'MentorProfile_eventId_userId_key', 'HelpCategory_eventId_key_key', 'MentoringCheckIn_roundId_teamId_key', 'MentoringVisit_roundId_teamId_key', 'ContributorCertificate_one_live_per_member', 'VolunteerShiftSignup_shiftId_crewMemberId_key', 'AdmissionDecisionBatch_one_draft_per_event', 'AdmissionStatusEvent_unsent_idx', 'AdmissionApplication_rsvpId_key', 'AdmissionApplication_teamId_key', 'AdmissionStage_eventId_position_key', 'AdmissionStageEntry_stageId_applicationId_key', 'AdmissionReviewAssignment_stageId_applicationId_reviewerUse_key', 'AdmissionReview_assignmentId_answersRevision_key')
    `,
    prisma.$queryRaw`
      SELECT trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = 'public' AND trigger_name IN (
        'audit_fallback_organisation', 'audit_fallback_membership',
        'audit_fallback_event', 'audit_fallback_eventseries',
        'audit_fallback_organisationinvite', 'audit_fallback_eventinvite',
        'audit_fallback_seriesinvite', 'audit_fallback_rsvp',
        'audit_fallback_eventcollaborator',
        'audit_fallback_eventcollaboratorinvite', 'audit_fallback_apiclient',
        'audit_fallback_apiclientscope', 'audit_fallback_apicredential',
        'payment_ledger_guard', 'payment_refund_guard', 'checkout_attempt_guard', 'event_currency_lock', 'payment_amendment_append_only', 'rsvp_waitlist_dates', 'ticket_type_target_fixed', 'rsvp_ticket_type_target', 'promo_code_ticket_type_target', 'series_currency_lock', 'judging_criterion_round', 'judge_assignment_round', 'judge_review_round', 'judging_round_entry_event', 'event_current_judging_round', 'event_judging_round_mirror', 'help_request_activity_append_only', 'help_request_comment_append_only', 'mentor_assignment_run_append_only', 'office_hour_change_append_only', 'mentoring_check_in_append_only', 'mentor_nomination_append_only', 'volunteer_hours_entry_guard', 'volunteer_hours_guard', 'volunteer_correction_append_only', 'admission_application_shape', 'admission_stage_entry_event', 'admission_assignment_event', 'admission_review_event', 'admission_decision_guard', 'admission_conflict_event', 'admission_review_append_only', 'admission_answer_revision_append_only', 'admission_stage_entry_append_only', 'rsvp_admission_application', 'team_admission_application', 'rsvp_admission_status_guard', 'team_admission_status_guard', 'rsvp_admission_accept', 'team_admission_accept', 'admission_application_keep', 'rsvp_admission_registration_guard', 'team_admission_registration_guard', 'rsvp_admission_withdraw', 'team_admission_withdraw', 'admission_status_event', 'user_admission_scrub'
      )
    `,
  ]);
  const columnNames = new Set(assetColumns.map((row) => row.column_name));
  const userColumnNames = new Set(userColumns.map((row) => row.column_name));
  const apiCredentialColumnNames = new Set(apiCredentialColumns.map((row) => row.column_name));
  const featureTableNames = new Set(featureTables.map((row) => row.table_name));
  const eventColumnNames = new Set(eventColumns.map((row) => row.column_name));
  const eventPageColumnNames = new Set(eventPageColumns.map((row) => row.column_name));
  const eventSessionColumnNames = new Set(eventSessionColumns.map((row) => row.column_name));
  const nullableFeedbackColumns = new Set(feedbackColumns.filter((row) => row.is_nullable === "YES").map((row) => row.column_name));
  const feedbackAnswerColumnNames = new Set(feedbackAnswerColumns.map((row) => row.column_name));
  const nullableFeedbackAnswerColumns = new Set(feedbackAnswerColumns.filter((row) => row.is_nullable === "YES").map((row) => row.column_name));
  const instanceSettingColumnNames = new Set(instanceSettingColumns.map((row) => row.column_name));
  const constraintNames = new Set(constraints.map((row) => row.conname));
  const indexNames = new Set(indexes.map((row) => row.indexname));
  const triggerNames = new Set(triggers.map((row) => row.trigger_name));
  const missing = [
    ...(certificateFormColumns.some((row) => row.column_name === "certificateTemplate") ? [] : ["EventFeedbackForm.certificateTemplate"]),
    ...["fileData", "key"].filter((column) => !columnNames.has(column)),
    ...["mfaSecretEncrypted", "mfaEnabledAt", "recoveryCodeHashes"].filter((column) => !userColumnNames.has(column)),
    ...["rsvpId", "certificateToken", "certificateTemplate"].filter((column) => !nullableFeedbackColumns.has(column)),
    ...["fieldKey", "fieldLabel", "fieldType"].filter((column) => !feedbackAnswerColumnNames.has(column)),
    ...["fieldId"].filter((column) => !nullableFeedbackAnswerColumns.has(column)),
    ...["secretHash", "revokedAt", "expiresAt", "lastUsedAt"].filter((column) => !apiCredentialColumnNames.has(column)),
    ...["EventCollaborator", "EventCollaboratorInvite", "EventScheduleItem", "EventPage", "EventPageSection", "EventHighlight", "EventVenue", "EventVenueRoom", "EventSession", "EventSpeaker", "EventSessionSpeaker", "EventSponsor", "EventFaq", "EventResource", "ShortLinkClickDay", "CheckInList", "CheckInListRecord", "CheckInListEvent", "Team", "TeamSeekerProfile", "TeamJoinRequest", "Submission", "SubmissionLink", "JudgingCriterion", "JudgeAssignment", "JudgeScore", "JudgeReview", "JudgingRound", "JudgingRoundEntry", "JudgingRoundJudge", "JudgingAssignmentRun", "JudgingFinalistNotice", "EventAward", "EventAwardWinner", "SavedView", "PrizePayout", "ExpenseClaim", "ExpenseReceipt", "ClaimPayout", "RefundRequest", "TicketDesign", "EventCrewMember", "EventCrewJoinLink", "MobileSession", "MobileIdempotencyKey", "MentorProfile", "HelpCategory", "HelpRequest", "HelpRequestActivity", "HelpRequestComment", "MentorAssignmentRun", "MentorTeamAssignment", "MentorConflict", "OfficeHourSlot", "OfficeHourBooking", "OfficeHourChange", "MentoringRound", "MentoringRoundMentor", "MentoringVisit", "MentoringCheckIn", "MentorNomination", "VolunteerShift", "VolunteerShiftSignup", "VolunteerAttendanceCorrection", "VolunteerHours", "VolunteerHoursEntry", "ContributorCertificate", "AdmissionStage", "AdmissionApplication", "AdmissionStageEntry", "AdmissionStageReviewer", "AdmissionReviewAssignment", "AdmissionReview", "AdmissionReviewConflict", "AdmissionAssignmentRun", "AdmissionDecisionBatch", "AdmissionDecision", "AdmissionAnswerRevision", "AdmissionStatusEvent"].filter((table) => !featureTableNames.has(table)),
    ...["registrationClosesAt", "registrationLeadMinutes", "checkInStationPinHash", "checkInStationPinEncrypted", "checkInStationSecretVersion", "registrationMode", "teamMinSize", "teamMaxSize", "soloPolicy", "submissionsEnabled", "submissionsOpenAt", "submissionsCloseAt", "judgingStatus", "judgesSeeAll", "projectGalleryPublic", "resultsPublishedAt", "resultsAnnouncedAt", "reviewsPerProject", "scoreNormalization", "currentJudgingRoundId", "emailEntrantsOnResults", "emailSubmissionReceipts", "crewClaimsEnabled", "registrationManuallyClosedAt", "registrationCutoffBeforeManualClose", "registrationLeadBeforeManualClose", "mentorDeskEnabled", "mentorHelpClaimedEmail", "mentorsGetCrewTicket", "volunteerShiftsEnabled", "contributorCertificateTemplate", "admissionEnabled", "admissionMode", "admissionRsvpDays", "admissionOfferCapacity", "emailApplicantsOnStageAdvance"].filter((column) => !eventColumnNames.has(column)),
    ...["isPublished"].filter((column) => !eventPageColumnNames.has(column)),
    ...["delayMinutes"].filter((column) => !eventSessionColumnNames.has(column)),
    ...["smtpPasswordEncrypted", "googleClientSecretEncrypted", "opsWebhookUrlEncrypted", "opsWebhookEnabled", "opsWebhookIncludeWarnings", "googleMobileClientIds"].filter((column) => !instanceSettingColumnNames.has(column)).map((column) => `InstanceSetting.${column}`),
    ...["RSVP_exactly_one_target", "CheckInEvent_rsvpId_fkey", "AuditEvent_organisationId_fkey", "ApiClient_organisationId_fkey", "AuditEvent_actorApiClientId_fkey", "ApiCredential_secret_hash_length", "AuditEvent_single_actor", "Event_registration_cutoff_mode", "EventCollaborator_one_target", "EventCollaboratorInvite_one_target", "EventResource_one_parent", "EventResource_one_source", "Event_valid_time_range", "Event_positive_capacity", "EventSeries_positive_duration", "EventInstance_valid_time_range", "EventSession_valid_time_range", "OrganisationInvite_usage_pair", "EventCollaboratorInvite_usage_pair", "CheckInEvent_known_action", "CheckInEvent_known_source", "EventFeedbackAnswer_fieldId_fkey", "EventFeedbackResponse_identity_capability_pair", "EventFeedbackAnswer_typed_value", "OutboxMessage_attempts_nonnegative", "OutboxMessage_state_shape", "OrganisationPaymentSettings_online_provider", "OrganisationPaymentSettings_currency_code", "OrganisationPaymentSettings_webhook_path_shape", "ProcessedWebhookEvent_online_provider", "Order_pending_hold", "Order_nonnegative_amounts", "OrderLine_amounts", "RSVP_pending_payment_hold", "Payment_positive_amount", "Payment_paid_shape", "PaymentRefund_positive_amount", "TicketType_price_nonnegative", "RSVP_ticketTypeId_fkey", "EventInstance_positive_capacity", "EventSeries_currency_code", "EventSeries_refund_policy_shape", "Order_one_target", "PromoCode_one_target", "TicketType_one_target", "TicketType_access_code_shape", "TicketType_pricing_shape", "TicketType_group_and_fee", "OrderLine_kind_target", "AddOn_one_target", "AddOn_amounts", "Event_transfer_cutoff", "EventSeries_transfer_cutoff", "PaymentDispute_shape", "Event_refund_policy_shape", "Payment_offline_shape", "PromoCode_discount_shape", "PromoCode_digest_shape", "PaymentAmendment_known_field", "ShortLinkClickDay_count_nonnegative", "OrganisationPaymentSettings_receipt_shape", "Payment_method_shape", "OrganisationEmailSettings_shape", "UserDevice_shape", "ChatChannel_shape", "CheckInListRecord_known_source", "CheckInListEvent_known_action", "CheckInListEvent_known_source", "Event_team_min_size_positive", "Event_team_max_size_at_least_two", "Event_team_size_order", "Event_team_mode_requires_max_size", "TeamSeekerProfile_skills_limit", "RSVP_teamId_fkey", "Team_eventId_fkey", "Team_leaderRsvpId_fkey", "Submission_exactly_one_entrant", "Submission_links_https", "Event_submission_window_order", "SubmissionLink_token_hash_shape", "JudgingCriterion_weight_range", "JudgingCriterion_max_score_range", "JudgeScore_score_range", "EventAwardWinner_place_positive", "Event_reviews_per_project_range", "JudgingRound_name_length", "JudgingRound_position_positive", "JudgingRound_reviews_per_project_range", "JudgingRound_window_order", "JudgingRound_first_takes_all", "JudgingRound_finalized_shape", "JudgingRoundEntry_source_rank_positive", "JudgingAssignmentRun_shape", "JudgingFinalistNotice_email_hash_shape", "JudgingCriterion_round_required", "JudgeAssignment_round_required", "JudgeReview_round_required", "Submission_teamId_fkey", "Submission_rsvpId_fkey", "SavedView_name_length", "SavedView_params_object", "SavedView_eventId_fkey", "Order_team_or_submission", "PrizePayout_shape", "Event_submission_fee_positive", "EventAward_prize_positive", "Event_finance_amounts", "ExpenseClaim_shape", "ExpenseReceipt_shape", "ClaimPayout_shape", "RefundRequest_shape", "TicketDesign_shape", "RSVP_crew_shape", "EventCrewMember_rsvpId_fkey", "MobileSession_shape", "MobileSession_refresh_history_limit", "MobileIdempotencyKey_shape", "Event_manual_close_snapshot_mode", "MentorProfile_shape", "HelpCategory_policy_bounds", "HelpRequest_one_origin", "HelpRequest_claim_shape", "HelpRequest_text_bounds", "HelpRequestComment_shape", "MentorTeamAssignment_end_shape", "MentorConflict_reason_length", "OfficeHourSlot_shape", "OfficeHourBooking_cancel_shape", "MentoringRound_window", "MentorTeamAssignment_activation_shape", "VolunteerShift_shape", "VolunteerShiftSignup_attendance_shape", "VolunteerAttendanceCorrection_shape", "VolunteerHours_shape", "VolunteerHoursEntry_shape", "ContributorCertificate_shape", "Event_admission_shape", "AdmissionStage_shape", "AdmissionApplication_shape", "AdmissionStageEntry_shape", "AdmissionReview_shape", "AdmissionReviewConflict_known_reason", "AdmissionAssignmentRun_shape", "AdmissionDecision_shape", "AdmissionAnswerRevision_person_key_shape", "AdmissionApplication_rsvpId_fkey", "AdmissionApplication_teamId_fkey"].filter((name) => !constraintNames.has(name)),
    ...(constraints.some((row) => row.conname === "EventCrewMember_rsvpId_fkey" && row.confdeltype === "c") ? [] : ["EventCrewMember_rsvpId_fkey:ON DELETE CASCADE"]),
    ...(constraints.some((row) => row.conname === "EventFeedbackAnswer_fieldId_fkey" && row.confdeltype === "n") ? [] : ["EventFeedbackAnswer_fieldId_fkey:ON DELETE SET NULL"]),
    ...(constraints.some((row) => row.conname === "RSVP_teamId_fkey" && row.confdeltype === "n") ? [] : ["RSVP_teamId_fkey:ON DELETE SET NULL"]),
    ...(constraints.some((row) => row.conname === "Submission_teamId_fkey" && row.confdeltype === "c") ? [] : ["Submission_teamId_fkey:ON DELETE CASCADE"]),
    ...(constraints.some((row) => row.conname === "Submission_rsvpId_fkey" && row.confdeltype === "c") ? [] : ["Submission_rsvpId_fkey:ON DELETE CASCADE"]),
    ...(constraints.some((row) => row.conname === "SavedView_eventId_fkey" && row.confdeltype === "c") ? [] : ["SavedView_eventId_fkey:ON DELETE CASCADE"]),
    ...["Asset_key_key", "RSVP_event_attendee_unique", "RSVP_instance_attendee_unique", "ApiClient_organisationId_status_idx", "ApiCredential_apiClientId_revokedAt_idx", "OrganisationPaymentSettings_webhookPathId_key", "ProcessedWebhookEvent_organisationId_provider_eventId_key", "Payment_one_pending_per_order", "PaymentCheckoutAttempt_provider_externalId_key", "PromoCode_eventId_codeDigest_key", "PromoCode_eventSeriesId_codeDigest_key", "CheckInList_eventId_active_name_key", "CheckInListRecord_listId_rsvpId_key", "Team_eventId_nameKey_key", "Team_joinToken_key", "Team_manageTokenHash_key", "TeamJoinRequest_one_pending_per_team_rsvp", "Submission_teamId_key", "Submission_rsvpId_key", "SubmissionLink_tokenHash_key", "JudgeScore_submissionId_judgeUserId_criterionId_key", "JudgeReview_roundId_submissionId_judgeUserId_key", "JudgeAssignment_roundId_judgeUserId_submissionId_key", "JudgingRound_eventId_position_key", "JudgingRound_one_open_per_event", "JudgingRoundEntry_roundId_submissionId_key", "JudgingFinalistNotice_roundId_emailHash_key", "EventAwardWinner_awardId_place_key", "EventAwardWinner_awardId_submissionId_key", "SavedView_eventId_surface_idx", "RefundRequest_one_open_per_order", "ExpenseReceipt_storageKey_key", "RSVP_eventId_createdAt_id_idx", "RSVP_eventId_checkedInAt_id_idx", "Team_eventId_createdAt_id_idx", "Submission_eventId_createdAt_id_idx", "Submission_eventId_status_submittedAt_id_idx", "EventInvite_eventId_createdAt_id_idx", "HelpRequest_one_claim_per_mentor", "MentorTeamAssignment_live_unique", "MentorConflict_live_kind", "OfficeHourBooking_live_team_slot", "MentoringRound_one_live", "MentorProfile_eventId_userId_key", "HelpCategory_eventId_key_key", "MentoringCheckIn_roundId_teamId_key", "MentoringVisit_roundId_teamId_key", "ContributorCertificate_one_live_per_member", "VolunteerShiftSignup_shiftId_crewMemberId_key", "AdmissionDecisionBatch_one_draft_per_event", "AdmissionStatusEvent_unsent_idx", "AdmissionApplication_rsvpId_key", "AdmissionApplication_teamId_key", "AdmissionStage_eventId_position_key", "AdmissionStageEntry_stageId_applicationId_key", "AdmissionReviewAssignment_stageId_applicationId_reviewerUse_key", "AdmissionReview_assignmentId_answersRevision_key"].filter((name) => !indexNames.has(name)),
    ...["audit_fallback_organisation", "audit_fallback_membership", "audit_fallback_event", "audit_fallback_eventseries", "audit_fallback_organisationinvite", "audit_fallback_eventinvite", "audit_fallback_seriesinvite", "audit_fallback_rsvp", "audit_fallback_eventcollaborator", "audit_fallback_eventcollaboratorinvite", "audit_fallback_apiclient", "audit_fallback_apiclientscope", "audit_fallback_apicredential", "payment_ledger_guard", "payment_refund_guard", "checkout_attempt_guard", "event_currency_lock", "payment_amendment_append_only", "rsvp_waitlist_dates", "ticket_type_target_fixed", "rsvp_ticket_type_target", "promo_code_ticket_type_target", "series_currency_lock", "judging_criterion_round", "judge_assignment_round", "judge_review_round", "judging_round_entry_event", "event_current_judging_round", "event_judging_round_mirror", "help_request_activity_append_only", "help_request_comment_append_only", "mentor_assignment_run_append_only", "office_hour_change_append_only", "mentoring_check_in_append_only", "mentor_nomination_append_only", "volunteer_hours_entry_guard", "volunteer_hours_guard", "volunteer_correction_append_only", "admission_application_shape", "admission_stage_entry_event", "admission_assignment_event", "admission_review_event", "admission_decision_guard", "admission_conflict_event", "admission_review_append_only", "admission_answer_revision_append_only", "admission_stage_entry_append_only", "rsvp_admission_application", "team_admission_application", "rsvp_admission_status_guard", "team_admission_status_guard", "rsvp_admission_accept", "team_admission_accept", "admission_application_keep", "rsvp_admission_registration_guard", "team_admission_registration_guard", "rsvp_admission_withdraw", "team_admission_withdraw", "admission_status_event", "user_admission_scrub"].filter((name) => !triggerNames.has(name)),
  ];
  // Attendance confirmation (docs/ATTENDANCE.md, 20261111000000_attendance_confirmation).
  const [attendanceTables, attendanceColumns, attendanceConstraints, attendanceIndexes] = await Promise.all([
    prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'AttendanceCheck'`,
    prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Event' AND column_name = 'attendanceCheckReleaseOnDecline'`,
    prisma.$queryRaw`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE conname IN ('AttendanceCheck_token_hash_shape', 'AttendanceCheck_note_length', 'AttendanceCheck_response_pair', 'AttendanceCheck_release_outcome', 'AttendanceCheck_rsvpId_fkey', 'AttendanceCheck_eventId_fkey', 'AttendanceCheck_refundRequestId_fkey')
    `,
    prisma.$queryRaw`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('AttendanceCheck_rsvpId_key', 'AttendanceCheck_tokenHash_key', 'AttendanceCheck_eventId_response_idx', 'AttendanceCheck_refundRequestId_idx')`,
  ]);
  const attendanceConstraintNames = new Set(attendanceConstraints.map((row) => row.conname));
  const attendanceIndexNames = new Set(attendanceIndexes.map((row) => row.indexname));
  missing.push(
    ...(attendanceTables.length ? [] : ["AttendanceCheck"]),
    ...(attendanceColumns.length ? [] : ["Event.attendanceCheckReleaseOnDecline"]),
    ...["AttendanceCheck_token_hash_shape", "AttendanceCheck_note_length", "AttendanceCheck_response_pair", "AttendanceCheck_release_outcome", "AttendanceCheck_rsvpId_fkey", "AttendanceCheck_eventId_fkey", "AttendanceCheck_refundRequestId_fkey"].filter((name) => !attendanceConstraintNames.has(name)),
    ...(attendanceConstraints.some((row) => row.conname === "AttendanceCheck_refundRequestId_fkey" && row.confdeltype === "n") ? [] : ["AttendanceCheck_refundRequestId_fkey:ON DELETE SET NULL"]),
    ...["AttendanceCheck_rsvpId_fkey", "AttendanceCheck_eventId_fkey"].filter((name) => !attendanceConstraints.some((row) => row.conname === name && row.confdeltype === "c")).map((name) => `${name}:ON DELETE CASCADE`),
    ...["AttendanceCheck_rsvpId_key", "AttendanceCheck_tokenHash_key", "AttendanceCheck_eventId_response_idx", "AttendanceCheck_refundRequestId_idx"].filter((name) => !attendanceIndexNames.has(name)),
  );
  if (missing.length > 0) {
    throw new Error(`Database schema contract failed; missing: ${missing.join(", ")}`);
  }
  // A release that reserves a new top-level route must not hide an existing
  // organisation's public page behind it.
  const shadowed = await prisma.$queryRaw`SELECT slug FROM "Organisation" WHERE lower(slug) = ANY(${[...reservedOrganisationSlugs]}::text[]) ORDER BY slug`;
  const slugProblem = reservedSlugProblem(shadowed.map((row) => row.slug));
  if (slugProblem) throw new Error(slugProblem);
  console.log("Database schema contract passed.");
} finally {
  await prisma.$disconnect();
}

import { test } from "@playwright/test";
import { setUpCrewSmokeSuite } from "./helpers/crew-smoke";
import { crewSmokeAddEditTests } from "./helpers/crew-smoke-steps-a";
import { crewSmokeLinkPageDeskTests } from "./helpers/crew-smoke-steps-b";

// Event crew organiser smoke (docs/CREW.md). One serial story that drives the
// real dashboard as the organisation OWNER: add, validate, edit, reorder,
// show/hide, convert a registration, the People view, the sign-up link, the
// public Crew section, the crew ticket page, the check-in desk and removal.
// tests/e2e/crew.spec.ts covers the link page, link sign-up, capacity on the
// public card and section privacy; this spec does not repeat those.
test.describe.configure({ mode: "serial", timeout: 180_000 });

setUpCrewSmokeSuite();
crewSmokeAddEditTests();
crewSmokeLinkPageDeskTests();

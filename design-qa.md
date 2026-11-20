# Lead card QA — 2026-11-20

final result: passed

Scope: the owner's requested creation-time and responsible-name rows on the
existing AgentCore funnel card, not a full-page redesign.

- Source: owner's attached lead-card screenshot in this conversation (684 × 309
  pixels). Contains name/phone, clock + date/time/elapsed text, user + full name.
- Implementation: `apps/web/test-results/lead-card-details-lead-car-5a769-e-name-in-every-UI-language-chromium/lead-card-desktop.png`
  and `lead-card-mobile.png` in the same directory, captured by
  `e2e/lead-card-details.spec.ts` (generated, not committed).
- Viewports: 1280 × 800 and 320 × 740, deviceScaleFactor 1. Card crops are
  270 × 206 and 278 × 207 pixels. Source apparent scale is approximately 2×;
  compare readable row hierarchy at CSS scale, not raw raster pixel dimensions.
- State: Uzbek, fictional Zarina/Muzaffar, creation yesterday at 10:17, 14 hours
  elapsed. Source shows select mode; test captures normal browsing mode.
- Both implementation crops were opened and compared with the attached source.

Findings: no blocking mismatches in the requested rows. Clock and user icons,
muted metadata and a strong customer name follow the reference. Full owner name
is visible. Date and owner rows fit at 320 px; long text may wrap instead of hiding.

Fidelity surfaces: existing product font and sizes retained; row spacing and icon
alignment checked; existing canvas/border/muted tokens retained; no new raster
assets required; exact Uzbek example and en/ru equivalents verified in Chromium.
The existing channel and AI/tag metadata remain below the requested rows; the
normal-mode drag handle replaces the select-mode checkbox. These are intentional
existing product behaviors, not pixel-identical cloning of the source crop.

Verification: 7 lead e2e tests, three locales, semantic timestamp, card navigation,
mobile overflow assertion and axe WCAG checks passed. Creation/updated-time
separation, elapsed refresh, DST and missing-owner cases covered by unit tests.

Residual gaps: staging and native-speaker review not performed.

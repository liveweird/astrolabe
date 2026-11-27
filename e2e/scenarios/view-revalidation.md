# View revalidation (a rename made elsewhere reaches an open page; an unchanged page is a 304)

- **Spec**: [tests/view-revalidation.spec.ts](../tests/view-revalidation.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`) in the browser; the same account through the API for seeding, the rename and teardown
- **Owns** (exclusive server-side state): ONE throwaway team (`e2e-reval-team-*`, renamed to `e2e-reval-renamed-*` by the test) with no manager and no milestone, seeded through the API in the test and removed through the API in the afterEach. Nothing dated, no plan node, no ranking, no holiday, no connection, no lock. The plan is shared by four workers and its revision is part of every plan view's document, so the last step waits for a moment without a plan write (up to ten reads) instead of assuming one.

The SPA keeps the last answer of each view read and its `ETag` in the page's memory only, so every navigation below stays INSIDE the single-page app (the sidebar's Teams entry, never a reload).

## Scenario: a team renamed elsewhere shows on its page at the next read, and an unchanged page is answered 304

1. The administrator signs in, opens Teams from the menu, filters by the spec's team name and opens the team.
   - *Expected*: the page's `GET /api/v1/views/team/<id>` answered `200` and carried no `If-None-Match`; the heading (h2) is the team's name.
2. The team is renamed through the API (a write that moves no plan revision). They open Teams from the menu again, filter by the NEW name and open the team.
   - *Expected*: the page's read of the view carried `If-None-Match` and answered `200` (the old tag no longer matches); the heading shows the new name.
3. They go to Teams and back to the team, at most ten times, until one read of the view answers `304` (another worker's plan write between two reads turns a read into a `200`: the plan's revision is in the document).
   - *Expected*: every read carried `If-None-Match`; one read answered `304`; the heading still shows the new name after each read; no "Could not load the team" alert.

## Not covered here (and why)

- The other nine reads that answer through a validator: the server's sweep (`ViewValidatorsTest`) and the SPA's table-driven wrapper test cover them.
- The session boundary (a sign-out or another tab's sign-in forgetting the kept documents) and a `304` after a failed write: vitest (`api/revalidate.test.ts`, `utils/sessionQueryCache.test.ts`, `pages/Teams.load.test.tsx`).
- A cross-origin deployment (`If-None-Match` allowed and `ETag` exposed): `ServerTest`.

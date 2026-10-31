# Roadmap (the global project ranking)

- **Spec**: [tests/roadmap.spec.ts](../tests/roadmap.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`); in each test one throwaway user (the roadmap editor in the first,
  a plain user in the second)
- **Owns** (exclusive server-side state): its throwaway people, work streams, programs and projects (unique `e2e-rm-*` names)
  and users, all deleted by the end of the file (the plan nodes and people also by the afterEach, through the API, children first,
  when a step fails first; deleting a project also removes it from the ranking). The ranking itself is ONE global list shared with
  every other spec's plan writes: this file ranks only its own projects, asserts only the relative order of its own rows, and
  retries a ranking change that the server refuses as stale (another spec wrote the plan meanwhile).

## Scenario: an admin grants the roadmap editor right; the editor ranks two projects, reorders them by keyboard and by drag, and unranks one

1. The admin signs in, creates a throwaway user through the Users page and seeds, through the API, a person, a work stream, a
   program and two projects ("first" and "second"). They open Users, filter to the throwaway user, choose **Permissions for <user>**
   from the row menu, switch **Roadmap editor** on and Save. They sign out.
   - *Expected*: the Permissions page opens with the switch off; Save returns to the Users list.
2. The throwaway user signs in and opens **Roadmap** from the Planning section of the sidebar.
   - *Expected*: the page heading is "Roadmap" with an "Unranked" section; both projects are in the Unranked table.
3. They press **Rank <first>**, then **Rank <second>**.
   - *Expected*: the ranked list shows first, then second (Rank appends at the end); the first project has left the Unranked table.
4. They focus **Move up <second>** and press Enter.
   - *Expected*: the order is second, first; keyboard focus is still inside the second project's row (on the same button, or its
     twin when the row reached the top); the screen-reader status says "<second> moved to position …".
5. They focus **Drag <first>** and use dnd-kit's keyboard sensor: Space to pick up, ArrowUp to move over the row above, Space to drop.
   - *Expected*: the live region announces the row it is over; the order is first, second.
6. They drag **<second>** by its handle with the pointer onto the first project's row.
   - *Expected*: the order is second, first.
7. They press **Unrank <second>**.
   - *Expected*: the ranked list holds first; second is back in the Unranked table.
8. The plan changes under the open page: the admin's API rewrites the ranking (same list, so the plan revision moves). The user presses
   **Rank <second>**.
   - *Expected*: the server answers 409; the page says "The roadmap changed in the meantime", reloads, and second is still unranked.
9. They press **Rank <second>** again.
   - *Expected*: the change goes through; the order is first, second.
10. The user signs out; the admin signs back in and deletes the user (the plan nodes and people are removed through the API).

## Scenario: a user without the roadmap right sees the ranked list read-only

1. The admin creates a throwaway user through the Users page and seeds, through the API, a person, a work stream, a program and three
   projects; two of them are ranked through the API (first, second), the third is not. They sign out.
2. The user signs in and opens `/roadmap`.
   - *Expected*: the ranked table lists first then second with their target window "2026-02-02 – 2026-03-31"; the third is in the
     Unranked table; the page says everyone can read the list.
   - *Expected*: there is no **Drag**, **Move up**, **Move down**, **Unrank** or **Rank** button anywhere on the page, and no button at all in the page's main area.
3. The user signs out; the admin signs back in and deletes the user.

## Not covered here (and why)

- **The optimistic rollback on a non-409 failure, the 400 and 403 sentences, the ignored change while a save is in flight, the
  empty states and the exact PUT bodies** - pinned by `Roadmap.test.tsx`, `roadmapOrder.test.ts` and the server's `RoadmapRankingTest`;
  the journeys drive the real browser paths (focus, dnd-kit's sensors, the stale notice).
- **The pointer drag's announcements** - dnd-kit's live region is covered through the keyboard drag (step 5) and by
  `roadmapAnnouncements.test.ts`; the pointer path only has to produce the same drop.

# People (the people directory)

- **Spec**: [tests/people.spec.ts](../tests/people.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`); one throwaway user per test (the first
  links it as the person's login, the second signs in as a regular reader)
- **Owns** (exclusive server-side state): its throwaway people (unique `e2e-person-*` /
  `e2e-person-ro-*` / `e2e-person-resp-*` names), users, and, in the third scenario, a team, a work
  stream, a program and a project (`e2e-person-team-*`, `-stream-*`, `-program-*`, `-project-*`) — all
  deleted by the end of the file (people, and the third scenario's plan nodes and team, by the afterEach,
  through the API, children first)

## Scenario: admin creates a person, links a login, renames them, and deletes them

1. The admin signs in and creates a throwaway user through the Users page.
2. On the People page they click **New person**, fill a unique name and an email, and Create.
   - *Expected*: the app lands on the new person's page — the name as the heading, "Email: <the email>", "No login".
3. They click **Edit**, change the name, search the **Login** picker for the throwaway user, pick them
   (the option reads "name (email)"), and Save.
   - *Expected*: the heading shows the new name and the page reads "Login: <the user's email>".
4. Back on the People list they filter by the new name.
   - *Expected*: the person's row lists the linked login's email.
5. They delete the person from the row menu.
   - *Expected*: the row is gone; the throwaway user is deleted afterwards.

## Scenario: a regular user sees the read-only people list

1. The admin creates a throwaway user and seeds a throwaway person with an email through the API, then signs out.
2. The user signs in and opens the People page, filtering by the person's name.
   - *Expected*: the person is listed as a link with their email visible; there is no **New person** button and no row menu.
3. They open the person.
   - *Expected*: the person page renders with the name as the heading and without the **Edit** button.
4. The admin signs back in and deletes the user (the person is removed through the API).

## Scenario: a person's page lists the team they manage and the work stream, program and project they own, each a link to its page

1. The admin seeds a throwaway person through the API, a team they manage, a work stream they own with a
   program and a project they own, and signs in.
2. They open the person's page.
   - *Expected*: the name is the heading; "Teams managed" lists the team, "Work streams owned" the work
     stream, "Programs owned" the program and "Projects owned" the project, each as a link ("Open team …",
     "Open work stream …", …); none of the empty sentences ("Manages no team", "Owns no project") shows.
3. They click the team's link.
   - *Expected*: the team's page opens (`/teams/<id>`) with the team's name as the heading.
4. They go back and click the project's link.
   - *Expected*: the project's page opens (`/projects/<id>`) with the project's name as the heading.
5. They go back and click the work stream's link.
   - *Expected*: the Roadmap opens narrowed to that work stream (`workStreamId=<id>` in the address).

## Not covered here (and why)

- **Validation, conflicts and the delete refusal (empty name, malformed email, duplicate email, a login linked
  twice, deleting a team's manager)** — pinned by the server's `PersonTest` and the SPA's
  `People.test.tsx`/`PersonDetails.test.tsx`; the journey drives the happy path only.

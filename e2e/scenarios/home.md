# Home (the plan's figures and what you manage)

- **Spec**: [tests/home.spec.ts](../tests/home.spec.ts)
- **Actors**: two throwaway logins seeded through the API — an OWNER whose linked person owns a work stream, a program and a project and manages a team, and a login linked to NO person; a second person linked to no login, who owns a second project in the owner's program; the seed administrator acts only through the API (seeding and teardown)
- **Owns** (exclusive server-side state): the two logins (`e2e-home-owner-*`, `e2e-home-nobody-*`), the owner's person, one team that person manages, one work stream, program and project that person owns (the project with the target window 2027-03-01 to 2027-03-05) two milestones of the project on the team (one scheduled 2027-03-08 to 2027-03-12, one left unscheduled), a second person (`e2e-home-other-*`) with no login who owns a second project without milestones (`e2e-home-other-project-*`) in the owner's program, unique `e2e-home-*` names, all seeded through the API in the beforeAll and removed through the API in the afterAll (the second project and person first, then the milestones, then the project), even after a failure. Dated March 2027 on purpose: the two flags it pins are drift in CALENDAR days (the end 7 days late is a warning, the start 7 days late an info), so no holiday and no far-off year is needed. It writes no ranking, no holiday and no connection, and needs no lock. Four workers share the plan, so a plan-wide figure is never asserted as a value.

## Scenario: the Home page shows a person the projects, teams, programs and work streams that are theirs, with what is flagged and not scheduled, and a name opens its page

1. The owner signs in.
   - *Expected*: the heading "Yours" (h3) and "Your login is linked to the person <name>."
2. They read the table "Your projects".
   - *Expected*: exactly two rows, found by their project's name (never by position): the owner's own project (its name as a link "Open project <name>", its program, the Owner cell reading the owner's person, "Unranked", 2 milestones, 1 not scheduled, "1 warning" and "1 info") and the second person's project (its program, the Owner cell reading the second person, "Unranked", 0 milestones).
3. They read "Your teams" and "Your programs and work streams".
   - *Expected*: exactly one team row (its link "Open team <name>", 2 milestones, 1 not scheduled); exactly two node rows, the work stream first and the program second, each with an Owner cell reading the owner's person, 2 projects, "1 warning" and "1 info" (the work stream with 1 program, the program naming its work stream); the "Open the roadmap overview" link; the sentence "Listed below: what you own, everything under a work stream or program you own, and the teams you manage." One axe scan of the page.
4. They click the project's name, go back to Home, click the team's name.
   - *Expected*: the project page's heading (h2), then the team page's.

## Scenario: the Home page shows the plan in figures on its cards and tells a login without a person that nothing is linked to it

1. The login without a person signs in.
   - *Expected*: under "Yours" the sentence "Your login is not linked to a person…"; the group "The plan in figures" holds a count of projects and a count of milestones and the group "The roadmap in figures" a count of ranked projects (each matched as a number with its word, never as a value); no table on the page and no link to the People page (that link is the administrator's).

## Scenario: a figure under Yours opens the list it counts, and the owner's projects open on the roadmap filtered to them

1. The owner signs in and clicks the owner's own project row's "1 not scheduled" link (its accessible name carries the project's name).
   - *Expected*: the project's page (h2 its name) at `?milestones=unscheduled`, its Milestones table with the Schedule select reading "Not scheduled" and exactly one row, the unscheduled milestone.
2. Back on Home they click "Open the projects you own yourself on the roadmap".
   - *Expected*: the Roadmap (h2) whose timeline holds exactly one project, the owner's own project (its "Open project <name>" link; the second person's project is not there), and the Owner filter reads the owner's person.
3. Back on Home they click the team row's "1 not scheduled" link.
   - *Expected*: the team's page (`/teams/<id>`), its Unscheduled tray holding the unscheduled milestone.

## Scenario: the Home page can narrow Yours to what the person owns themselves, and remembers the choice in this browser

1. The owner signs in.
   - *Expected*: the switch "Only what I own myself" above the tables is off and "Your projects" has two rows.
2. They turn the switch on.
   - *Expected*: the sentence "Listed below: what you own yourself and the teams you manage."; "Your projects" has exactly one row, the owner's own project (the second person's project is gone); "Your programs and work streams" still has its two rows (the work stream and the program are the owner's own); "Your teams" still has its one row; the link "Open the projects you own yourself on the roadmap" is shown.
3. They reload the page.
   - *Expected*: the switch is still on and the second person's project is still out (the choice is kept in this browser).
4. They turn the switch off.
   - *Expected*: "Your projects" has two rows again, the second person's project among them.

## Not covered here (and why)

- The values of the plan-wide figures: four workers share the plan; vitest and `HomeViewTest` pin them.
- The plan card's and the roadmap card's figure links (not scheduled yet, warnings, infos, the two capacity badges) and a work stream's or program's name link: they are plan-wide or need a ranking/capacity write; vitest pins the hrefs and the Roadmap side is `roadmap.md`'s last scenario.
- The Jira and Flow figures, both "may be out of date" sentences and the capacity badges: they need a connection, a run or a capacity period per test (vitest and the server tests pin them).
- The administrator's People link and the Polish text (vitest).
- A work-stream owner who owns no project, a table the switch empties ("You do not own any of the listed projects yourself.") and the 100-row cap: they need a second login or 100 rows (vitest and `HomeViewTest`).

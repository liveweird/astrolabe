# Projects view

Owns: the Projects nav leaf and its two routes, the project picker, the remembered project, the bare `/projects` and its empty states. Not here: the project page's body (timeline, dependencies, editors: `web-internals.md` "Project view", `timeline.md`), the plan view the picker reads (`planning-model.md` "The view documents"), the nav model and the palette (`web-internals.md` "Navigation"). Added in 1.29.

## Rules

- **One page, two routes.** `projects` (no project) and `projects/:id` both render `pages/ProjectView.tsx`: without an id it renders `components/ProjectsStart.tsx`, with one `ProjectPage`. There is no second page component and no server endpoint of its own; the picker reads the cached plan view (`planViewKey`), so it costs no request the Plan page does not already make.
- **The picker is the only way between projects**, and the loaded page has no back link (the Plan is one nav click away). The not-found state keeps a link to `/projects` and shows the picker with nothing picked.
- **A pick is a push** (`navigate(projectPath(id))`), so Back returns to the project before. Picking the project already shown goes nowhere. The control is never clearable and never deselects (`clearable={false}`, `allowDeselect={false}`).
- **The bare page redirects by `replace`**, so Back never returns to a redirect. A project is forgotten only on a fresh SUCCESSFUL answer of the plan view that lacks it ("The remembered project"): a cached view may predate it, and a failed or paused read says nothing about it.
- **The Projects leaf owns every `/projects…` path.** Plan carries no `activeFor` for it (two leaves would tie on length in `activeNavPath`, and array order would decide).

## The picker (`components/ProjectPicker.tsx`)

- A Mantine `Select` in `PageHeader`'s `switcher` slot (above the title, where a back link sits; hidden in print, `data-print="hide"`; `EditPageLoadState` passes it through for the load and not-found states). Its accessible name is `common.filter.project` ("Project"): there is no visible label, and the name never repeats the role.
- **Options** (`utils/projectPicker.ts`, pure): one group per program, labelled "Work stream › Program"; a closed work stream (an end date) carries `project.picker.closedStream` after its name. Open streams first, then by name; programs and projects by name (`openFirstByName`, `byNameThenId`): the plan view's shared order is a hand arrangement only the Plan and Programs pages draw.
  A program with no project has no group. A project the plan view does not hold (a page still loading its view, a stale cache) stands alone, ungrouped and last, named by the page that loaded it (`currentName`), so the control never shows a blank for a project on screen.
- **The filter** (`projectOptionsFilter`) replaces the theme's `foldedOptionsFilter` for this one control and keeps its contract (a group keeps the items that match and disappears when none does; an ungrouped option is matched by its own label). Each item carries a `search` string: the project's own name, its program's, its work stream's and its OWNER's (the project's, not the program's or the stream's), matched case- and accent-insensitively (`foldDiacritics`). Typing "ola" or a program's name therefore finds the projects.

## The remembered project

- **`projects.last`** (`astrolabe.viewSettings.projects.last`, `hooks/useLastProject.ts`): a project id. It is written once a project page has LOADED (any way in: the picker, a link, the address; a project that does not exist is never remembered), never read as state: only the bare page reads it, once on arrival.
- **A bare `/projects`** decides by the plan view, in this order:
  - a plan view, CACHED or fresh, that holds the remembered id: redirect (`replace`) at once, no wait;
  - otherwise, with an id remembered, wait for a fresh answer (`isFetchedAfterMount` and success); success that lacks the id: `forgetLastProject` and the empty state;
  - an error, with or without a cache: the failure alert (`ErrorAlert`), never an empty plan, and nothing is forgotten;
  - paused (offline, `fetchStatus` "paused"): nothing is forgotten and nothing spins. A cached plan gives the empty state with the picker and a dimmed note (`project.offline`); without a cache an alert says the server cannot be reached;
  - with nothing remembered the plan (cached or not) is all there is to wait for.
- **Deleting a project** forgets it (only when it is the remembered one) and still lands on the Plan.
- A stored value that is not a positive integer reads as none.

## Empty states

- **No project picked** (the plan holds projects, nothing remembered or the remembered one is gone): h2 "Projects", one sentence, the picker, "No project picked".
- **No projects yet** (the plan holds none): the same title and sentence, "No projects yet" with a hint and a link to the Plan; no picker (nothing to pick).

## Tests

`utils/projectPicker.test.ts` (grouping, order, the filter), `components/ProjectPicker.test.tsx` (the control: groups, owner/program/accent search, push, no clear), `hooks/useLastProject.test.tsx`, `pages/ProjectView.start.test.tsx` (the redirect, the cache hit, the waiting, the forget rules, a failed refetch and the offline states, the empty states, the heading outline), `ProjectView.test.tsx` (remember on load, forget on delete, the picker on the loaded and not-found pages); e2e:
`projects.spec.ts` (the remembered project, the picker finding a project by its program) and the `/projects` axe scan.

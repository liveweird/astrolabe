# Projects (the picker and the remembered project)

- **Spec**: [tests/projects.spec.ts](../tests/projects.spec.ts)
- **Actors**: the seed administrator, who also seeds through the API; nothing is written through the UI
- **Owns** (exclusive server-side state): its throwaway people (a lead and two project owners), work stream, program and two projects
  (unique `e2e-pp-*` names), seeded through the API and removed by the afterEach through the API (the projects first, then the program,
  the work stream and the people). The page's remembered project is browser state (`astrolabe.viewSettings.projects.last`): every
  test signs in through `login`, which clears the browser's storage first.

## Scenario: a bare /projects opens the project viewed last in this browser and forgets one that was deleted

1. The administrator signs in and opens `/projects` in a browser that remembers nothing.
   - *Expected*: the page is headed "Projects", says "No project picked" and offers the picker (a combobox named "Project").
2. They open the first seeded project's page, then the second's, then `/projects` again.
   - *Expected*: the bare address is replaced by the second project's page (the last one viewed), and its heading is the project's name.
3. The second project is deleted through the API, and they open `/projects` again.
   - *Expected*: nothing is opened: the page stays on `/projects` and says "No project picked" (the remembered project is forgotten).

## Scenario: the picker finds a project by its program's name or its owner's and a pick opens it as a history entry

1. The administrator opens the first seeded project's page.
   - *Expected*: the picker sits above the title and shows the project's name; there is no "Back to …" link.
2. They open the picker and type the program's unique name.
   - *Expected*: exactly the program's two projects are offered, by name.
3. They type the second project's owner's unique name.
   - *Expected*: only that owner's project is offered.
4. They pick it.
   - *Expected*: the address is that project's page, its name is the heading and the picker shows it.
5. They press the browser's Back button.
   - *Expected*: the first project's page is back (the pick was a push).

## Not covered here (and why)

- The grouping "Work stream › Program", the closed-stream mark, the accent folding and the picker's not being clearable: pinned by the
  unit tests (`projectPicker.test.ts`, `ProjectPicker.test.tsx`); the dropdown's axe scan is the closed control on `/projects`
  (`accessibility.spec.ts`).
- The empty "No projects yet" state: it needs a plan with no project, which the shared stack never has (`ProjectView.start.test.tsx`).

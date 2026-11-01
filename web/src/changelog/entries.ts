// The changelog is a build-time artifact: entries are authored here (newest first) and bundled
// into the SPA, so it can only change with a deploy — never at runtime. The newest entry's
// version must equal APP_VERSION in ./version.ts (the shell's eager import — this file stays
// out of the main bundle): a release adds the entry AND bumps that literal; entries.test.ts
// pins the pair. Bodies are markdown, one per language (content, not chrome — hence not in
// locales/); keep the phrases tests assert on in plain text runs, and follow the Polish style
// conventions (inclusive slash forms, active voice).
interface ChangelogEntry {
  version: string;
  /** Release date, YYYY-MM-DD. Keep the array strictly descending by date. */
  date: string;
  /** Markdown body, English. */
  en: string;
  /** Markdown body, Polish. */
  pl: string;
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: "0.5.0",
    date: "2026-11-01",
    en: `**Astrolabe 0.5.0: the team view and capacity.**

- Each team has its own page: the team's milestones on the timeline, across all projects, with the dependency arrows between them. The team's manager schedules them there by drag, keyboard or the schedule dialog.
- Capacity: the team's manager sets the man-days per week from any date, with an optional limit on milestones in progress at once (WIP). A week that a change splits counts each part by its working days.
- A weekly load strip under the dates shows each week's load against the capacity; an overloaded week, and a week over the WIP limit, are marked in orange. The weekly table under it gives the same figures in words. These are warnings only — nothing is moved.
- The team's order of work: the project ranking is only its starting point. The manager reorders milestones from the row menu (Move up, down, to top or to bottom) or by dragging a row's handle; Reset order brings back the project ranking. A later ranking change never reshuffles a team's own order — new milestones join at the bottom.
- The Roadmap ranking no longer fails as "changed in the meantime" because of unrelated plan edits.`,
    pl: `**Astrolabe 0.5.0: widok zespołu i przepustowość.**

- Każdy zespół ma swoją stronę: kamienie milowe zespołu na osi czasu, ze wszystkich projektów, ze strzałkami zależności między nimi. Kierownik/czka zespołu planuje je tam przeciąganiem, klawiaturą lub w oknie harmonogramu.
- Przepustowość: kierownik/czka zespołu ustala liczbę osobodni na tydzień od dowolnej daty, z opcjonalnym limitem kamieni milowych realizowanych jednocześnie (WIP). Tydzień podzielony zmianą liczy każdą część według jej dni roboczych.
- Pasek tygodniowego obciążenia pod datami pokazuje obciążenie każdego tygodnia na tle przepustowości; tydzień przeciążony i tydzień ponad limitem WIP są oznaczone na pomarańczowo. Tabela tygodniowa pod nim podaje te same liczby słowami. To tylko ostrzeżenia — nic nie przesuwa się samo.
- Kolejność pracy zespołu: ranking projektów jest tylko punktem wyjścia. Kierownik/czka zmienia kolejność kamieni milowych z menu wiersza (W górę, W dół, Na początek, Na koniec) lub przeciągając uchwyt wiersza; Resetuj kolejność przywraca ranking projektów. Późniejsza zmiana rankingu nigdy nie przestawia własnej kolejności zespołu — nowe kamienie milowe dołączają na końcu.
- Ranking na stronie Roadmapy nie kończy się już komunikatem „zmieniono w międzyczasie” z powodu niezwiązanych zmian w planie.`,
  },
  {
    version: "0.4.0",
    date: "2026-11-01",
    en: `**Astrolabe 0.4.0: dependencies.**

- Link milestones and projects, also across projects: finish-to-start, start-to-start, finish-to-finish and start-to-finish, with a lag in working days (a negative lag is a lead).
- A link that would close a cycle is refused, and the dialog names the cycle.
- The project page draws the links as arrows on the timeline; a milestone or project from another project appears as a grayed row with a link to its page.
- A link whose dates no longer hold is drawn in red and listed first under Dependencies with what it needs — nothing is ever moved automatically.
- The project's owners add and remove the links of their project; searchable milestone and project pickers find the other end.`,
    pl: `**Astrolabe 0.4.0: zależności.**

- Łącz kamienie milowe i projekty, także między projektami: koniec–start, start–start, koniec–koniec i start–koniec, z opóźnieniem w dniach roboczych (ujemne opóźnienie to wyprzedzenie).
- Zależność, która zamknęłaby cykl, jest odrzucana, a okno dialogowe wskazuje ten cykl.
- Strona projektu rysuje zależności jako strzałki na osi czasu; kamień milowy lub projekt z innego projektu pojawia się jako wyszarzony wiersz z odnośnikiem do jego strony.
- Zależność, której terminy nie są już dotrzymane, jest czerwona i wymieniona na początku sekcji Zależności wraz z tym, czego wymaga — nic nie przesuwa się samo.
- Właściciele/ki projektu dodają i usuwają zależności swojego projektu; wyszukiwarki kamieni milowych i projektów znajdują drugi koniec.`,
  },
  {
    version: "0.3.0",
    date: "2026-11-01",
    en: `**Astrolabe 0.3.0: the timeline and the project view.**

- Milestones in a project: a name, a description, one team and an estimate in man-days. The project's owners edit them; their dates are set by the manager of the milestone's team or by an administrator.
- The project page, on the new shared timeline: week, month and quarter zoom, hatched weekends, a today line, the project's target window as a band, and the project's real span with its drift against the target.
- Drag a bar to move it, or drag its edge to change its length; the keyboard and the schedule dialog do the same.
- The Unscheduled tray: drag a milestone onto the timeline, or press Schedule to give it its first week.
- A change someone else made in the meantime is detected and the timeline reloaded.
- Move a project to another program, or a program to another work stream (the owners above it or an administrator).`,
    pl: `**Astrolabe 0.3.0: oś czasu i widok projektu.**

- Kamienie milowe w projekcie: nazwa, opis, jeden zespół i szacunek w osobodniach. Właściciele/ki projektu je edytują, a terminy ustala kierownik/czka zespołu kamienia milowego albo administrator/ka.
- Strona projektu na nowej wspólnej osi czasu: przybliżenie Tydzień, Miesiąc i Kwartał, zakreskowane weekendy, linia „dziś”, okno docelowe projektu jako pas oraz faktyczny zakres projektu z odchyleniem od celu.
- Przeciągnij pasek, aby go przesunąć, albo jego krawędź, aby zmienić długość; to samo zrobisz klawiaturą i w oknie terminu.
- Taca „Niezaplanowane”: przeciągnij kamień milowy na oś czasu albo kliknij Zaplanuj, aby nadać mu pierwszy tydzień.
- Zmianę wprowadzoną w międzyczasie przez inną osobę wykrywamy i przeładowujemy oś czasu.
- Przenieś projekt do innego programu albo program do innego strumienia pracy (mogą to zrobić właściciele/ki wyżej w hierarchii albo administrator/ka).`,
  },
  {
    version: "0.2.0",
    date: "2026-10-31",
    en: `**Astrolabe 0.2.0: plan structure.**

- A people directory: the owners and managers of the plan are people, optionally linked to a login. A team's manager is now a person.
- Work streams, programs and projects, each with an owner. Owners edit what they own and everything below it; administrators edit everything. A project can carry a target window, and a work stream is closed by setting its end date.
- The Plan page: the whole hierarchy on one page, with the actions you are allowed to take.
- The Roadmap page: one global ranking of the projects. Drag a project to reorder it, or move it with the keyboard; unranked projects wait in their own group. A concurrent change is detected and the list reloaded.
- Administrators grant the "roadmap editor" permission, which allows ranking projects and setting their target windows.`,
    pl: `**Astrolabe 0.2.0: struktura planu.**

- Katalog osób: właściciele/ki i kierownicy/czki w planie to osoby, opcjonalnie powiązane z loginem. Kierownik/czka zespołu jest teraz osobą.
- Strumienie pracy, programy i projekty, każdy z właścicielem/ką. Właściciele/ki edytują to, co posiadają, i wszystko poniżej; administratorzy/rki edytują wszystko. Projekt może mieć okno docelowe, a strumień pracy zamykasz, ustawiając jego datę końcową.
- Strona Plan: cała hierarchia na jednej stronie, z działaniami, do których masz prawo.
- Strona Roadmapa: jeden globalny ranking projektów. Przeciągnij projekt, aby zmienić kolejność, albo przesuń go klawiaturą; projekty spoza rankingu czekają w osobnej grupie. Równoczesną zmianę wykrywamy i przeładowujemy listę.
- Administratorzy/rki nadają uprawnienie „edytor/ka roadmapy”, które pozwala ustalać ranking projektów i ich okna docelowe.`,
  },
  {
    version: "0.1.0",
    date: "2026-10-31",
    en: `**Astrolabe 0.1.0: the foundation.**

- Sign in with your email and password, with an emailed one-time code as the second step (email MFA), and reset a forgotten password by email.
- Administrators manage users and their feature flags; every user can change their own password.
- Teams, each with an optional manager.
- English and Polish, light and dark themes, and this changelog.
- An administrator's telemetry panel with the memory, storage, request and JVM figures of the server.
- The new Astrolabe look: a deep cyan brand and an astrolabe logo. Planning views arrive in 0.2.`,
    pl: `**Astrolabe 0.1.0: fundament.**

- Zaloguj się adresem e-mail i hasłem, z jednorazowym kodem wysłanym e-mailem jako drugim krokiem (MFA e-mailem), a zapomniane hasło zresetuj e-mailem.
- Administratorzy/rki zarządzają użytkownikami/czkami i ich flagami funkcji; każda osoba może zmienić własne hasło.
- Zespoły, każdy z opcjonalnym kierownikiem/czką.
- Język angielski i polski, jasny i ciemny motyw oraz ta historia zmian.
- Panel telemetrii dla administratorów/rek z danymi serwera o pamięci, przestrzeni dyskowej, żądaniach i JVM.
- Nowy wygląd Astrolabe: głęboki cyjanowy kolor marki i logo w kształcie astrolabium. Widoki planowania pojawią się w wersji 0.2.`,
  },
];

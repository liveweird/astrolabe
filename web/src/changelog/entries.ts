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
    version: "0.9.0",
    date: "2026-11-02",
    en: `**Astrolabe 0.9.0: baselines.**

- Baselines: the new Baselines page (Planning) keeps named copies of the whole plan. An administrator or a user with the roadmap-editor permission presses "Take baseline": every milestone's dates and estimate and every project's span are copied as they are now, and the copy can never be changed. Everyone can read them; they can be renamed or deleted, and up to 100 are kept.
- Compare with a baseline: open a baseline to see what moved since. A totals line counts the milestones whose end is later or earlier, the new, removed, newly scheduled, unscheduled and re-estimated ones; below it, every project that changed with its changed milestones. Start and end are counted separately, in working days on today's calendar, and an end later than the baseline is marked orange "Later". Filter by team or project name.
- On the timelines: the project, team, roadmap and programs pages have a "Baseline" picker (none by default; your pick is remembered in this browser for every page). With a baseline picked, a thin gray bar under each row shows its baseline dates, milestones removed or unscheduled since then get a dimmed row of their own, new ones are marked "new since the baseline", and the project and team pages list everything in a "Movement vs baseline" table. "Show on timeline" on the comparison page opens a project with that baseline picked.
- Schedule proposal: if the team's plan changes after a proposal was made (another milestone moved, capacity, a link or a holiday edited), accepting it now writes nothing; the page proposes again at once and keeps your ticks for the milestones that still move.
- Tables keep their text readable under the mouse in both light and dark themes.`,
    pl: `**Astrolabe 0.9.0: bazy odniesienia.**

- Bazy odniesienia: nowa strona Bazy odniesienia (Planowanie) przechowuje nazwane kopie całego planu. Administrator/ka lub osoba z uprawnieniem do edycji roadmapy naciska „Utwórz bazę odniesienia”: daty i estymaty wszystkich kamieni milowych oraz zakresy wszystkich projektów zostają skopiowane w obecnym kształcie, a kopii nie da się już zmienić. Każdy może je przeglądać; można zmienić ich nazwę lub je usunąć, a przechowywanych jest do 100.
- Porównanie z bazą odniesienia: otwórz bazę odniesienia, aby zobaczyć, co się od tego czasu przesunęło. Podsumowanie liczy kamienie milowe kończące się później lub wcześniej oraz nowe, usunięte, nowo zaplanowane, wycofane z harmonogramu i z nową estymatą; poniżej każdy zmieniony projekt wraz z jego zmienionymi kamieniami milowymi. Początek i koniec liczone są osobno, w dniach roboczych według dzisiejszego kalendarza, a koniec późniejszy niż w bazie odniesienia jest oznaczony na pomarańczowo jako „Później”. Można filtrować po zespole lub nazwie projektu.
- Na osiach czasu: strony projektu, zespołu, roadmapy i programów mają wybór „Baza odniesienia” (domyślnie brak; wybór jest zapamiętywany w tej przeglądarce dla wszystkich stron). Po wybraniu bazy odniesienia cienki szary pasek pod każdym wierszem pokazuje jego daty z bazy, kamienie milowe usunięte lub wycofane z harmonogramu od tego czasu dostają własny przygaszony wiersz, nowe są oznaczone jako nowe od utworzenia bazy, a strony projektu i zespołu zestawiają wszystko w tabeli „Przesunięcia względem bazy odniesienia”. „Pokaż na osi czasu” na stronie porównania otwiera projekt z wybraną tą bazą.
- Propozycja harmonogramu: jeśli plan zespołu zmieni się po przygotowaniu propozycji (przesunięty inny kamień milowy, zmieniona przepustowość, powiązanie lub święto), jej akceptacja niczego nie zapisuje; strona od razu przygotowuje nową propozycję i zachowuje zaznaczenie kamieni milowych, które nadal się przesuwają.
- Tabele pozostają czytelne pod kursorem myszy w jasnym i ciemnym motywie.`,
  },
  {
    version: "0.8.0",
    date: "2026-11-02",
    en: `**Astrolabe 0.8.0: the schedule proposal.**

- Propose schedule: on a team's page, the team's manager (or an administrator) presses "Propose schedule". Astrolabe places every milestone that has not started yet — unscheduled ones and those starting after today — in the team's milestone order, after its dependencies, from the earliest possible day, within the team's capacity and WIP limit and around public holidays. A milestone's length follows its estimate and its share of the capacity. Days without a capacity period, or on hold, are never used.
- Nothing changes until you accept. The proposal is shown on the team's timeline as dashed bars beside the current ones, with the proposed weekly load in the strip, and in the new "Proposed schedule" table: the current and proposed dates, how many working days each milestone moves, the links the proposal would break (in red) or mend, and the milestones that could not be placed and why.
- Accept all, or tick only some, and press "Accept selected". A milestone someone rescheduled after the proposal is skipped, the others are written, and a note says what happened. Accepting never adds an overloaded or over-WIP week.
- While a proposal is open, the team page is read-only except for Accept and Discard.`,
    pl: `**Astrolabe 0.8.0: propozycja harmonogramu.**

- Zaproponuj harmonogram: na stronie zespołu kierownik/czka zespołu (lub administrator/ka) naciska „Zaproponuj harmonogram”. Astrolabe układa każdy kamień milowy, który jeszcze się nie rozpoczął — niezaplanowane i te zaczynające się po dzisiejszym dniu — w kolejności kamieni milowych zespołu, po jego zależnościach, od najwcześniejszego możliwego dnia, w granicach pojemności i limitu WIP zespołu oraz z pominięciem świąt. Długość kamienia milowego wynika z jego szacunku i przypadającej na niego części pojemności. Dni bez okresu pojemności lub wstrzymane nigdy nie są używane.
- Nic się nie zmienia, dopóki nie zaakceptujesz. Propozycja widnieje na osi czasu zespołu jako przerywane paski obok obecnych, z proponowanym obciążeniem tygodniowym na pasku obciążenia, oraz w nowej tabeli „Proponowany harmonogram”: obecne i proponowane daty, o ile dni roboczych przesuwa się każdy kamień milowy, powiązania, które propozycja by naruszyła (na czerwono) lub naprawiła, oraz kamienie milowe, których nie udało się ułożyć, wraz z powodem.
- Zaakceptuj wszystko albo zaznacz tylko część i naciśnij „Zaakceptuj zaznaczone”. Kamień milowy, który ktoś przeplanował po propozycji, jest pomijany, pozostałe są zapisywane, a notatka mówi, co się stało. Akceptacja nigdy nie dodaje przeciążonego tygodnia ani tygodnia ponad limit WIP.
- Gdy propozycja jest otwarta, strona zespołu jest tylko do odczytu, z wyjątkiem przycisków Zaakceptuj i Odrzuć.`,
  },
  {
    version: "0.7.0",
    date: "2026-11-02",
    en: `**Astrolabe 0.7.0: the calendar and the critical path.**

- Public holidays: the new Public holidays page (Administration) lists the days off for a year. An administrator adds or removes a day by hand, or adds all Polish public holidays of a year with one button. Every working-day figure now skips them: dependency checks and lags, the spread of an estimate over a milestone's days, capacity and the WIP limit, the critical path and idle gaps. The timelines hatch a holiday like a weekend, and the day's header names it.
- A milestone must still cover at least one working day: a span made only of weekends or holidays is refused.
- The critical path: turn on "Critical path" in a project's timeline toolbar to see what drives the project's end. Critical milestones and links are outlined, a Slack column shows how many working days each milestone could slip before the project's end moves, and the "Critical chain" section lists the milestones and projects of other projects upstream — the whole chain, not only the direct neighbours. It is computed from the planned dates; nothing is moved.
- Idle gaps: a project or team page marks every run of 3 or more working days on which none of its milestones is in progress, as a hatched band, a badge and an "Idle gaps" table.
- A dependency's type and lag can now be edited in place ("Edit…" in the Dependencies table) instead of deleting and re-adding it.
- Accessibility: long option lists scroll by keyboard and pass the accessibility checks, and the close button of a notification is named.
- A slow request that stops sending data is cut off after 60 seconds (configurable).`,
    pl: `**Astrolabe 0.7.0: kalendarz i ścieżka krytyczna.**

- Święta państwowe: nowa strona Święta państwowe (Administracja) pokazuje dni wolne w danym roku. Administrator/ka dodaje lub usuwa dzień ręcznie albo jednym przyciskiem dodaje wszystkie polskie święta danego roku. Wszystkie wartości liczone w dniach roboczych je pomijają: sprawdzanie zależności i opóźnień, rozkład szacunku na dni kamienia milowego, pojemność i limit WIP, ścieżka krytyczna i przestoje. Osie czasu kreskują święto jak weekend, a nagłówek dnia podaje jego nazwę.
- Kamień milowy nadal musi obejmować co najmniej jeden dzień roboczy: okres złożony tylko z weekendów lub świąt jest odrzucany.
- Ścieżka krytyczna: włącz „Ścieżka krytyczna” na pasku osi czasu projektu, aby zobaczyć, co wyznacza jego koniec. Krytyczne kamienie milowe i powiązania są obrysowane, kolumna Luz pokazuje, o ile dni roboczych każdy kamień milowy może się przesunąć, zanim przesunie się koniec projektu, a sekcja „Łańcuch krytyczny” wymienia kamienie milowe i projekty innych projektów leżące przed nim — cały łańcuch, nie tylko bezpośrednich sąsiadów. Liczy się z planowanych dat; nic nie przesuwa się samo.
- Przestoje: strona projektu lub zespołu zaznacza każdy ciąg co najmniej 3 dni roboczych, w których nie trwa żaden z jego kamieni milowych — jako zakreskowany pasek, plakietkę i tabelę „Przestoje”.
- Typ i opóźnienie zależności można teraz edytować w miejscu („Edytuj…” w tabeli Zależności) zamiast usuwać ją i dodawać od nowa.
- Dostępność: długie listy opcji przewijają się z klawiatury i przechodzą testy dostępności, a przycisk zamknięcia powiadomienia ma nazwę.
- Wolne żądanie, które przestało przesyłać dane, jest przerywane po 60 sekundach (do skonfigurowania).`,
  },
  {
    version: "0.6.0",
    date: "2026-11-01",
    en: `**Astrolabe 0.6.0: the roadmap and programs timelines.**

- The Roadmap is now a timeline: one row per project in rank order, showing the span its milestones cover over its target window. Re-rank by dragging a row by its handle or from the row menu (Move up, down, to top or to bottom, Rank, Unrank); dragging a row across the "Unranked" divider ranks or unranks it.
- Flags compare the plan with the priority: a project ending after its target window is a warning, and so is a project whose work on a team starts before the work of the project ranked just above it on that team. A late start or finishing early is shown for information. Flags show on each row and in a Flags panel; "Show in timeline" takes you to the row. They are warnings only — nothing is moved.
- Arrows between projects show their dependencies, one arrow per pair of projects, red when a link no longer holds.
- Filters by work stream, team, owner and flagged only, and a pick of programs, remembered in your browser and shared with the Programs page.
- The new Programs page shows the plan as a tree: work streams, their programs and their projects, each with the span it covers and a count of its projects' flags. Expand and collapse from the keyboard or with Expand all / Collapse all.
- The target window can be set right on the timeline: move or resize its band, draw a new one across an empty row, or use "Edit target window…" and "Clear target window" in the row menu — by an administrator, an owner above the project or a holder of the roadmap-editor permission.
- A Year zoom: the Roadmap and Programs pages offer Month, Quarter (the default) and Year.`,
    pl: `**Astrolabe 0.6.0: osie czasu roadmapy i programów.**

- Roadmapa jest teraz osią czasu: jeden wiersz na projekt w kolejności rankingu, z okresem, który obejmują jego kamienie milowe, na tle okna docelowego. Ranking zmienia się, przeciągając wiersz za uchwyt lub z menu wiersza (W górę, W dół, Na początek, Na koniec, Dodaj do rankingu, Usuń z rankingu); przeciągnięcie wiersza przez separator „Bez rankingu” dodaje go do rankingu lub go z niego usuwa.
- Flagi porównują plan z priorytetami: ostrzeżeniem jest projekt kończący się po swoim oknie docelowym oraz projekt, którego praca w zespole zaczyna się przed pracą projektu stojącego w rankingu tuż nad nim w tym samym zespole. Późny start lub wcześniejsze zakończenie są pokazywane informacyjnie. Flagi widać w każdym wierszu i w panelu Flagi; „Pokaż na osi czasu” przenosi do wiersza. To tylko ostrzeżenia — nic nie przesuwa się samo.
- Strzałki między projektami pokazują zależności, jedna strzałka na parę projektów, czerwona, gdy powiązanie przestało być spełnione.
- Filtry według strumienia pracy, zespołu, właściciela/ki i tylko oflagowanych oraz wybór programów, zapamiętywany w przeglądarce i wspólny ze stroną Programy.
- Nowa strona Programy pokazuje plan jako drzewo: strumienie pracy, ich programy i ich projekty, każdy z okresem, który obejmuje, i liczbą flag swoich projektów. Rozwijanie i zwijanie z klawiatury lub przyciskami Rozwiń wszystko / Zwiń wszystko.
- Okno docelowe można ustawić wprost na osi czasu: przesunąć lub zmienić jego pasek, narysować nowy na pustym wierszu albo użyć „Edytuj okno docelowe…” i „Wyczyść okno docelowe” w menu wiersza — robi to administrator/ka, właściciel/ka powyżej projektu lub osoba z uprawnieniem edycji roadmapy.
- Zoom roczny: strony Roadmapa i Programy oferują Miesiąc, Kwartał (domyślnie) i Rok.`,
  },
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

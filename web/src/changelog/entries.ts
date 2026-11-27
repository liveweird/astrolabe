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
    version: "1.35.0",
    date: "2026-11-27",
    en: `**Fixes after 1.34: the Teams figures, phone width, hidden columns**

- **Teams:** the Overloaded and WIP figures and the gray weeks without capacity are shown whole (they were cut to "4 weeks overl…", worse in Polish), and a manager's name stays on one line where there is room.
- **On a phone** (or any narrow window) no page scrolls sideways any more: the Unscheduled table scrolls inside its own box, and every Gantt keeps room for its bars by leaving out the columns between the name and Operations, from the last, then narrowing the name. **Choose columns** then shows what is drawn, ticking a column brings it back, and none of this is remembered: on a wider screen the Gantt shows your own choice.
- **Choose columns** counts what is hidden, e.g. "2 hidden", whenever a column is left out.
- The Gantt's **Operations** header no longer reads "Operati" (it holds only the ⋯ button; screen readers still hear "Operations"), and the Roadmap's Flags column fits two flags.
- API and stored data: nothing changes.`,
    pl: `**Poprawki po 1.34: liczby na stronie Zespoły, wąski ekran, ukryte kolumny**

- **Zespoły:** liczby w kolumnach Przeciążenie i WIP oraz szare tygodnie bez przepustowości są widoczne w całości (były ucinane do „4 tygodnie pr…”), a nazwisko kierownika/kierowniczki mieści się w jednym wierszu, gdy jest miejsce.
- **Na telefonie** (i w każdym wąskim oknie) żadna strona nie przewija się już w bok: tabela Niezaplanowane przewija się we własnym polu, a każdy wykres Gantta zostawia miejsce na paski, pomijając kolumny między nazwą a Operacjami, od ostatniej, a potem zwężając nazwę. **Wybierz kolumny** pokazuje wtedy to, co jest narysowane, zaznaczenie kolumny przywraca ją i nic z tego nie jest zapamiętywane: na szerszym ekranie wykres pokazuje Twój własny wybór.
- **Wybierz kolumny** podaje, ile kolumn jest ukrytych, np. „2 ukryte”, gdy którejś brakuje.
- Nagłówek **Operacje** na wykresie Gantta nie jest już ucinany do „Operacj” (kolumna zawiera tylko przycisk ⋯; czytniki ekranu nadal odczytują „Operacje”), a kolumna Flagi na Roadmapie mieści dwie flagi.
- API i zapisane dane: bez zmian.`,
  },
  {
    version: "1.34.0",
    date: "2026-11-27",
    en: `**Collapsible Gantt columns, Scroll to today**

- Every Gantt (the project page, the team page and both Roadmap modes) has **Hide columns** beside the zoom and **Scroll to today**. It collapses the columns between the name and Operations, and the arrow beside it, **Choose columns**, opens a menu that shows or hides one column at a time: Team, Estimate, Flags and Slack on the project page; Project, Estimate, Flags and Slack on the team page; Flags on the Roadmap and on its overview. The name, the Roadmap's rank and project, and Operations are never offered.
- The choice is remembered for each of those pages in this browser, and nothing is hidden on a first visit (nothing is stored until you choose). Slack and Flags appear only while there is something to show; a column you hid stays hidden when it appears again. Bars, arrows, the today line and keyboard movement across the grid are unchanged.
- **Today** is now **Scroll to today**, with a target icon, in the same place and doing the same; while today lies outside the dates shown it is disabled and says so.
- On the team page, the row of a whole project on the critical chain now has **Open project** in its menu (its Project column can be hidden).
- API and stored data: nothing changes (the choice lives in this browser).`,
    pl: `**Zwijane kolumny wykresów Gantta, Przewiń do dziś**

- Każdy wykres Gantta (strona projektu, strona zespołu i oba tryby Roadmapy) ma obok powiększenia przyciski **Ukryj kolumny** i **Przewiń do dziś**. Pierwszy zwija kolumny między nazwą a Operacjami, a strzałka obok niego, **Wybierz kolumny**, otwiera menu, w którym pokazujesz lub ukrywasz pojedyncze kolumny: Zespół, Szacunek, Flagi i Luz na stronie projektu; Projekt, Szacunek, Flagi i Luz na stronie zespołu; Flagi na Roadmapie i w jej przeglądzie. Nazwa, numer i projekt na Roadmapie oraz Operacje nigdy nie są w menu.
- Wybór jest zapamiętywany osobno dla każdej z tych stron w tej przeglądarce, a przy pierwszej wizycie nic nie jest ukryte (nic nie jest zapisywane, dopóki czegoś nie wybierzesz). Luz i Flagi pojawiają się tylko wtedy, gdy jest co pokazać; ukryta kolumna pozostaje ukryta, gdy pojawi się ponownie. Paski, strzałki, linia dzisiejszego dnia i poruszanie się po siatce klawiaturą działają jak dotąd.
- **Dziś** nazywa się teraz **Przewiń do dziś**, ma ikonę celownika, stoi w tym samym miejscu i działa tak samo; gdy dziś leży poza pokazanym zakresem dat, przycisk jest wyłączony i mówi o tym.
- Na stronie zespołu wiersz całego projektu na ścieżce krytycznej ma teraz w menu **Otwórz projekt** (kolumnę Projekt można ukryć).
- API i zapisane dane: nic się nie zmienia (wybór jest zapamiętywany w tej przeglądarce).`,
  },
  {
    version: "1.33.0",
    date: "2026-11-27",
    en: `**Schedule proposals on the Gantts**

- The project page and the Roadmap's overview now preview a schedule proposal. Propose (a click, never automatic) runs the cross-team proposal and draws it on the timeline in dashed bars: on the project page the moved milestones, "(new)" rows for the unscheduled ones the proposal places, and the project's proposed span; on the overview the projects, programs and work streams whose dates would move, plus a table of the projects that would move. Nothing changes until you accept.
- The project page runs the teams of the project's milestones and says how its end would move ("If every team's moves are accepted, the project ends on … , N working days earlier/later"). The overview runs the teams of the projects it shows (more than 50 teams: narrow the program or work stream pick first). While a proposal is open the dates cannot be written: the schedule actions on the project page and the target windows on the overview are read-only.
- Everyone may preview a proposal. Accepting moves only the teams you manage (administrators: every team); the sections of other teams stay a read-only preview, and a viewer who may accept nothing sees only the preview. After one manager accepts, other open copies of the run ask for a new proposal. Save is offered only to who may accept every team of the run.
- The Schedule proposals page and its navigation item are gone; its old addresses (and a saved proposal's) open the Roadmap overview. Saved proposals are listed under the overview's timeline ("Saved proposals", hidden until opened) and open there with the same bars and section; a manager of one of a current saved proposal's teams may accept their teams' moves from it. The team page keeps its own proposal.
- **Proposals saved before this version can no longer be opened; propose and save them again.**
- API (\`/api/v1\`): \`POST /schedule-proposals\` and \`/check\` are open to every login (no \`403\`); \`POST /schedule-proposals/accept\` takes an optional \`acceptTeamIds\` (a subset of the run's teams, absent = all of them) and checks the caller against those only; the proposal lists \`projects[]\`, the projects whose span it would move (before, after, the end's shift in working days); a run and an accept share one limit of 30 a minute per user (\`429\`); a saved proposal's \`can.accept\` is true for ADMIN or a manager of at least one of its teams (while current).
- Stored data: a saved schedule proposal's format changes (see above). Nothing else changes.`,
    pl: `**Propozycje harmonogramu na wykresach Gantta**

- Strona projektu i Przegląd roadmapy pokazują teraz podgląd propozycji harmonogramu. „Zaproponuj harmonogram” (kliknięcie, nigdy automatycznie) uruchamia propozycję dla wielu zespołów i rysuje ją na osi czasu przerywanymi paskami: na stronie projektu przesunięte kamienie milowe, wiersze „(nowy)” dla niezaplanowanych kamieni, które propozycja umieszcza, oraz proponowany zakres projektu; w przeglądzie projekty, programy i strumienie pracy, których terminy by się przesunęły, oraz tabelę projektów, które by się przesunęły. Nic się nie zmienia, dopóki nie zaakceptujesz.
- Strona projektu uruchamia propozycję dla zespołów kamieni milowych projektu i mówi, jak przesunąłby się jego koniec („Jeśli ruchy wszystkich zespołów zostaną zaakceptowane, projekt zakończy się …, N dni roboczych wcześniej/później”). Przegląd uruchamia ją dla zespołów pokazanych projektów (powyżej 50 zespołów: najpierw zawęź wybór programu lub strumienia pracy). Gdy propozycja jest otwarta, nie można zapisywać dat: akcje harmonogramu na stronie projektu i okna docelowe w przeglądzie są tylko do odczytu.
- Podgląd propozycji może zobaczyć każdy/a. Akceptacja przesuwa tylko zespoły, którymi zarządzasz (administratorzy/rki: wszystkie zespoły); sekcje innych zespołów pozostają podglądem tylko do odczytu, a kto nie może zaakceptować niczego, widzi tylko podgląd. Gdy jedna osoba kierująca zaakceptuje swoją część, inne otwarte kopie przebiegu proszą o nową propozycję. „Zapisz” jest dostępne tylko komuś, kto może zaakceptować wszystkie zespoły przebiegu.
- Strona „Propozycje harmonogramu” i jej pozycja w menu zniknęły; jej dawne adresy (także zapisanej propozycji) otwierają Przegląd roadmapy. Zapisane propozycje są wymienione pod osią czasu przeglądu („Zapisane propozycje”, domyślnie zwinięte) i otwierają się tam z tymi samymi paskami i sekcją; kierownik/czka jednego z zespołów aktualnej zapisanej propozycji może z niej zaakceptować ruchy swoich zespołów. Strona zespołu zachowuje własną propozycję.
- **Propozycji zapisanych przed tą wersją nie da się już otworzyć; zaproponuj je i zapisz ponownie.**
- API (\`/api/v1\`): \`POST /schedule-proposals\` i \`/check\` są otwarte dla każdego loginu (bez \`403\`); \`POST /schedule-proposals/accept\` przyjmuje opcjonalne \`acceptTeamIds\` (podzbiór zespołów przebiegu, brak = wszystkie) i sprawdza uprawnienia tylko wobec nich; propozycja zawiera \`projects[]\`, czyli projekty, których zakres by się przesunął (przed, po, przesunięcie końca w dniach roboczych); przebieg i akceptacja mają wspólny limit 30 na minutę na użytkownika/czkę (\`429\`); \`can.accept\` zapisanej propozycji jest prawdziwe dla ADMIN-a lub kierownika/czki co najmniej jednego z jej zespołów (gdy jest aktualna).
- Zapisane dane: zmienia się format zapisanej propozycji harmonogramu (patrz wyżej). Poza tym nic się nie zmienia.`,
  },
  {
    version: "1.32.0",
    date: "2026-11-27",
    en: `**Team load is part of Teams**

- Teams shows each team's load in the same table: its manager, its milestones, those not scheduled yet, and the weeks overloaded, over the WIP limit or without capacity, with the team's description under its name. The Show and Include past weeks filters and the "Weeks with a warning" table are on the same page. Administrators keep the row actions (create, edit, delete).
- The Team load page and its navigation item are gone. Its old address opens Teams with the same filters, and Home's team figures open Teams filtered the same way.
- The name filter narrows the table (and the weeks) as you type and is no longer remembered. The table is one list of up to 200 teams, without pages; a longer list says it was cut. Only the name sorts, in either direction, remembered in this browser.
- API (\`/api/v1\`), an addition only: \`description\` on each team of \`GET /views/team-load\`. Nothing is removed.
- Stored data: nothing changes.`,
    pl: `**Obciążenie zespołów jest częścią „Zespołów”**

- „Zespoły” pokazują obciążenie każdego zespołu w tej samej tabeli: kierownika/czkę, kamienie milowe, te jeszcze niezaplanowane oraz tygodnie przeciążone, ponad limitem WIP albo bez przepustowości; opis zespołu widać pod jego nazwą. Filtry „Pokaż” i „Pokaż też minione tygodnie” oraz tabela „Tygodnie z ostrzeżeniem” są na tej samej stronie. Administratorzy/rki zachowują akcje w wierszach (tworzenie, edycję, usuwanie).
- Strona „Obciążenie zespołów” i jej pozycja w menu zniknęły. Jej dawny adres otwiera „Zespoły” z tymi samymi filtrami, a liczby zespołów na stronie głównej otwierają „Zespoły” przefiltrowane tak samo.
- Filtr nazwy zawęża tabelę (i tygodnie) w trakcie pisania i nie jest już zapamiętywany. Tabela to jedna lista do 200 zespołów, bez stron; dłuższa lista mówi, że została ucięta. Sortować można tylko po nazwie, w obu kierunkach; kierunek jest zapamiętywany w tej przeglądarce.
- API (\`/api/v1\`), tylko dodatek: \`description\` w każdym zespole z \`GET /views/team-load\`. Nic nie jest usuwane.
- Zapisane dane: nic się nie zmienia.`,
  },
  {
    version: "1.31.0",
    date: "2026-11-27",
    en: `**Every name is a link**

- Wherever a work stream, program, project, milestone, team or user is named, the name now opens what it stands for: on Plan, Roadmap, Projects, the team page, Team load, Teams, Home, Deviations, Schedule proposals (and the saved ones), Baselines and their comparison, the Jira links to plan items, the Flow connections and Users. Names you cannot follow stay plain text: the page's own subject, names inside dialogs, and items a baseline remembers that are no longer in the plan.
- A work stream's or program's name opens the Roadmap overview narrowed to it. A work stream is narrowed by the address (\`workStreamId\`), with a way back to every work stream; an unknown one is dropped with a notice.
- A milestone's name opens its project's page with the milestone's row marked and in view, in the timeline and in the Milestones table, or in the Unscheduled list when it has no dates yet. The mark is dropped from the address once it has arrived, and a milestone that is no longer in the project gets a short notice.
- A project's and a team's name open their pages. An owner or manager opens their person page. On Users and the other admin screens a login opens its edit page. "Saved by", "taken by", "linked by" and "acknowledged by" open the person behind the login when it has one.
- On the Roadmap and the team page a second name in a timeline row (a program beside a project, a milestone on a critical chain's dimmed row) is a link for the pointer only; the row's menu has an "Open …" item for it, so the keyboard keeps one stop per row. Every row of the Roadmap overview now has a menu, with "Open …" items for its names.
- The Plan tree's disclosure button is now the chevron alone; the name beside it is the link. A link's accessible name says what it opens, for example "Open project Alpha".
- Links keep the look of the app's other links: the text colour, underlined on hover, and underlined at rest inside a sentence.
- API (\`/api/v1\`), additions only, the ids of the names the views show: \`programId\` and \`workStreamId\` on team-view milestones, Home's programs (\`workStreamId\`) and projects (\`programId\`), and the baseline view's projects; \`ownerPersonId\` on Home's programs and projects and on the Programs view's work streams and programs; \`managerPersonId\` on Team load rows; \`projectId\` on a link end of a baseline and of a schedule proposal; \`projectId\`, \`programId\` and \`workStreamId\` on a Jira link's plan item; \`personId\` on the creators of baselines and of Jira links; \`byPersonId\` on acknowledgements of Jira and Flow deviations.
- Stored data: a saved schedule proposal's format changes, so proposals saved before this version can no longer be opened; save them again. Nothing else changes.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Każda nazwa jest linkiem**

- Wszędzie, gdzie występuje nazwa strumienia pracy, programu, projektu, kamienia milowego, zespołu lub użytkownika/użytkowniczki, nazwa otwiera teraz to, co oznacza: na stronach „Plan”, „Roadmapa”, „Projekty”, na stronie zespołu, w „Obciążeniu zespołów”, w „Zespołach”, na stronie głównej, w „Odchyleniach”, w „Propozycjach harmonogramu” (także zapisanych), w „Bazach odniesienia” i ich porównaniu, w powiązaniach z Jirą, w połączeniach z Flow i na stronie „Użytkownicy/czki”. Nazwy, za którymi nie ma dokąd iść, zostają zwykłym tekstem: temat samej strony, nazwy w oknach dialogowych oraz elementy zapamiętane w bazie odniesienia, których nie ma już w planie.
- Nazwa strumienia pracy lub programu otwiera Przegląd roadmapy zawężony do niego. Strumień pracy zawęża adres (\`workStreamId\`), z drogą powrotną do wszystkich strumieni; nieznany strumień jest pomijany z komunikatem.
- Nazwa kamienia milowego otwiera stronę jego projektu z zaznaczonym wierszem kamienia i widocznym w oknie, na osi czasu i w tabeli „Kamienie milowe”, a gdy nie ma jeszcze dat, na liście niezaplanowanych kamieni milowych. Po dotarciu zaznaczenie znika z adresu, a kamień, którego nie ma już w projekcie, dostaje krótki komunikat.
- Nazwa projektu i zespołu otwiera ich strony. Właściciel/ka lub kierownik/czka otwiera stronę osoby. Na stronie „Użytkownicy/czki” i na innych ekranach administracyjnych login otwiera swoją stronę edycji. „Zapisane przez”, „utworzone przez”, „powiązane przez” i „potwierdzone przez” otwierają osobę stojącą za loginem, jeśli go ma.
- Na Roadmapie i stronie zespołu druga nazwa w wierszu osi czasu (program obok projektu, kamień milowy w przyciemnionym wierszu ścieżki krytycznej) jest linkiem tylko dla wskaźnika myszy; menu wiersza ma dla niej pozycję „Otwórz …”, więc klawiatura nadal ma jeden przystanek na wiersz. Każdy wiersz Przeglądu roadmapy ma teraz menu z pozycjami „Otwórz …” dla jego nazw.
- Przycisk rozwijania w drzewie Planu to teraz sama strzałka; nazwa obok niej jest linkiem. Nazwa dostępna linku mówi, co otwiera, na przykład „Otwórz projekt Alfa”.
- Linki wyglądają jak pozostałe linki aplikacji: w kolorze tekstu, podkreślone po najechaniu, a w zdaniu podkreślone zawsze.
- API (\`/api/v1\`), tylko dodatki, identyfikatory nazw pokazywanych w widokach: \`programId\` i \`workStreamId\` w kamieniach milowych widoku zespołu, w programach strony głównej (\`workStreamId\`) i jej projektach (\`programId\`) oraz w projektach widoku bazy odniesienia; \`ownerPersonId\` w programach i projektach strony głównej oraz w strumieniach pracy i programach widoku Programów; \`managerPersonId\` w wierszach „Obciążenia zespołów”; \`projectId\` w końcu zależności bazy odniesienia i propozycji harmonogramu; \`projectId\`, \`programId\` i \`workStreamId\` w elemencie planu powiązanym z Jirą; \`personId\` w autorach baz odniesienia i powiązań z Jirą; \`byPersonId\` w potwierdzeniach odchyleń z Jiry i Flow.
- Zapisane dane: zmienia się format zapisanej propozycji harmonogramu, więc propozycji zapisanych przed tą wersją nie da się już otworzyć; zapisz je ponownie. Poza tym nic się nie zmienia.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.30.0",
    date: "2026-11-26",
    en: `**Follow-ups to 1.29**

- Sortable column headers are now the same size as the other headers, in every table.
- A focused timeline bar has a two-tone ring (a gap in the page's colour inside the accent ring), so the focus stays visible on every team colour, in light and dark.
- With the system's forced (high-contrast) colours on, filled timeline bars are drawn again, with a border; a team's bar keeps its colour.
- The Roadmap's Dependencies panel no longer sits inside the timeline: it stays available when the Roadmap's own data fails to load, and a link to it opens with the panel in view.
- The project picker on Projects also finds a project by the name of one of its milestones, shown as a dimmed "Milestone: …" line under the project. It says when only the first 100 milestones were checked or the search failed.
- Team load shows the plan-wide number of milestones not scheduled yet, the same figure as Home's.
- API (\`/api/v1\`): \`totals.unscheduledMilestones\` on \`GET /views/team-load\`. **Removed** from \`GET /milestones\`: the filters \`workStreamId\`, \`programId\`, \`scheduled\` and \`teamId\`, the sort keys \`rankPosition\`, \`projectName\`, \`teamName\` and \`startDate\`, and the row member \`rankPosition\` (no screen has used them since 1.29). A removed filter is ignored, so it no longer narrows the list; a removed sort key answers \`400\`.
- No stored data changes.`,
    pl: `**Uzupełnienia do 1.29**

- Nagłówki kolumn z sortowaniem mają teraz ten sam rozmiar co pozostałe nagłówki, w każdej tabeli.
- Pasek osi czasu z fokusem ma dwukolorową obwódkę (odstęp w kolorze strony wewnątrz obwódki w kolorze akcentu), więc fokus jest widoczny na każdym kolorze zespołu, w trybie jasnym i ciemnym.
- Przy włączonych wymuszonych kolorach systemu (wysoki kontrast) wypełnione paski osi czasu znów są rysowane, z obramowaniem; pasek zespołu zachowuje jego kolor.
- Panel „Zależności” na Roadmapie nie jest już częścią osi czasu: pozostaje dostępny, gdy nie udaje się wczytać danych samej Roadmapy, a link do niego otwiera stronę z panelem w widoku.
- Wybór projektu na stronie „Projekty” znajduje projekt także po nazwie jednego z jego kamieni milowych, pokazanej jako przyciemniony wiersz „Kamień milowy: …” pod projektem. Informuje, gdy sprawdzamy tylko pierwsze 100 kamieni milowych albo gdy wyszukiwanie się nie powiodło.
- „Obciążenie zespołów” pokazuje liczbę kamieni milowych całego planu, które nie mają jeszcze terminu, tę samą co strona główna.
- API (\`/api/v1\`): \`totals.unscheduledMilestones\` w \`GET /views/team-load\`. **Usunięte** z \`GET /milestones\`: filtry \`workStreamId\`, \`programId\`, \`scheduled\` i \`teamId\`, klucze sortowania \`rankPosition\`, \`projectName\`, \`teamName\` i \`startDate\` oraz pole \`rankPosition\` w wierszu (żaden ekran nie używa ich od 1.29). Usunięty filtr jest ignorowany, więc nie zawęża już listy; usunięty klucz sortowania daje \`400\`.
- Bez zmian w zapisanych danych.`,
  },
  {
    version: "1.29.0",
    date: "2026-11-26",
    en: `**One Roadmap, a Projects view and team colours**

- Roadmap and Programs are now one page, Roadmap, with two modes: Prioritization (the projects by rank, the old Roadmap) and Roadmap overview (work streams, programs and projects as a tree, the old Programs). The page opens in the mode you used last in this browser, and the mode is in the address, so a link names it. The old Programs address opens the overview.
- A new Projects item in the navigation opens the project page with a picker on top. It finds a project by its own name or by its program's, its work stream's or its owner's, ignoring accents, and it reopens the last project you viewed in this browser.
- Every team has a colour from a fixed palette of twelve, chosen in the team editor (a new team starts with the least-used colour; teams may share one). A milestone's bar takes its team's colour on the project page and the team page, and a colour swatch stands before the team's name on Teams, Team load, Home and the team page. The team is always named in the same row, so colour is never the only cue.
- The project page has a Milestones table: the project's milestones with their team, estimate and dates, filtered by schedule, team and name and sorted by name, team or start. It can be hidden; the choice is remembered in this browser.
- Dependencies sit beside the timelines. On the project page the Dependencies section can be hidden and shown. The Roadmap, in both modes, has a Dependencies panel under its timeline, hidden by default: every dependency of the plan with the same filters, and adding, editing and deleting under the same permissions. Both choices are remembered in this browser.
- The Milestones page and the Dependencies page are gone, with their navigation items. Their content lives in the project page's Milestones table, the team page, Team load and the Roadmap's dependency panel; Home's figures and the old links open these, so no bookmark breaks. The plan-wide milestone list and its name search went with the Milestones page.
- API (\`/api/v1\`), additions only: a \`colour\` member (one of twelve keys) on teams, in the create and update requests (optional; an update without it keeps the colour), the team responses and the team view.
- Stored data: each team's colour (migration V35). Existing teams got distinct colours, active ones first.`,
    pl: `**Jedna roadmapa, widok Projekty i kolory zespołów**

- Roadmapa i Programy to teraz jedna strona, Roadmapa, z dwoma trybami: Priorytetyzacja (projekty według rankingu, dawna Roadmapa) i Przegląd roadmapy (strumienie pracy, programy i projekty jako drzewo, dawne Programy). Strona otwiera się w trybie ostatnio używanym w tej przeglądarce, a tryb jest w adresie, więc link go wskazuje. Stary adres Programów otwiera przegląd.
- Nowa pozycja „Projekty” w nawigacji otwiera stronę projektu z wyborem projektu na górze. Znajduje projekt po jego nazwie albo po nazwie jego programu, strumienia pracy lub właściciela/ki, pomijając znaki diakrytyczne, i ponownie otwiera ostatnio oglądany projekt w tej przeglądarce.
- Każdy zespół ma kolor z ustalonej palety dwunastu, wybierany w edytorze zespołu (nowy zespół dostaje domyślnie najrzadziej używany kolor; zespoły mogą mieć ten sam). Pasek kamienia milowego ma kolor swojego zespołu na stronie projektu i na stronie zespołu, a przed nazwą zespołu na stronach „Zespoły”, „Obciążenie zespołów”, „Strona główna” i na stronie zespołu stoi próbka koloru. Zespół jest zawsze nazwany w tym samym wierszu, więc kolor nigdy nie jest jedyną wskazówką.
- Strona projektu ma tabelę „Kamienie milowe”: kamienie milowe projektu z zespołem, estymatą i datami, filtrowane według harmonogramu, zespołu i nazwy oraz sortowane według nazwy, zespołu lub początku. Można ją ukryć; wybór jest zapamiętywany w tej przeglądarce.
- Zależności są obok osi czasu. Na stronie projektu sekcję „Zależności” można ukryć i pokazać. Roadmapa w obu trybach ma pod osią czasu panel „Zależności”, domyślnie ukryty: wszystkie zależności planu z tymi samymi filtrami oraz dodawaniem, edycją i usuwaniem na tych samych uprawnieniach. Oba wybory są zapamiętywane w tej przeglądarce.
- Strony „Kamienie milowe” i „Zależności” zniknęły razem z pozycjami w nawigacji. Ich zawartość jest w tabeli kamieni milowych na stronie projektu, na stronie zespołu, w „Obciążeniu zespołów” i w panelu zależności Roadmapy; liczby na stronie głównej i stare linki otwierają te miejsca, więc żadna zakładka nie przestaje działać. Lista kamieni milowych całego planu i jej wyszukiwanie po nazwie zniknęły razem ze stroną „Kamienie milowe”.
- API (\`/api/v1\`), tylko dodatki: pole \`colour\` (jeden z dwunastu kluczy) w zespołach: w żądaniach utworzenia i aktualizacji (opcjonalne; aktualizacja bez niego zachowuje kolor), w odpowiedziach o zespołach i w widoku zespołu.
- Zapisane dane: kolor każdego zespołu (migracja V35). Istniejące zespoły dostały różne kolory, aktywne w pierwszej kolejności.`,
  },
  {
    version: "1.28.0",
    date: "2026-11-26",
    en: `**The Plan page as one tree**

- The Plan page is one table of work streams, their programs and their projects. Fold and unfold any row, or all of them at once; the page remembers what you folded.
- Search by name and filter by owner or hide closed work streams; the matches stay in their place in the tree, with the rows above them shown as context. The filters are in the address, so a link keeps them.
- "Show only this" in a row's menu narrows the page to one work stream or program, with a breadcrumb back to the whole plan.
- Pin any row to keep it in a Pinned section at the top of the page, which stays in view while you scroll. Pins are remembered in this browser.
- An administrator re-arranges the work streams, and a work stream's owner its programs: drag a row by its grip, or use Move up and Move down in its menu. The Programs page follows the same order. Projects keep the roadmap's rank. Closed work streams stay last.
- API (\`/api/v1\`), additions only: \`PUT /work-stream-order\` and \`PUT /work-streams/{id}/program-order\`; the plan view's \`workStreamOrderRevision\`, each work stream's \`programOrderRevision\`, and the \`can.orderWorkStreams\` and \`can.orderPrograms\` flags.
- Stored data: the order of the work streams and of each work stream's programs (migration V34). Until someone re-arranges them, they keep today's order by name.`,
    pl: `**Strona planu jako jedno drzewo**

- Strona „Plan” to jedna tabela strumieni pracy, ich programów i projektów. Możesz zwinąć i rozwinąć dowolny wiersz albo wszystkie naraz; strona pamięta, co zwinięte.
- Szukaj po nazwie, filtruj według właściciela/ki lub ukryj zamknięte strumienie pracy; trafienia zostają na swoim miejscu w drzewie, a wiersze nad nimi widać jako kontekst. Filtry są w adresie, więc link je zachowuje.
- „Pokaż tylko to” w menu wiersza zawęża stronę do jednego strumienia pracy lub programu, z nawigacją okruszkową z powrotem do całego planu.
- Przypnij dowolny wiersz, by trzymać go w sekcji „Przypięte” na górze strony, widocznej podczas przewijania. Przypięcia są zapamiętywane w tej przeglądarce.
- Administrator/ka zmienia kolejność strumieni pracy, a właściciel/ka strumienia — kolejność jego programów: przeciągnij wiersz za uchwyt albo użyj „Przesuń w górę” i „Przesuń w dół” w jego menu. Strona „Programy” pokazuje tę samą kolejność. Projekty zachowują ranking z mapy drogowej. Zamknięte strumienie pracy są zawsze na końcu.
- API (\`/api/v1\`), tylko dodatki: \`PUT /work-stream-order\` i \`PUT /work-streams/{id}/program-order\`; \`workStreamOrderRevision\` w widoku planu, \`programOrderRevision\` każdego strumienia pracy oraz flagi \`can.orderWorkStreams\` i \`can.orderPrograms\`.
- Zapisane dane: kolejność strumieni pracy i programów każdego strumienia (migracja V34). Dopóki nikt jej nie zmieni, zostaje dzisiejsza kolejność według nazwy.`,
  },
  {
    version: "1.27.1",
    date: "2026-11-25",
    en: `**Updated libraries and images**

- The containers use PostgreSQL 18.7 and refreshed Java 21 images. The server runs on Netty 4.2.21, Flyway 13.13.0 and Logback 1.6.8, and the web app on Mantine 9.8.2.
- No feature, API or stored data changes.`,
    pl: `**Zaktualizowane biblioteki i obrazy**

- Kontenery używają PostgreSQL 18.7 i odświeżonych obrazów Javy 21. Serwer działa na Netty 4.2.21, Flyway 13.13.0 i Logback 1.6.8, a aplikacja w przeglądarce na Mantine 9.8.2.
- Bez zmian w funkcjach, API i zapisanych danych.`,
  },
  {
    version: "1.27.0",
    date: "2026-11-25",
    en: `**Finding and linking work**

- The Dependencies page has "Add dependency". It shows to whoever can manage at least one project; the successor is one of those projects or its milestones, the predecessor is anything in the plan.
- The Milestones page filters by program and by work stream, and sorts by the project's rank. The milestones of unranked projects come last in both directions.
- With "Critical path" on, the team page draws the whole critical chain through the team's work: the milestones of other teams, and whole projects, are dimmed read-only rows with their arrows. The new "Critical chain" section lists the chain's dependencies in a table. The chain shows at most 100 of these rows and says when it is longer.
- API (\`/api/v1\`), additions only: \`programId\`, \`workStreamId\`, the sort keys \`rankPosition\` and \`startDate\`, and the \`rankPosition\` member on \`GET /milestones\`; \`criticalChain=true\` on \`GET /views/team/{id}\`; \`can.createDependency\` on the plan view's projects.
- No stored data changes.`,
    pl: `**Wyszukiwanie i łączenie pracy**

- Na stronie „Zależności” jest przycisk „Dodaj zależność”. Widzi go każda osoba, która może zarządzać przynajmniej jednym projektem; następnikiem jest jeden z tych projektów lub jego kamień milowy, a poprzednikiem dowolny element planu.
- Stronę „Kamienie milowe” możesz filtrować według programu i strumienia pracy oraz sortować według rankingu projektu. Kamienie milowe projektów spoza rankingu są ostatnie w obu kierunkach.
- Po włączeniu opcji „Ścieżka krytyczna” strona zespołu rysuje cały łańcuch krytyczny przechodzący przez pracę zespołu: kamienie milowe innych zespołów i całe projekty to przyciemnione wiersze tylko do odczytu, razem ze strzałkami. Nowa sekcja „Łańcuch krytyczny” wymienia zależności łańcucha w tabeli. Łańcuch pokazuje najwyżej 100 takich wierszy i mówi, kiedy jest dłuższy.
- API (\`/api/v1\`), tylko dodatki: \`programId\`, \`workStreamId\`, klucze sortowania \`rankPosition\` i \`startDate\` oraz pole \`rankPosition\` w \`GET /milestones\`; \`criticalChain=true\` w \`GET /views/team/{id}\`; \`can.createDependency\` w projektach widoku planu.
- Bez zmian w zapisanych danych.`,
  },
  {
    version: "1.26.1",
    date: "2026-11-25",
    en: `**Updated libraries and images**

- The web app and the server run on current patch and minor versions of their libraries, among them Mantine 9.8, Jackson 2.23, Flyway 13.12.2 and OpenTelemetry 1.68.
- The containers use a refreshed PostgreSQL 18.6 image, and the web app is built with Node 24.22.3.
- No feature, API or stored data changes.`,
    pl: `**Zaktualizowane biblioteki i obrazy**

- Aplikacja w przeglądarce i serwer działają na bieżących wersjach bibliotek, między innymi Mantine 9.8, Jackson 2.23, Flyway 13.12.2 i OpenTelemetry 1.68.
- Kontenery używają odświeżonego obrazu PostgreSQL 18.6, a aplikacja w przeglądarce powstaje na Node 24.22.3.
- Bez zmian w funkcjach, API i zapisanych danych.`,
  },
  {
    version: "1.26.0",
    date: "2026-11-24",
    en: `**Saved proposals and baselines that remember links and capacity**

- A cross-team schedule proposal can be saved and opened later by anyone signed in: the saved list on Schedule proposals keeps the newest 20. A saved proposal says whether the plan has changed since; a team's manager can still accept it while it is current and from today.
- A new baseline also freezes the dependencies and every team's capacity periods. The comparison page lists the links added, removed or changed and the capacity ranges that differ; the team page shows the capacity a baseline froze, and the project page marks a dependency added since the baseline. Baselines taken before this version say "not captured" instead.
- A Flow team waiting for a complete sprint snapshot is listed as "Waiting for a complete Flow refresh" instead of "In line with Flow", with a neutral marker on the team page, Home, Roadmap and Programs.
- Linking a Jira item to a program searches the programs on the server, so every program can be found.
- A cross-team run re-places only the teams its changes affect, so long runs finish sooner.
- API (\`/api/v1\`), additions only: paged \`GET /work-streams\` and \`GET /programs\`; \`/saved-schedule-proposals\`; the baselines' link and capacity counts and the comparison's \`links\` and \`capacity\`; the Flow \`pending\` totals and flags.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Zapisane propozycje i bazy odniesienia, które pamiętają zależności i przepustowość**

- Propozycję harmonogramu dla wielu zespołów możesz zapisać, a każda zalogowana osoba może ją później otworzyć: lista „Zapisane propozycje” na stronie „Propozycje harmonogramu” przechowuje 20 najnowszych. Zapisana propozycja mówi, czy plan zmienił się od jej zapisania; menedżer/menedżerka zespołu nadal może ją przyjąć, dopóki jest aktualna i pochodzi z dzisiaj.
- Nowa baza odniesienia zamraża także zależności i okresy przepustowości każdego zespołu. Strona porównania pokazuje dodane, usunięte i zmienione zależności oraz różniące się zakresy przepustowości; strona zespołu pokazuje przepustowość zamrożoną w bazie, a strona projektu oznacza zależność dodaną po utworzeniu bazy. Bazy utworzone przed tą wersją pokazują „nie zamrożono”.
- Zespół z Flow, który czeka na kompletny zestaw sprintów, figuruje jako „Oczekuje na pełne odświeżenie Flow” zamiast „Zgodnie z Flow”, z neutralnym znacznikiem na stronie zespołu, stronie głównej, Roadmapie i Programach.
- Powiązanie elementu z Jiry z programem wyszukuje programy na serwerze, więc znajdziesz każdy program.
- Przebieg dla wielu zespołów ponownie rozmieszcza tylko zespoły, których dotyczą zmiany, więc długie przebiegi kończą się szybciej.
- API (\`/api/v1\`), tylko dodatki: stronicowane \`GET /work-streams\` i \`GET /programs\`; \`/saved-schedule-proposals\`; liczby zależności i okresów przepustowości w bazach oraz \`links\` i \`capacity\` w porównaniu; sumy i flagi \`pending\` dla Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.25.1",
    date: "2026-11-22",
    en: `**A new Astrolabe logo**

- A mariner’s astrolabe with a wind rose appears in both app themes. The browser tab uses a simpler version that stays legible at small sizes.`,
    pl: `**Nowe logo Astrolabe**

- Astrolabium żeglarskie z różą wiatrów pojawia się w obu motywach aplikacji. Karta przeglądarki używa uproszczonej ikony, która pozostaje czytelna w małym rozmiarze.`,
  },
  {
    version: "1.25.0",
    date: "2026-11-22",
    en: `**Clearer planning and safer updates**

- Navigation groups planning, team capacity, integrations, and administration. Home makes plan figures easier to scan and aligns the actions for Plan, Roadmap, and Deviations.
- Flow capacity import waits for a complete sprint snapshot before offering or applying changes. After upgrading, refresh existing Flow connections before importing capacity. Linking, unlinking, and capacity changes refresh the affected views.
- Saving a project's fields and target window together commits both in one operation. Registry lists return to an available page after the last row on a page is removed.
- Long timelines draw only the date headers near the visible range. The server and client tooling use the published OpenAPI dialect.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Czytelniejsze planowanie i bezpieczniejsze aktualizacje**

- Nawigacja grupuje planowanie, obciążenie zespołów, integracje i administrację. Strona główna ułatwia przegląd liczb i porządkuje przejścia do Planu, Roadmapy i Odchyleń.
- Import pojemności z Flow wymaga kompletnego zestawu sprintów. Po aktualizacji odśwież istniejące połączenia z Flow przed importem. Łączenie i odłączanie zespołów oraz zmiana pojemności odświeżają powiązane widoki.
- Dane projektu i okno docelowe zapisujesz razem w jednej operacji. Po usunięciu jedynego wiersza na stronie lista wraca na dostępną stronę.
- Długie osie czasu wyświetlają nagłówki dat w pobliżu widocznego zakresu. Serwer i narzędzia klienta korzystają z opublikowanej wersji OpenAPI.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.24.0",
    date: "2026-11-15",
    en: `**Astrolabe 1.24.0: a technical release.**

- No new feature: the pages work as before. This release is the quality checkup of 1.23 — the project's documentation rewritten around its rules, the API description stating its contract, shared code in place of copies, and a faster build.
- API (\`/api/v1\`), **a removal**: the items of \`GET /views/deviations\` no longer carry the deprecated item-level \`acknowledgement\` (no screen read it since 1.12). Each line's own acknowledgement, the Status filter, the counts and the acknowledge routes are unchanged.
- API: the \`409\` for removing the last ADMIN and the two \`409\`s for a person's taken email or login now name their problem type (\`urn:astrolabe:problem:last-admin\`, \`…:person-email-taken\`, \`…:person-login-taken\`); the failure codes of sync runs and connection tests are one declared list; Jira's Peek rounds an estimate to two decimals, the way a sync stores it. If a tab was open during the upgrade, reload it.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.24.0: wydanie techniczne.**

- Bez nowych funkcji: strony działają jak dotąd. To wydanie jest przeglądem jakości wersji 1.23 — dokumentacja projektu przepisana wokół jej zasad, opis API określający kontrakt, wspólny kod zamiast kopii i szybsza kompilacja.
- API (\`/api/v1\`), **usunięcie**: elementy \`GET /views/deviations\` nie mają już przestarzałego pola \`acknowledgement\` na poziomie elementu (żaden ekran go nie czytał od wersji 1.12). Potwierdzenie każdej linii, filtr statusu, liczniki i ścieżki potwierdzania się nie zmieniły.
- API: odpowiedź \`409\` przy usuwaniu ostatniego/ej administratora/ki oraz dwie odpowiedzi \`409\` dla zajętego adresu e-mail lub loginu osoby podają teraz typ problemu (\`urn:astrolabe:problem:last-admin\`, \`…:person-email-taken\`, \`…:person-login-taken\`); kody błędów przebiegów synchronizacji i testów połączenia tworzą jedną zadeklarowaną listę; podgląd (Peek) Jiry zaokrągla szacunek do dwóch miejsc po przecinku, tak jak zapisuje go synchronizacja. Jeśli karta była otwarta podczas aktualizacji, odśwież ją.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.23.0",
    date: "2026-11-15",
    en: `**Astrolabe 1.23.0: a database time limit, the Flow capacity flag on the Roadmap and Programs, everything you manage on Home.**

- A database that does not answer no longer leaves a page waiting. Every statement the server sends has a limit of 15 seconds (\`POSTGRES_STATEMENT_TIMEOUT_SECONDS\`; 0 switches it off). When it is reached the page says "The request timed out. Try again." at once, instead of trying again for up to a minute and a half. The step that was cut is undone; if a new item you try again is then refused because its name is taken, the first try had already saved it.
- Roadmap and Programs: a project with a milestone scheduled in a sprint where its team's capacity in the plan differs from Flow now carries a flag that names the team (a warning when the plan holds more than Flow, an info otherwise). It counts in the warnings and infos of both pages, in the roll-ups of programs and work streams, and on Home. A difference the team's manager has acknowledged raises none. The Roadmap's Flags list links to the team.
- Home: "Yours" now lists every program and project under a work stream or program you own, not only what you own yourself, and each row names its owner. "Only what I own myself" narrows the lists back to your own; this browser remembers the choice. "Your teams" has not changed.
- Keyboard: after deleting a row you had just edited, the focus goes to the heading on every page; it could be lost.
- API (\`/api/v1\`): a \`500\` may carry \`type: urn:astrolabe:problem:database-timeout\`; the flags of \`GET /views/roadmap\` and \`GET /views/programs\` may hold the new kind \`FLOW_CAPACITY_MILESTONES\` (\`teamId\`, \`count\`); the program and project rows of \`GET /views/home\` add \`ownerName\` and \`direct\`. If a tab was open during the upgrade, reload it.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.23.0: limit czasu bazy danych, flaga przepustowości z Flow na Roadmapie i w Programach, wszystko, czym zarządzasz, na stronie głównej.**

- Baza danych, która nie odpowiada, nie zostawia już strony w oczekiwaniu. Każde zapytanie wysyłane przez serwer ma limit 15 sekund (\`POSTGRES_STATEMENT_TIMEOUT_SECONDS\`; 0 go wyłącza). Po jego przekroczeniu strona od razu pokazuje „Przekroczono limit czasu żądania. Spróbuj ponownie.”, zamiast ponawiać próby nawet przez półtorej minuty. Przerwany krok zostaje wycofany; jeśli przy ponownej próbie nowy element zostanie odrzucony, bo jego nazwa jest już zajęta, pierwsza próba zdążyła go zapisać.
- Roadmapa i Programy: projekt z kamieniem milowym zaplanowanym na sprint, w którym przepustowość jego zespołu w planie różni się od Flow, ma teraz flagę z nazwą zespołu (ostrzeżenie, gdy plan ma więcej niż Flow, w przeciwnym razie informacja). Flaga liczy się w ostrzeżeniach i informacjach obu stron, w podsumowaniach programów i strumieni pracy oraz na stronie głównej. Różnica, którą kierownik/czka zespołu potwierdził/a, nie daje flagi. Lista flag na Roadmapie prowadzi do zespołu.
- Strona główna: sekcja „Twoje” pokazuje teraz wszystkie programy i projekty pod strumieniem pracy lub programem, którego jesteś właścicielem/ką, a nie tylko to, co należy bezpośrednio do Ciebie, a każdy wiersz podaje właściciela/kę. „Tylko to, czego jestem osobiście właścicielem/ką” zawęża listy z powrotem do Twoich; ta przeglądarka zapamiętuje wybór. „Twoje zespoły” się nie zmieniły.
- Klawiatura: po usunięciu wiersza, który przed chwilą edytowałeś/aś, fokus przechodzi na nagłówek na każdej stronie; wcześniej mógł zniknąć.
- API (\`/api/v1\`): odpowiedź \`500\` może mieć \`type: urn:astrolabe:problem:database-timeout\`; flagi w \`GET /views/roadmap\` i \`GET /views/programs\` mogą zawierać nowy rodzaj \`FLOW_CAPACITY_MILESTONES\` (\`teamId\`, \`count\`); wiersze programów i projektów w \`GET /views/home\` mają dodatkowo \`ownerName\` i \`direct\`. Jeśli karta była otwarta podczas aktualizacji, odśwież ją.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.22.0",
    date: "2026-11-15",
    en: `**Astrolabe 1.22.0: lighter re-reads of the plan pages, dependencies changed from their list, the team load from this week on.**

- The plan pages re-read less. When nothing has changed since your browser last read a page (Plan, Home, Roadmap, Programs, a project, a team, Team load, Dependencies, a baseline comparison), the server answers with a short "not modified" instead of the whole document. What you see is always what the server holds: any change, in the plan or outside it (a renamed team or person, a permission, a capacity period, something read from Jira or Flow), is a full answer. The Deviations page is read in full, as before.
- Dependencies: the owners of the successor's project, and administrators, can now change a dependency's type and lag or delete it from its row on the Dependencies page. A new dependency is still added on the project's page.
- Team load: "Weeks with a warning" now starts at the current week; "Include past weeks" in the filters brings the earlier ones back. When more than 2,000 weeks carry a warning, the weeks from this week on are kept first, whatever the team's name. The counts in the teams table still cover every week.
- Jira import: the team select of an imported milestone lists every team, not only the first 100.
- Roadmap, keyboard: after "Rank" on the last row under "Unranked projects only" the focus moves to the Filters button; when a rank is undone (someone else changed the ranking, or you may not change it) the focus returns to the row.
- API (\`/api/v1\`): ten view reads (\`GET /views/plan\`, \`home\`, \`team-load\`, \`dependencies\`, \`roadmap\`, \`programs\`, \`project/{id}\`, \`team/{id}\`, \`baseline/{id}\`, \`jira-links\`) answer with an \`ETag\` and honour \`If-None-Match\` with \`304\`; the answers stay \`Cache-Control: no-store\`. The rows of \`GET /views/dependencies\` carry \`can\` (\`edit\`, \`delete\`); \`GET /views/team-load\` adds \`currentWeekStart\`. If a tab was open during the upgrade, reload it.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.22.0: lżejsze ponowne odczyty stron planu, zależności zmieniane z ich listy, obciążenie zespołów od bieżącego tygodnia.**

- Strony planu czytają mniej. Gdy od ostatniego odczytu strony przez Twoją przeglądarkę nic się nie zmieniło (Plan, strona główna, Roadmapa, Programy, projekt, zespół, Obciążenie zespołów, Zależności, porównanie z bazą odniesienia), serwer odpowiada krótkim „bez zmian” zamiast całego dokumentu. Zawsze widzisz to, co ma serwer: każda zmiana, w planie albo poza nim (zmieniona nazwa zespołu albo osoby, uprawnienie, okres przepustowości, coś odczytanego z Jiry albo z Flow), daje pełną odpowiedź. Stronę Odchylenia czytamy w całości, jak dotąd.
- Zależności: właściciele/ki projektu następnika i administratorzy/rki mogą teraz zmienić typ i opóźnienie zależności albo ją usunąć w jej wierszu na stronie Zależności. Nową zależność nadal dodajesz na stronie projektu.
- Obciążenie zespołów: tabela „Tygodnie z ostrzeżeniem” zaczyna się teraz od bieżącego tygodnia; „Pokaż też minione tygodnie” w filtrach przywraca wcześniejsze. Gdy ostrzeżenie ma ponad 2000 tygodni, lista zachowuje najpierw tygodnie od bieżącego, niezależnie od nazwy zespołu. Liczby w tabeli zespołów nadal obejmują wszystkie tygodnie.
- Import z Jiry: lista zespołów przy importowanym kamieniu milowym zawiera wszystkie zespoły, nie tylko pierwszych 100.
- Roadmapa, klawiatura: po „Dodaj do rankingu” w ostatnim wierszu przy filtrze „Tylko projekty bez rankingu” fokus przechodzi na przycisk „Filtry”; gdy dodanie do rankingu zostaje cofnięte (ktoś inny zmienił ranking albo nie możesz go zmieniać), fokus wraca do wiersza.
- API (\`/api/v1\`): dziesięć odczytów widoków (\`GET /views/plan\`, \`home\`, \`team-load\`, \`dependencies\`, \`roadmap\`, \`programs\`, \`project/{id}\`, \`team/{id}\`, \`baseline/{id}\`, \`jira-links\`) odpowiada nagłówkiem \`ETag\` i na \`If-None-Match\` odpowiada \`304\`; odpowiedzi pozostają \`Cache-Control: no-store\`. Wiersze \`GET /views/dependencies\` mają \`can\` (\`edit\`, \`delete\`); \`GET /views/team-load\` dodaje \`currentWeekStart\`. Jeśli karta była otwarta podczas aktualizacji, odśwież ją.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.21.0",
    date: "2026-11-15",
    en: `**Astrolabe 1.21.0: more filters, Team load week by week, a lighter Dependencies read.**

- Programs page: the program pick is now in the address, so a Programs page with a pick is a link you can copy. As on the Roadmap, a link is shown as written and does not change the pick your browser remembers; opening Programs from the menu brings yours back.
- Roadmap: a "Flag severity" filter (Warning or Info) and an "Unranked projects only" switch beside "Flagged projects only", in the address and remembered. Home's unranked figure opens the Roadmap with the unranked projects only, and its warnings and infos each open their own severity.
- Milestones and Dependencies: a Project filter, and the Team filter lists every team, not only the first 100.
- Team load: a new table, "Weeks with a warning", lists every overloaded week and every week over the WIP limit, team by team, with the same figures as the team's page. It follows the "Show" filter. At most 2,000 weeks are listed; a cut list says so.
- API (\`/api/v1\`): \`GET /views/team-load\` adds \`warningWeeks\` to each team and \`warningWeeksTruncated\`. \`GET /views/dependencies\` now lists each project, milestone and team once (\`projects\`, \`milestones\`, \`teams\`) and a row names its ends by kind and id, so a client written for 1.20.0 reads the names from those lists. If a tab was open during the upgrade, reload it.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.21.0: więcej filtrów, obciążenie zespołów tydzień po tygodniu, lżejszy odczyt zależności.**

- Programy: wybór programów jest teraz w adresie, więc stronę Programy z wyborem możesz skopiować jako link. Tak jak na roadmapie link pokazuje dokładnie to, co w nim zapisano, i nie zmienia wyboru zapamiętanego w Twojej przeglądarce; Programy otwarte z menu przywracają Twój wybór.
- Roadmapa: filtr „Waga flag” (ostrzeżenie albo informacja) i przełącznik „Tylko projekty bez rankingu” obok „Tylko projekty z flagami”, w adresie i zapamiętywane. Liczba projektów bez rankingu na stronie głównej otwiera roadmapę z samymi takimi projektami, a ostrzeżenia i informacje otwierają każde swoją wagę.
- Kamienie milowe i Zależności: filtr Projekt, a filtr Zespół wymienia każdy zespół, nie tylko pierwszych 100.
- Obciążenie zespołów: nowa tabela „Tygodnie z ostrzeżeniem” wymienia każdy przeciążony tydzień i każdy tydzień ponad limitem WIP, zespół po zespole, z tymi samymi liczbami co strona zespołu. Tabela podąża za filtrem „Pokaż”. Lista zawiera najwyżej 2000 tygodni; ucięta lista to mówi.
- API (\`/api/v1\`): \`GET /views/team-load\` dodaje \`warningWeeks\` przy każdym zespole oraz \`warningWeeksTruncated\`. \`GET /views/dependencies\` wymienia teraz każdy projekt, kamień milowy i zespół raz (\`projects\`, \`milestones\`, \`teams\`), a wiersz wskazuje swoje końce rodzajem i identyfikatorem, więc klient napisany dla 1.20.0 odczytuje nazwy z tych list. Jeśli karta była otwarta podczas aktualizacji, odśwież ją.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.20.0",
    date: "2026-11-15",
    en: `**Astrolabe 1.20.0: every dependency of the plan on one page.**

- Dependencies (new, under Planning): every dependency of the plan, the violated ones first (the largest shortfall first), then the ones that hold, then the ones with an end not scheduled yet. Each row shows the type, the lag, both ends with their milestone, project and team, and the check. Filter by status, team or project; the filters are in the address. A dependency is still changed on its successor's project page.
- Home: the red "violated dependencies" figure opens the list of violated dependencies; under "Yours", a project's or a team's conflicts open it narrowed to that project or team.
- Roadmap and Programs pages: a project's row menu has "Dependencies". Team page: the number of dependencies and the red conflicts badge open the list for the team.
- Home shows your own changes to the Jira and Flow connections, mappings, synchronisations and team links at once.
- The sign-in and password-reset pages also offer Reload when a new version has been deployed.
- API (\`/api/v1\`): \`GET /views/dependencies\` (any signed-in user) answers the Dependencies page in one read.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.20.0: wszystkie zależności planu na jednej stronie.**

- Zależności (nowa strona w sekcji Planowanie): każda zależność planu, najpierw niedotrzymane (od największego niedoboru), potem dotrzymane, potem te, których koniec nie jest jeszcze zaplanowany. Każdy wiersz pokazuje typ, opóźnienie, oba końce z kamieniem milowym, projektem i zespołem oraz wynik sprawdzenia. Filtr po stanie, zespole i projekcie; filtry są w adresie. Zależność nadal zmieniasz na stronie projektu jej następnika.
- Strona główna: czerwona liczba niedotrzymanych zależności otwiera ich listę; w sekcji „Twoje” konflikty projektu albo zespołu otwierają listę zawężoną do tego projektu albo zespołu.
- Roadmapa i Programy: menu wiersza projektu ma pozycję „Zależności”. Strona zespołu: liczba zależności i czerwony znacznik konfliktów otwierają listę dla zespołu.
- Strona główna od razu pokazuje Twoje zmiany połączeń z Jirą i Flow, mapowań, synchronizacji i powiązań zespołów.
- Strony logowania i resetu hasła też proponują Odśwież, gdy wdrożono nową wersję.
- API (\`/api/v1\`): \`GET /views/dependencies\` (każdy zalogowany użytkownik/zalogowana użytkowniczka) zwraca stronę Zależności w jednym odczycie.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.19.0",
    date: "2026-11-14",
    en: `**Astrolabe 1.19.0: Home's figures lead somewhere.**

- Home: "not scheduled yet" opens the new Milestones page with those milestones; the Roadmap card's warnings and infos open the Roadmap showing the flagged projects only; "teams with an overloaded week" and "teams over the WIP limit" open the new Team load page with those teams. Under "Yours", a project's or a team's count of milestones not scheduled opens them, a work stream's or a program's name opens the Roadmap filtered to it, and one link opens your own projects on the Roadmap.
- Milestones (new, under Planning): every milestone of the plan with its project, team, estimate and dates; filter by schedule, team or name, sort by milestone, project or team. A team's manager (or an administrator) still sets the dates on the team's page.
- Team load (new, under Planning): every team with its milestones, how many are not scheduled, its overloaded weeks, its weeks over the WIP limit and its weeks without any capacity set. A team's name opens its page.
- Roadmap: the filters and the program pick are now in the address, so a filtered Roadmap is a link you can copy. A link that names filters is shown as written and does not change the filters your browser remembers; opening the Roadmap from the menu brings yours back.
- Home keeps its figures for up to a minute before reading them again; a change you make yourself still shows at once.
- API (\`/api/v1\`): \`GET /milestones\` filters by \`scheduled\`, \`teamId\` and \`projectId\` and sorts by \`projectName\` and \`teamName\`; \`GET /views/team-load\` (any signed-in user) answers the Team load page in one read.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.19.0: liczby na stronie głównej dokądś prowadzą.**

- Strona główna: „jeszcze niezaplanowane” otwiera nową stronę Kamienie milowe z tymi kamieniami; ostrzeżenia i informacje z karty Roadmapa otwierają roadmapę z samymi projektami z flagami; „zespoły z przeciążonym tygodniem” i „zespoły ponad limitem WIP” otwierają nową stronę Obciążenie zespołów z tymi zespołami. W sekcji „Twoje” liczba niezaplanowanych kamieni milowych projektu albo zespołu otwiera je, nazwa strumienia prac albo programu otwiera roadmapę przefiltrowaną do niego, a jeden link otwiera Twoje projekty na roadmapie.
- Kamienie milowe (nowa strona w sekcji Planowanie): każdy kamień milowy planu z projektem, zespołem, szacunkiem i datami; filtr po harmonogramie, zespole i nazwie, sortowanie po kamieniu milowym, projekcie i zespole. Daty nadal ustawia kierownik/czka zespołu (albo administrator/ka) na stronie zespołu.
- Obciążenie zespołów (nowa strona w sekcji Planowanie): każdy zespół z kamieniami milowymi, liczbą niezaplanowanych, przeciążonymi tygodniami, tygodniami ponad limitem WIP i tygodniami bez ustawionej przepustowości. Nazwa zespołu otwiera jego stronę.
- Roadmapa: filtry i wybór programów są teraz w adresie, więc przefiltrowaną roadmapę możesz skopiować jako link. Link z filtrami pokazuje dokładnie to, co w nim zapisano, i nie zmienia filtrów zapamiętanych w Twojej przeglądarce; roadmapa otwarta z menu przywraca Twoje.
- Strona główna zachowuje swoje liczby do minuty, zanim odczyta je ponownie; zmianę, którą wprowadzasz sam/a, nadal widać od razu.
- API (\`/api/v1\`): \`GET /milestones\` filtruje po \`scheduled\`, \`teamId\` i \`projectId\` oraz sortuje po \`projectName\` i \`teamName\`; \`GET /views/team-load\` (każdy zalogowany użytkownik/zalogowana użytkowniczka) zwraca stronę Obciążenie zespołów w jednym odczycie.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.18.0",
    date: "2026-11-14",
    en: `**Astrolabe 1.18.0: Home shows the plan in figures and what is yours.**

- Home, Plan card: how many work streams, programs, projects and milestones the plan has, and how many milestones are not scheduled yet.
- Home, Roadmap card: ranked and unranked projects, the Roadmap's warnings and infos, violated dependencies (every violated link once, also links inside one project), and how many teams have an overloaded week or a week over the WIP limit.
- Home, "Yours": the work streams, programs and projects owned by the person linked to your login, and the teams that person manages, each with the figures its own page shows and a link to it. A team's Jira count opens the Deviations page filtered to that team. If your login is not linked to a person, Home says so; administrators link people to logins on the People page.
- Home adds "may be out of date" next to Jira and Flow figures by the same rule as the other pages.
- API (\`/api/v1\`): \`GET /views/home\` (any signed-in user) answers the plan's figures and the caller's own items in one read. If a tab was open during the upgrade, reload it.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.18.0: strona główna pokazuje plan w liczbach i to, co należy do Ciebie.**

- Strona główna, karta Plan: ile strumieni prac, programów, projektów i kamieni milowych ma plan oraz ile kamieni milowych nie jest jeszcze zaplanowanych.
- Strona główna, karta Roadmapa: projekty z miejscem w rankingu i bez niego, ostrzeżenia i informacje z Roadmapy, naruszone zależności (każde naruszone powiązanie raz, także powiązania wewnątrz jednego projektu) oraz ile zespołów ma przeciążony tydzień albo tydzień ponad limitem WIP.
- Strona główna, „Twoje”: strumienie prac, programy i projekty, których właścicielem/właścicielką jest osoba powiązana z Twoim loginem, oraz zespoły, którymi ta osoba kieruje, każdy z liczbami ze swojej strony i odnośnikiem do niej. Liczba odchyleń z Jiry przy zespole otwiera stronę Odchylenia zawężoną do tego zespołu. Jeśli Twój login nie jest powiązany z żadną osobą, strona główna to mówi; osoby z loginami powiązują administratorzy/rki na stronie Osoby.
- Strona główna dodaje „mogą być nieaktualne” przy liczbach z Jiry i Flow według tej samej reguły co pozostałe strony.
- API (\`/api/v1\`): \`GET /views/home\` (każdy zalogowany użytkownik/zalogowana użytkowniczka) zwraca liczby planu i elementy wywołującego w jednym odczycie. Jeśli karta była otwarta podczas aktualizacji, odśwież ją.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.17.0",
    date: "2026-11-14",
    en: `**Astrolabe 1.17.0: one "may be out of date" rule everywhere, the warning on the Roadmap and Programs pages, scheduling a milestone on Jira's dates in one click, and a notice when a new version is deployed.**

- Project and team pages: the dashed Jira row of a milestone that is not scheduled yet has a menu with "Schedule on Jira's dates", for whoever may schedule it (the team's manager or an administrator). It writes both of Jira's dates at once; Unschedule takes it back.
- Roadmap and Programs pages: the line under the title adds "Jira data may be out of date" while a Jira connection behind any of the plan's links has no current successful synchronisation, is switched off, or its mapping no longer fits the site.
- Deviations page: the warning above the list now follows the same rule as the "may be out of date" chips. It also shows when the last successful synchronisation is older than expected, during a connection's first synchronisation and while one runs again after a failure; "Data from Jira" says why, and the dated "no deviations" sentence waits for a current synchronisation. A switched-off connection still raises no warning there; its own row says so.
- Roadmap and Programs pages: a screen reader hears "Showing the critical path to…" once per pick, and no longer again after a baseline is picked.
- After you sign in: when a new version of Astrolabe has been deployed, a notice at the top of the page offers Reload. Tabs opened before this version need one reload by hand.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.17.0: jedna reguła „mogą być nieaktualne” wszędzie, ostrzeżenie na stronach Roadmapa i Programy, planowanie kamienia milowego według dat z Jiry jednym kliknięciem oraz komunikat, gdy wdrożono nową wersję.**

- Strony projektu i zespołu: przerywany wiersz Jiry kamienia milowego, który nie jest jeszcze zaplanowany, ma menu z „Zaplanuj według dat z Jiry” dla każdego, kto może go planować (kierownik/czka zespołu albo administrator/ka). Zapisuje obie daty z Jiry naraz; „Usuń z harmonogramu” to cofa.
- Strony Roadmapa i Programy: linia pod tytułem dodaje „Dane z Jiry mogą być nieaktualne”, gdy połączenie z Jirą za którymkolwiek z powiązań planu nie ma aktualnej udanej synchronizacji, jest wyłączone albo jego mapowanie nie pasuje już do witryny.
- Strona Odchylenia: ostrzeżenie nad listą stosuje teraz tę samą regułę co etykiety „mogą być nieaktualne”. Pokazuje się też, gdy ostatnia udana synchronizacja jest starsza, niż powinna, podczas pierwszej synchronizacji połączenia i podczas ponownej próby po błędzie; „Dane z Jiry” wyjaśnia dlaczego, a datowane zdanie „brak odchyleń” czeka na aktualną synchronizację. Wyłączone połączenie nadal nie wywołuje tam ostrzeżenia; mówi o tym jego własny wiersz.
- Strony Roadmapa i Programy: czytnik ekranu słyszy „Pokazano ścieżkę krytyczną do…” raz na wybór, a nie ponownie po wybraniu wersji bazowej.
- Po zalogowaniu: gdy wdrożono nową wersję Astrolabe, komunikat u góry strony proponuje „Odśwież”. Karty otwarte przed tą wersją trzeba raz odświeżyć ręcznie.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.16.0",
    date: "2026-11-14",
    en: `**Astrolabe 1.16.0: the timelines show more of what the plan already knows - Jira dates for milestones not scheduled yet, a warning when Jira data may be out of date, arrows between folded rows and the critical path on the Programs page.**

- Project and team pages: a milestone that is not scheduled yet but has both dates in Jira gets a row on the timeline with Jira's dashed bar (while "Jira dates" is on). The row is read-only; you still schedule the milestone from the Unscheduled list.
- Project and team pages: the Jira line under the title adds "Jira data may be out of date" when a connection behind it has no current successful synchronisation, is switched off, or its mapping no longer fits the site. The Deviations page says why.
- Programs page: a folded program or work stream still shows what depends on what, as one arrow per pair of rows. The arrow's tooltip counts the links behind it, and it is red when one of them is violated.
- Programs page: "Critical path to…", as on the Roadmap. Pick a project to see what drives its end; a folded row that holds a project on the path is outlined. A project's row menu offers it too.
- API (\`/api/v1\`): \`jiraSites\` on the timeline views gives each connection's \`state\` and \`mappingOk\`; \`GET /views/programs\` takes \`?criticalPath=\` and answers a \`criticalPath\` block, as \`GET /views/roadmap\` does. If a tab was open during the upgrade, reload it.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.16.0: osie czasu pokazują więcej z tego, co plan już wie - daty z Jiry dla kamieni milowych jeszcze nie zaplanowanych, ostrzeżenie, gdy dane z Jiry mogą być nieaktualne, strzałki między zwiniętymi wierszami i ścieżkę krytyczną na stronie Programy.**

- Strony projektu i zespołu: kamień milowy, który nie jest jeszcze zaplanowany, ale ma w Jirze obie daty, dostaje wiersz na osi czasu z przerywanym paskiem Jiry (gdy „Daty z Jiry” są włączone). Wiersz jest tylko do odczytu; kamień milowy nadal planujesz z listy Niezaplanowane.
- Strony projektu i zespołu: linia Jiry pod tytułem dodaje „Dane z Jiry mogą być nieaktualne”, gdy połączenie za nią nie ma aktualnej udanej synchronizacji, jest wyłączone albo jego mapowanie nie pasuje już do witryny. Strona Odchylenia wyjaśnia dlaczego.
- Strona Programy: zwinięty program lub strumień prac nadal pokazuje, co od czego zależy, jedną strzałką na parę wierszy. Podpowiedź strzałki podaje, ile powiązań za nią stoi, a strzałka jest czerwona, gdy któreś z nich jest naruszone.
- Strona Programy: „Ścieżka krytyczna do…”, jak na Roadmapie. Wybierz projekt, aby zobaczyć, co wyznacza jego koniec; zwinięty wiersz zawierający projekt ze ścieżki ma obramowanie. Proponuje to także menu wiersza projektu.
- API (\`/api/v1\`): \`jiraSites\` w widokach osi czasu podaje \`state\` i \`mappingOk\` każdego połączenia; \`GET /views/programs\` przyjmuje \`?criticalPath=\` i odpowiada blokiem \`criticalPath\`, tak jak \`GET /views/roadmap\`. Jeśli karta była otwarta podczas aktualizacji, odśwież ją.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.15.0",
    date: "2026-11-14",
    en: `**Astrolabe 1.15.0: more ways into the Jira import, a suggested link for an item renamed in Jira, an import from a linked item that never writes outside it, and lighter Jira data on the timelines.**

- Plan page: a project linked to Jira has "Import from Jira…" in its row menu, for whoever may add milestones to it. It imports what Jira lists under that project, as the button on the project page does.
- Jira connection page (administrators): each program and project in "Links to plan items" has its own "Import from Jira…" button, which starts the import from that item.
- Import from Jira: when a Jira item would be created but the plan already has an unlinked item with the same words in its name under the same parent (upper and lower case, accents, punctuation and word order do not matter; the longer name may only add words; numbers and single letters must be equal), the row says "Looks like … in the plan, which is not linked yet" and offers "Link instead". Press it, then "Preview again": the preview then shows the row as a link and places what is under it beneath the existing item. "Create instead" and "Undo" take it back, and "Possible matches only" lists just those rows. Import stays disabled until the preview shows your change, and your ticks, team and owner choices on the other rows are kept.
- Import from a linked program: a Jira item that belongs under a project of another program is now skipped, with a sentence saying so, instead of refusing the whole preview or being created under that other program's project. An import started from an item never writes outside it, for administrators too.
- The Plan page reads which programs and projects are linked to Jira with one small request instead of computing every deviation, so it opens faster.
- API (\`/api/v1\`): \`GET /views/jira-links\` (every program and project link with its connection, any signed-in user); \`can.createMilestone\` on the plan view's projects; the import's \`suggestion\` on a preview row, \`matches\` on the preview and the apply, the info \`MATCH_CONFIRMED\` and the skip reason \`OUTSIDE_ROOT\`. On the timeline views and \`GET /views/deviations\`, a flag's and a deviation detail's empty members are now left out instead of sent as null, and a flag's evidence no longer repeats the severity. If a tab was open during the upgrade, reload it.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.15.0: więcej sposobów na import z Jiry, podpowiedź powiązania dla elementu przemianowanego w Jirze, import spod powiązanego elementu, który nigdy nie zapisuje poza nim, oraz lżejsze dane Jiry na osiach czasu.**

- Strona Plan: projekt powiązany z Jirą ma w menu wiersza „Importuj z Jiry…” dla każdego, kto może dodawać do niego kamienie milowe. Importuje to, co Jira ma pod tym projektem, tak jak przycisk na stronie projektu.
- Strona połączenia z Jirą (administratorzy/ki): każdy program i projekt w „Powiązania z elementami planu” ma własny przycisk „Importuj z Jiry…”, który zaczyna import od tego elementu.
- Import z Jiry: gdy element z Jiry miałby powstać, a plan ma już pod tym samym rodzicem niepowiązany element z tymi samymi słowami w nazwie (wielkość liter, polskie znaki, interpunkcja i kolejność słów nie mają znaczenia; dłuższa nazwa może tylko dodawać słowa; liczby i pojedyncze litery muszą się zgadzać), wiersz mówi „Przypomina element planu …, który nie jest jeszcze powiązany” i proponuje „Powiąż zamiast tego”. Kliknij, a potem „Pokaż podgląd ponownie”: podgląd pokaże wtedy wiersz jako powiązanie i umieści to, co jest pod nim, pod istniejącym elementem. „Utwórz zamiast tego” i „Cofnij” to odwracają, a „Tylko możliwe powiązania” pokazuje tylko takie wiersze. Importuj pozostaje wyłączone, dopóki podgląd nie pokaże zmiany, a zaznaczenia oraz wybrane zespoły i właściciele/ki pozostałych wierszy zostają.
- Import spod powiązanego programu: element z Jiry, który należy do projektu z innego programu, jest teraz pomijany, z wyjaśnieniem, zamiast odrzucać cały podgląd albo powstawać pod projektem tamtego programu. Import zaczęty od elementu nigdy nie zapisuje poza nim, także dla administratorów/ek.
- Strona Plan sprawdza, które programy i projekty są powiązane z Jirą, jednym małym zapytaniem zamiast liczyć wszystkie odchylenia, więc otwiera się szybciej.
- API (\`/api/v1\`): \`GET /views/jira-links\` (każde powiązanie programu i projektu z jego połączeniem, dla każdego zalogowanego konta); \`can.createMilestone\` przy projektach w widoku planu; \`suggestion\` w wierszu podglądu importu, \`matches\` w podglądzie i zastosowaniu, informacja \`MATCH_CONFIRMED\` i powód pominięcia \`OUTSIDE_ROOT\`. W widokach osi czasu i \`GET /views/deviations\` puste pola flagi i szczegółów odchylenia są teraz pomijane zamiast wysyłane jako null, a dowód flagi nie powtarza już wagi. Jeśli karta była otwarta podczas aktualizacji, odśwież ją.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.14.0",
    date: "2026-11-13",
    en: `**Astrolabe 1.14.0: import what Jira lists under a linked program or project, see how much of a Jira site the plan covers, choose an owner per row and copy a new project's target window in the import, and a new "Children open" deviation.**

- Import from Jira under a linked item: a program linked to Jira has "Import from Jira…" in its menu on the Plan page, and a linked project has an "Import from Jira…" button on its page. The import reads only what Jira lists under that item (for a program its projects and their milestones, for a project its milestones), with the same preview, filter and checks as before, and everything it creates lands under that item. It can be started by whoever owns the item or anything above it, or by an administrator.
- Jira connection page (administrators): a new **Coverage** table says, per mapped level, how many of the site's issues are in scope, how many are linked to the plan and how many are open and unlinked, counted as of the last successful synchronisation. After the mapping changes it says so until the next synchronisation counts the new levels.
- Import from Jira: each program or project the import creates has its own owner picker in the preview. By default every row gets the owner chosen in the first step; "Use the owner chosen in the first step" puts a row back.
- Import from Jira: with "Copy Jira's dates" on, a project the import creates also gets its target window from Jira (by default Target start and Target end). It needs both dates; otherwise the project is still created, without a window, and the row says why. A project that already exists is never changed. Because the window comes from Jira, a newly imported project can show date flags against its milestones straight away.
- Deviations: a new info, **Children open**: a milestone whose plan has ended while some of its Jira child issues are still open ("2 of 5 child issues still open in Jira while the plan ended …"). It can be acknowledged; the acknowledgement ends when the counts change.
- Keyboard: after a dialog or menu closes, focus no longer jumps back to the row it was opened from if you have already moved to another row.
- API (\`/api/v1\`): the import's preview and apply take an optional \`root {level, nodeId}\`, and an unusable root answers \`409\` \`urn:astrolabe:problem:jira-root-unusable\`; \`overrides.ownerPersonId\` per item; the warning \`ROOTED_IMPORT_TRUNCATED\`; the row note \`TARGET_NOT_COPIED\`; \`GET /integrations/jira/connections/{id}/coverage\` (administrators); the deviation kind \`CHILDREN_OPEN\`.
- Under the hood: one version of the date library is used everywhere, and a check keeps it that way.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.14.0: import tego, co Jira ma pod powiązanym programem lub projektem, podgląd, ile z instancji Jiry obejmuje plan, wybór właściciela/ki dla każdego wiersza i kopiowanie okna docelowego nowego projektu w imporcie oraz nowe odchylenie „Dzieci otwarte”.**

- Import z Jiry spod powiązanego elementu: program powiązany z Jirą ma w swoim menu na stronie Plan pozycję „Importuj z Jiry…”, a powiązany projekt ma na swojej stronie przycisk „Importuj z Jiry…”. Import czyta tylko to, co Jira ma pod tym elementem (dla programu jego projekty i ich kamienie milowe, dla projektu jego kamienie milowe), z tym samym podglądem, filtrem i sprawdzeniami co dotąd, a wszystko, co tworzy, trafia pod ten element. Może go uruchomić właściciel/ka tego elementu albo czegokolwiek nad nim lub administrator/ka.
- Strona połączenia z Jirą (administratorzy/ki): nowa tabela **Pokrycie** pokazuje dla każdego zmapowanego poziomu, ile zgłoszeń z instancji jest w zakresie, ile jest powiązanych z planem, a ile otwartych i niepowiązanych, według ostatniej udanej synchronizacji. Po zmianie mapowania mówi o tym, dopóki następna synchronizacja nie policzy nowych poziomów.
- Import z Jiry: każdy program i projekt, który import tworzy, ma w podglądzie własny wybór właściciela/ki. Domyślnie każdy wiersz dostaje właściciela/kę wybranego/ą w pierwszym kroku; „Użyj właściciela/ki z pierwszego kroku” przywraca to dla wiersza.
- Import z Jiry: przy włączonym „Kopiuj daty z Jiry” projekt, który import tworzy, dostaje też okno docelowe z Jiry (domyślnie Target start i Target end). Potrzebne są obie daty; inaczej projekt i tak powstaje, ale bez okna, a wiersz mówi dlaczego. Istniejący projekt nigdy się nie zmienia. Ponieważ okno pochodzi z Jiry, nowo zaimportowany projekt może od razu pokazać flagi dat względem swoich kamieni milowych.
- Odchylenia: nowa informacja **Dzieci otwarte**: kamień milowy, którego plan się zakończył, a część jego zgłoszeń podrzędnych w Jirze jest nadal otwarta („Otwartych zgłoszeń podrzędnych w Jirze: 2 z 5, a plan zakończył się …”). Można ją potwierdzić; potwierdzenie wygasa, gdy liczby się zmienią.
- Klawiatura: po zamknięciu okna dialogowego lub menu fokus nie wraca już do wiersza, z którego je otwarto, jeśli przeszedłeś/aś już do innego wiersza.
- API (\`/api/v1\`): podgląd i zastosowanie importu przyjmują opcjonalny \`root {level, nodeId}\`, a nieużywalny korzeń odpowiada \`409\` \`urn:astrolabe:problem:jira-root-unusable\`; \`overrides.ownerPersonId\` dla elementu; ostrzeżenie \`ROOTED_IMPORT_TRUNCATED\`; uwaga wiersza \`TARGET_NOT_COPIED\`; \`GET /integrations/jira/connections/{id}/coverage\` (administratorzy/ki); rodzaj odchylenia \`CHILDREN_OPEN\`.
- Pod maską: wszędzie używana jest jedna wersja biblioteki dat, a sprawdzenie pilnuje, żeby tak zostało.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.13.4",
    date: "2026-11-12",
    en: `**Astrolabe 1.13.4: the Jira import's preview can be searched, so one item can be picked out of a long list.**

- Import from Jira: the preview has a search box above the list. It shows only the rows whose Jira key, id or name contains what you type (upper and lower case and Polish letters match either way), with "Showing X of Y" next to it.
- Searching only hides rows: what is ticked stays ticked, "N of M selected" and the Import button still count every ticked row, and the import brings in every ticked row, shown or not.
- While a search is on, the buttons read "Tick shown" and "Untick shown" and act on the shown rows only (so does the checkbox in the header). Ticking an item still ticks the parent it is created under, and unticking one still unticks what is created under it, even when those rows are not shown; a line says so.
- To import one item: press "Select none", search for its key, press "Tick shown", then Import.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.13.4: podgląd importu z Jiry można przeszukiwać, więc z długiej listy da się wybrać jeden element.**

- Import z Jiry: nad listą w podglądzie jest pole wyszukiwania. Pokazuje tylko wiersze, których klucz Jiry, identyfikator albo nazwa zawiera wpisany tekst (wielkość liter i polskie znaki nie mają znaczenia), a obok widać „Pokazano X z Y”.
- Wyszukiwanie tylko ukrywa wiersze: zaznaczone zostają zaznaczone, „N z M zaznaczonych” i przycisk Importuj nadal liczą każdy zaznaczony wiersz, a import obejmuje każdy zaznaczony wiersz, widoczny czy nie.
- Podczas wyszukiwania przyciski mówią „Zaznacz widoczne” i „Odznacz widoczne” i działają tylko na widocznych wierszach (tak samo pole wyboru w nagłówku). Zaznaczenie elementu nadal zaznacza rodzica, pod którym powstanie, a odznaczenie nadal odznacza to, co powstałoby pod nim, nawet jeśli te wiersze nie są widoczne; mówi o tym osobny wiersz.
- Żeby zaimportować jeden element: kliknij „Odznacz wszystko”, wyszukaj jego klucz, kliknij „Zaznacz widoczne”, a potem Importuj.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.13.3",
    date: "2026-11-12",
    en: `**Astrolabe 1.13.3: a new login can create its person in the same step, the roadmap's flags can be filtered by severity, a moved Jira item shows the key it was linked with, and an information leak in the Jira import and a race between capacity edits are closed.**

- Administration → Users: the new-login form has a switch "Also create a linked person", on by default. It creates the person (the login's name and email, linked to the login) in the same step, so the login can be picked as an owner or a team manager at once. If a person with that email already exists, nothing is created and the message says to turn the switch off and link that person on the People page.
- Administration → Users: a login that has no person linked gets "Create a person" in its row menu. It makes the person from the login's name and email and links it; if the email is taken or the login is already linked, the message points to the People page.
- Roadmap: the flag panel has an All / Warnings / Infos filter, with the count in each option ("All (5)", "Warnings (3)", "Infos (2)"). It narrows the list only; the row icons and the panel's count stay as they were, and it is not remembered.
- Jira: an item that moved to another key shows the key it was linked with next to the current one ("was OLD-1"), on the connection's bindings list and on the Deviations page.
- Jira import (security): with the import filter on, a non-administrator's preview no longer shows any detail of an item hidden from them (its key, id or parent): the row reads "Hidden". The import answers such an item exactly like one that is no longer in Jira, so ticking it, or overriding its checks, tells nothing about it. Administrators and imports without the filter are unchanged.
- Flow capacity: two capacity edits of one team made at the same time can no longer leave an acknowledgement standing that the second edit settles. If clearing acknowledgements fails, the capacity edit now fails as a whole instead of being saved without it.
- API (\`/api/v1\`): admitted answers no longer carry \`X-RateLimit-*\` headers; a refused request (\`429\`) carries only \`Retry-After\`, in whole seconds rounded up. \`POST /users\` takes an optional \`alsoCreatePerson\` (default false; not stored), and every user carries \`personId\` (the linked person, or null). \`DeviationJira.previousKey\` (the key the item was linked with, or null). \`JiraImportItem.issueKey\` can be null on rows hidden under the filter.
- Under the hood: the image build fails with the real cause when Ubuntu's package index cannot be fetched, and a new check keeps the dependency verification metadata free of superseded entries.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.13.3: nowe konto może od razu utworzyć swoją osobę, flagi na roadmapie można filtrować według wagi, przeniesiony element Jiry pokazuje klucz, z którym go powiązano, a wyciek informacji w imporcie z Jiry i wyścig między zmianami przepustowości są zamknięte.**

- Administracja → Użytkownicy/czki: formularz nowego konta ma przełącznik „Utwórz też powiązaną osobę”, domyślnie włączony. Tworzy on osobę (z nazwą i adresem e-mail konta, powiązaną z kontem) w tym samym kroku, więc konto można od razu wybrać jako właściciela/kę albo kierownika/czkę zespołu. Jeśli osoba z takim adresem e-mail już istnieje, nic nie powstaje, a komunikat mówi, żeby wyłączyć przełącznik i powiązać tę osobę na stronie Osoby.
- Administracja → Użytkownicy/czki: konto bez powiązanej osoby ma w menu wiersza „Utwórz osobę”. Tworzy osobę z nazwy i adresu e-mail konta i ją wiąże; jeśli adres jest zajęty albo konto jest już powiązane, komunikat odsyła do strony Osoby.
- Roadmapa: panel flag ma filtr Wszystkie / Ostrzeżenia / Informacje z liczbą przy każdej opcji („Wszystkie (5)”, „Ostrzeżenia (3)”, „Informacje (2)”). Zawęża tylko listę; ikony w wierszach i licznik panelu zostają bez zmian, a wybór nie jest zapamiętywany.
- Jira: element przeniesiony pod inny klucz pokazuje obok bieżącego klucz, z którym go powiązano („wcześniej OLD-1”), na liście powiązań połączenia i na stronie Odchylenia.
- Import z Jiry (bezpieczeństwo): przy włączonym filtrze importu podgląd osoby niebędącej administratorem/ką nie pokazuje już żadnych szczegółów elementu ukrytego przed nią (klucza, identyfikatora ani rodzica): wiersz mówi „Ukryty”. Import odpowiada na taki element dokładnie jak na element, którego nie ma już w Jirze, więc jego zaznaczenie ani pominięcie jego kontroli niczego o nim nie zdradza. Administratorzy/rki i importy bez filtra działają jak dotąd.
- Przepustowość Flow: dwie jednoczesne zmiany przepustowości jednego zespołu nie mogą już zostawić potwierdzenia, które druga zmiana unieważnia. Jeśli czyszczenie potwierdzeń się nie powiedzie, zmiana przepustowości kończy się teraz błędem w całości, zamiast zapisać się bez tego.
- API (\`/api/v1\`): przyjęte odpowiedzi nie niosą już nagłówków \`X-RateLimit-*\`; odrzucone żądanie (\`429\`) niesie tylko \`Retry-After\`, w pełnych sekundach, zaokrąglone w górę. \`POST /users\` przyjmuje opcjonalne \`alsoCreatePerson\` (domyślnie false; nie jest zapisywane), a każde konto niesie \`personId\` (powiązana osoba lub null). \`DeviationJira.previousKey\` (klucz, z którym element powiązano, lub null). \`JiraImportItem.issueKey\` może być null w wierszach ukrytych przez filtr.
- Pod maską: budowanie obrazu kończy się błędem z prawdziwą przyczyną, gdy nie da się pobrać indeksu pakietów Ubuntu, a nowa kontrola pilnuje, żeby metadane weryfikacji zależności nie zawierały przestarzałych wpisów.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.13.2",
    date: "2026-11-11",
    en: `**Astrolabe 1.13.2: the Jira import can leave out done items and items nobody has touched for a while, so a large Jira project can be imported.**

- Import from Jira: the first step has two new settings, both on when the dialog opens. "Leave out done items" skips items whose Jira status is in the Done category. "Updated within (days)" reads only items updated in Jira within that many days: 365 to start with, from 1 to 3,650; leave it empty to read items of any age. Nothing is stored: the settings belong to that one import, and its apply uses the same ones as its preview.
- What it is for: a Jira project with more than 2,000 items at the mapped levels could not be imported at all. With the settings it can. The message for a scope that is still too large now says to "change what is left out" as well as to narrow the Jira projects.
- The preview names what was left out ("Left out: done items. Their parents in the selected projects are still read."), but not how many items that was.
- A parent is kept: a done or long-untouched parent of an item that is read is read from Jira on its own, when it is in the selected Jira projects, and shown with the note "Kept as a parent of an item shown here", so nothing lands under the wrong parent. At most 200 such parents are read per import; past that the preview says the scope is too large and Import stays disabled.
- An item whose parent Jira answers that it does not exist or is not visible is skipped, and its row says "Its parent in Jira could not be read with the connection's account (Jira answered that it does not exist or is not visible)"; it is not put under the default parent. Any other failure of that read (Jira refuses the connection's account, limits the requests or is down) fails the preview with the Jira error instead.
- Only the import reads through these settings. Refresh now, the Deviations page and the story roll-ups read everything as before, and an item imported earlier that later becomes done stays linked. An open item that the time window left out shows as "Not in plan" on its parent's row of the Deviations page.
- As before: an item renamed in Jira still previews as a new one, an existing plan item is never overwritten, and dates are copied only where you manage the team.
- API (\`/api/v1\`, additive): \`POST /integrations/jira/connections/{id}/import-preview\` and \`…/import\` take an optional \`filter\` with \`excludeDone\` and \`updatedWithinDays\` (absent means everything, as before); rows can carry the infos \`KEPT_AS_PARENT\` and \`PARENT_UNREADABLE\`; \`totals.truncated\` is also true when more than 200 parents would have to be read.
- Nothing is written to Jira.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.13.2: import z Jiry może pomijać elementy zakończone i takie, których dawno nikt nie ruszał, więc można zaimportować duży projekt Jiry.**

- Import z Jiry: pierwszy krok ma dwa nowe ustawienia, oba włączone po otwarciu okna. „Pomiń zakończone elementy” pomija elementy, których status w Jirze należy do kategorii „Gotowe” (Done). „Zaktualizowane w ciągu (dni)” wczytuje tylko elementy zaktualizowane w Jirze w ciągu tylu dni: na początku 365, od 1 do 3650; puste pole oznacza elementy bez względu na wiek. Niczego nie zapamiętujemy: ustawienia należą do jednego importu, a jego zastosowanie używa tych samych co podgląd.
- Po co: projekt Jiry z ponad 2000 elementów na zmapowanych poziomach nie dawał się w ogóle zaimportować. Z tymi ustawieniami się da. Komunikat o zakresie, który nadal jest za duży, podpowiada teraz, żeby oprócz zawężenia projektów Jiry zmienić to, co jest pomijane.
- Podgląd mówi, co pominięto („Pominięte: elementy zakończone. Ich rodzice w wybranych projektach są nadal wczytywani.”), ale nie ile to elementów.
- Rodzic zostaje: zakończony lub od dawna nieruszany rodzic wczytanego elementu jest wczytywany z Jiry osobno, o ile leży w wybranych projektach Jiry, i pokazany z uwagą „Zostaje jako rodzic pokazanego tu elementu”, więc nic nie ląduje pod niewłaściwym rodzicem. Wczytujemy najwyżej 200 takich rodziców na import; powyżej podgląd informuje, że zakres jest za duży, a przycisk Importuj pozostaje wyłączony.
- Element, którego rodzica Jira nie widzi albo który nie istnieje, jest pomijany, a jego wiersz mówi: „Nie udało się odczytać jego rodzica w Jirze kontem połączenia (Jira odpowiedziała, że nie istnieje albo nie jest widoczny)”; nie trafia pod domyślnego rodzica. Każda inna porażka tego odczytu (Jira odrzuca konto połączenia, ogranicza liczbę żądań albo nie działa) kończy podgląd błędem Jiry.
- Tylko import czyta przez te ustawienia. „Odśwież teraz”, strona Odchylenia i podsumowania historyjek czytają wszystko jak dotąd, a element zaimportowany wcześniej, który później zostanie zakończony, pozostaje powiązany. Otwarty element pominięty przez okno czasowe widać jako „Brak w planie” w wierszu jego rodzica na stronie Odchylenia.
- Jak dotąd: element przemianowany w Jirze nadal pojawia się w podglądzie jako nowy, istniejący element planu nigdy nie jest nadpisywany, a daty są kopiowane tylko tam, gdzie zarządzasz zespołem.
- API (\`/api/v1\`, tylko dodatki): \`POST /integrations/jira/connections/{id}/import-preview\` i \`…/import\` przyjmują opcjonalny obiekt \`filter\` z polami \`excludeDone\` i \`updatedWithinDays\` (brak oznacza wszystko, jak dotąd); wiersze mogą nieść informacje \`KEPT_AS_PARENT\` i \`PARENT_UNREADABLE\`; \`totals.truncated\` jest też prawdziwe, gdy trzeba by wczytać ponad 200 rodziców.
- Niczego nie zapisujemy w Jirze.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.13.1",
    date: "2026-11-11",
    en: `**Astrolabe 1.13.1: Refresh now is limited to 10 a minute per user, a changed holiday no longer refuses a proposal's accept needlessly, and a capacity edit that brings a sprint in line clears its acknowledgement.**

- Refresh now (Jira and Flow connections, the Deviations page): one account can start at most 10 refreshes a minute; past that the page says "Too many requests. Wait a minute and try again." Scheduled polling is not limited.
- Capacity against Flow: an acknowledged sprint that a capacity import or a hand-edited capacity period brings in line with Flow loses its acknowledgement at once, so the same difference is open if it returns. Until now only a refresh or another acknowledge cleared it.
- Schedule proposals (a team's and the cross-team run): a public holiday added or removed while a proposal is open no longer refuses its accept, unless it changes a date being accepted; then the page proposes again, as before.
- Keyboard: closing a row's Delete dialog with Escape while the list refreshes returns the focus to the row's menu button.
- API (\`/api/v1\`): \`POST /integrations/sync/runs\` can answer \`429\` with \`Retry-After\`; \`scopeHash\` is still 64 hexadecimal characters to send back unchanged, and a proposal open during the upgrade is proposed again once.
- The sample-plan loader: a reload over existing holidays works; a sample milestone whose days all fall on public holidays is extended to its next working day.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.13.1: „Odśwież teraz” ma limit 10 na minutę na konto, zmieniony dzień wolny nie odrzuca już niepotrzebnie przyjęcia propozycji, a zmiana przepustowości, która doprowadza sprint do zgodności, czyści jego potwierdzenie.**

- „Odśwież teraz” (połączenia Jiry i Flow, strona Odchylenia): jedno konto może uruchomić najwyżej 10 odświeżeń na minutę; powyżej strona pokazuje „Zbyt wiele żądań. Odczekaj minutę i spróbuj ponownie.” Odpytywanie według harmonogramu nie ma limitu.
- Przepustowość a Flow: potwierdzony sprint, który import przepustowości lub ręcznie zmieniony okres przepustowości doprowadza do zgodności z Flow, od razu traci potwierdzenie, więc ta sama różnica jest otwarta, jeśli wróci. Dotąd czyściło je tylko odświeżenie lub kolejne potwierdzenie.
- Propozycje harmonogramu (zespołu i przebiegu dla wielu zespołów): dzień wolny dodany lub usunięty, gdy propozycja jest otwarta, nie odrzuca już jej przyjęcia, chyba że zmienia przyjmowaną datę; wtedy strona proponuje ponownie, jak dotąd.
- Klawiatura: zamknięcie okna usuwania z wiersza klawiszem Escape podczas odświeżania listy oddaje fokus przyciskowi menu wiersza.
- API (\`/api/v1\`): \`POST /integrations/sync/runs\` może odpowiedzieć \`429\` z nagłówkiem \`Retry-After\`; \`scopeHash\` nadal ma 64 znaki szesnastkowe do odesłania bez zmian, a propozycja otwarta podczas aktualizacji zostanie zaproponowana ponownie jeden raz.
- Skrypt wczytujący przykładowy plan: ponowne wczytanie przy istniejących dniach wolnych działa; przykładowy kamień milowy, którego wszystkie dni wypadają w dni wolne, jest przedłużany do najbliższego dnia roboczego.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.13.0",
    date: "2026-11-11",
    en: `**Astrolabe 1.13.0: a Jira item moved to another project shows its current key, the Deviations header tells "gone" from "still in Jira", and a Jira probe that gets no answer stops repeating its warnings.**

- Deviations page: a Jira item that moved to a project outside the connection's projects now shows its new key and links to it (for example OUT-6 instead of E2E-10).
- A Jira item that is still in the connection's projects, but that Jira no longer lists, now reads "Still in the connection's projects, but Jira no longer lists it (archived, or its type changed)", with a "Not listed by Jira" badge.
- The header splits the gone total: "N gone from Jira" counts the rest (deleted, no longer visible, or not checked yet), a new "N still in Jira, out of scope" counts the moved and unlisted ones.
- A Jira item that is gone but still readable is checked again once a day, and at once on Refresh now, so a later deletion or a move back shows up.
- An acknowledged "moved out" deviation reopens once if its reading changes (it now reads "not listed", or turns out deleted or no longer visible).
- When Jira keeps not answering these checks, Astrolabe backs off: it retries once a day and on Refresh now, and the server log stops repeating its warnings on every run.
- API (\`/api/v1\`, additive): \`totals.stillInJira\` in \`GET /views/deviations\`; the gone reason \`NOT_LISTED\`; an item's and a binding's \`key\` is its current key as Jira last answered it.
- Migrations V29 (the key a probe answered with) and V30, which drops the whole-item acknowledgement columns unused since 1.12: versions before 1.12 can no longer run on the database; 1.12 still can.
- Nothing is written to Jira.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.13.0: element Jiry przeniesiony do innego projektu pokazuje swój obecny klucz, nagłówek Odchyleń odróżnia „zniknęło” od „nadal w Jirze”, a sprawdzenie Jiry bez odpowiedzi przestaje powtarzać ostrzeżenia.**

- Strona Odchylenia: element Jiry przeniesiony do projektu spoza projektów połączenia pokazuje teraz swój nowy klucz i prowadzi do niego (na przykład OUT-6 zamiast E2E-10).
- Element Jiry, który nadal jest w projektach połączenia, ale Jira już go nie wymienia, ma teraz opis „Nadal w projektach połączenia, ale Jira już go nie wymienia (zarchiwizowany albo zmieniono mu typ)” i plakietkę „Jira go nie wymienia”.
- Nagłówek dzieli sumę zniknięć: „N zniknęło z Jiry” liczy pozostałe (usunięte, już niewidoczne albo jeszcze niesprawdzone), nowe „N nadal w Jirze, poza zakresem” liczy przeniesione i niewymieniane.
- Element Jiry, który zniknął, ale nadal da się go odczytać, jest sprawdzany ponownie raz dziennie i od razu po „Odśwież teraz”, więc późniejsze usunięcie lub powrót się pokaże.
- Potwierdzone odchylenie „przeniesiony” otworzy się ponownie raz, jeśli zmieni się jego odczyt (teraz „Jira go nie wymienia” albo okaże się usunięty lub niewidoczny).
- Gdy Jira wciąż nie odpowiada na te sprawdzenia, Astrolabe zwalnia: ponawia raz dziennie i po „Odśwież teraz”, a dziennik serwera przestaje powtarzać ostrzeżenia przy każdym przebiegu.
- API (\`/api/v1\`, zmiany addytywne): \`totals.stillInJira\` w \`GET /views/deviations\`; powód zniknięcia \`NOT_LISTED\`; \`key\` elementu i powiązania to jego obecny klucz, taki jak ostatnio podała Jira.
- Migracje V29 (klucz, którym odpowiedziało sprawdzenie) i V30, która usuwa nieużywane od 1.12 kolumny dawnych potwierdzeń całych elementów: wersje starsze niż 1.12 nie mogą już działać na tej bazie; 1.12 nadal może.
- Niczego nie zapisujemy w Jirze.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.12.0",
    date: "2026-11-11",
    en: `**Astrolabe 1.12.0: acknowledge Jira deviations one at a time, the manager of a milestone's team may acknowledge them, and a Jira item that only left the connection's projects reads "moved out".**

- Deviations page: each Jira deviation now has its own Acknowledge / Unacknowledge button and its own note of who acknowledged it and when; a row with at least two open deviations also offers "Acknowledge all (N)", one with at least two acknowledged deviations "Withdraw all (N)". A change in Jira or in the plan reopens only the deviation that changed; a deviation that disappears and comes back unchanged stays acknowledged. The separate acknowledgement column is gone.
- This upgrade withdraws every earlier acknowledgement of a Jira deviation: each acknowledged item reads open once and can be acknowledged again, one deviation at a time or all at once.
- The manager of a milestone's team may now acknowledge and withdraw that milestone's Jira deviations, besides the plan item's owners and the administrators.
- A Jira item gone from the connection's projects that Jira can still read now says "Moved out of the connection's projects (Jira still has it)", with a "Moved out of scope" badge, instead of "deleted, moved out of the connection's projects, or no longer visible".
- Filters: a kind or severity filter now looks at the deviations in the selected status (Open with "End" lists only items whose End deviation is open); the warning and info totals count open deviations.
- Nothing is written to Jira.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.12.0: potwierdzanie odchyleń od Jiry pojedynczo, potwierdzanie przez kierownika/czkę zespołu kamienia milowego oraz opis „przeniesiony” dla elementu Jiry, który tylko opuścił projekty połączenia.**

- Strona Odchylenia: każde odchylenie od Jiry ma teraz własny przycisk Potwierdź / Cofnij potwierdzenie i własną informację, kto i kiedy je potwierdził; wiersz z co najmniej dwoma otwartymi odchyleniami ma też „Potwierdź wszystkie (N)”, a z co najmniej dwoma potwierdzonymi „Cofnij wszystkie (N)”. Zmiana w Jirze lub w planie otwiera ponownie tylko to odchylenie, które się zmieniło; odchylenie, które zniknie i wróci bez zmian, pozostaje potwierdzone. Osobna kolumna potwierdzeń zniknęła.
- Ta aktualizacja cofa wszystkie wcześniejsze potwierdzenia odchyleń od Jiry: każdy potwierdzony element raz pokaże się jako otwarty i można go potwierdzić ponownie, pojedynczo albo wszystkie naraz.
- Kierownik/czka zespołu kamienia milowego może teraz potwierdzać i cofać potwierdzenia odchyleń od Jiry tego kamienia milowego, obok właścicieli/ek elementu planu i administratorów/ek.
- Element Jiry, który zniknął z projektów połączenia, ale Jira nadal go odczytuje, ma teraz opis „Przeniesiony poza projekty połączenia (Jira nadal go ma)” i plakietkę „Przeniesiony poza zakres” zamiast „usunięto go, przeniesiono poza projekty połączenia albo konto połączenia już go nie widzi”.
- Filtry: filtr rodzaju lub ważności dotyczy teraz odchyleń w wybranym statusie (Otwarte z „Koniec” pokazuje tylko elementy z otwartym odchyleniem końca); sumy ostrzeżeń i informacji liczą otwarte odchylenia.
- Niczego nie zapisujemy w Jirze.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.11.0",
    date: "2026-11-11",
    en: `**Astrolabe 1.11.0: withdraw every acknowledgement of a team's capacity differences in one click, and a stalled request is cut on every connection.**

- Capacity differences from Flow: beside "Acknowledge all (N)" a team's list now offers "Withdraw all (N)" when you may acknowledge and at least two of the listed differences are acknowledged; it withdraws the acknowledged rows the list shows (the page's filters apply), on the Deviations page and on the team page. It is all or nothing: if one of them was withdrawn meanwhile, nothing is withdrawn and the list is read again.
- Reliability: a request whose body stops arriving is now cut after the read timeout even on a connection that was reused or sat idle before; the client gets 408 Request Timeout instead of waiting indefinitely.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.11.0: cofnięcie wszystkich potwierdzeń różnic przepustowości zespołu jednym kliknięciem oraz przerywanie zawieszonego żądania na każdym połączeniu.**

- Różnice przepustowości względem Flow: obok „Potwierdź wszystkie (N)” lista zespołu ma teraz „Cofnij wszystkie (N)”, gdy możesz potwierdzać, a co najmniej dwie widoczne różnice są potwierdzone; przycisk cofa potwierdzenia wierszy, które pokazuje lista (filtry strony obowiązują), na stronie Odchylenia i na stronie zespołu. Działa na zasadzie wszystko albo nic: jeśli któreś potwierdzenie zostało w międzyczasie cofnięte, nic nie jest cofane, a lista jest wczytywana ponownie.
- Niezawodność: żądanie, którego treść przestaje napływać, jest teraz przerywane po upływie limitu czasu odczytu także na połączeniu użytym ponownie lub wcześniej bezczynnym; klient dostaje 408 Request Timeout zamiast czekać bez końca.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.10.1",
    date: "2026-11-11",
    en: `**Astrolabe 1.10.1: an "All teams" shortcut on Schedule proposals, the theme in the account menu as menu items, and tighter limits on password changes and outbound calls.**

- Schedule proposals: an administrator can tick every team at once with "All teams" (a run takes at most 50 teams, so it ticks the first 50 listed).
- Account menu: the theme is now three items, Light, Dark and System, with a check mark on the chosen one, like the languages; the menu stays open while you switch. Tab now leaves the menu from any item; the arrow keys move between the items.
- Password change: one account can send at most 10 password changes a minute (its own, or for an administrator the resets of other users' passwords); past that the page says "Too many requests. Wait a minute and try again." The lock after too many wrong current passwords keeps its own message.
- Security: calls the server makes to Jira and Flow also refuse the obsolete IPv4-translated IPv6 range (::ffff:0:0:0/96).
- A refresh that starts while its Jira or Flow connection is being deleted no longer leaves a stray run behind.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.10.1: skrót „Wszystkie zespoły” w propozycjach harmonogramu, motyw w menu konta jako pozycje menu oraz ściślejsze limity zmian hasła i wywołań wychodzących.**

- Propozycje harmonogramu: administrator/ka może zaznaczyć wszystkie zespoły naraz przyciskiem „Wszystkie zespoły” (przebieg obejmuje najwyżej 50 zespołów, więc zaznacza pierwszych 50 z listy).
- Menu konta: motyw to teraz trzy pozycje, Jasny, Ciemny i Systemowy, ze znacznikiem przy wybranej, tak jak języki; menu zostaje otwarte podczas przełączania. Tab zamyka teraz menu z każdej pozycji; strzałki przechodzą między pozycjami.
- Zmiana hasła: jedno konto może wysłać najwyżej 10 zmian hasła na minutę (własnego albo, w przypadku administratora/ki, resetów haseł innych osób); powyżej tego strona pokazuje „Zbyt wiele żądań. Odczekaj minutę i spróbuj ponownie.” Blokada po zbyt wielu błędnych bieżących hasłach zachowuje własny komunikat.
- Bezpieczeństwo: wywołania, które serwer wysyła do Jiry i Flow, odrzucają też przestarzały zakres adresów IPv6 tłumaczonych z IPv4 (::ffff:0:0:0/96).
- Odświeżenie, które startuje w chwili usuwania połączenia z Jirą lub Flow, nie zostawia już osieroconego przebiegu.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.10.0",
    date: "2026-11-10",
    en: `**Astrolabe 1.10.0: a Home page with the open deviations, "Acknowledge all" for capacity differences from Flow, and Jira items told apart when they vanish.**

- Home: the start page now links to the plan, the roadmap and the deviations. Under Deviations it shows how many warnings and how many infos are open, one line for Jira ("Open differences from Jira") and one for Flow ("Open capacity differences from Flow"). A source with no connection, or with nothing open, shows no line.
- Acknowledge all: on Deviations, Capacity from Flow, and in the Flow section of the team page, "Acknowledge all (N)" acknowledges every open line listed for the team in one step, for the team's manager or an administrator. It appears when at least two lines are open, and it acknowledges the lines the list shows, so the page's filters apply. If any of those lines changed since the page was read, nothing is acknowledged, you see the usual note and the list is read again.
- An acknowledgement ends with its line: when a sprint is back in line with Flow or closes, or a team that was missing is back, its acknowledgement is removed at the connection's next refresh or at the next acknowledge on the team; when a sprint leaves Flow's document, at the next refresh. So a difference that returns is open again. A team that is missing from Flow keeps its sprint acknowledgements, and so does a document Flow cut short. A sprint put in line and back to the same figures only by plan edits (a capacity import, an edited period), with no refresh of the connection and no acknowledge on the team in between, still reads acknowledged. A deleted connection takes its acknowledgements with it.
- Jira, items that vanished: Astrolabe now reads each vanished item once by its id and tells the cases apart: "Deleted in Jira (or no longer visible to the connection's account)", or "No longer visible to the connection's account"; an item Jira still returns (it moved out of the connection's projects) keeps the wider "No longer readable in Jira: deleted, moved out of the connection's projects, or no longer visible to its account", as does one not read yet. A read that fails, is cut short or does not fit in one refresh (100 a refresh) is repeated on later refreshes until Jira answers. Items already flagged as gone before this version are classified too, and an acknowledged "gone" deviation whose reason changes opens once.
- Import from Jira on the Plan page: the owner of a work stream starts it from the stream's menu. The connection is picked in the dialog when there are several, and the work stream is preset.
- Timelines: a milestone whose dates cover only weekends or holidays is flagged "Covers no working day: only weekends or holidays" on the project and team pages.
- Baselines: with a baseline picked, the roadmap and the programs page also list the projects removed since, dimmed and marked "(removed)", with their frozen span.
- Security: calls the server makes to Jira and Flow also refuse the deprecated IPv4-compatible IPv6 range.
- Nothing is written to Jira or Flow.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.10.0: strona główna z otwartymi odchyleniami, „Potwierdź wszystkie” dla różnic przepustowości względem Flow i elementy Jiry, które zniknęły, rozróżniane po przyczynie.**

- Strona główna: strona startowa prowadzi teraz do planu, roadmapy i odchyleń. W karcie Odchylenia pokazuje, ile ostrzeżeń i ile informacji jest otwartych: jeden wiersz dla Jiry („Otwarte różnice względem Jiry”) i jeden dla Flow („Otwarte różnice przepustowości względem Flow”). Źródło bez połączenia albo bez otwartych różnic nie pokazuje wiersza.
- Potwierdź wszystkie: w Odchyleniach, w sekcji „Przepustowość z Flow” i w sekcji Flow na stronie zespołu przycisk „Potwierdź wszystkie (N)” potwierdza jednym krokiem wszystkie otwarte wiersze zespołu z listy, kierownikowi/czce zespołu albo administratorowi/ce. Pojawia się, gdy otwarte są co najmniej dwa wiersze, i potwierdza wiersze widoczne na liście, więc filtry strony mają znaczenie. Jeśli którykolwiek z tych wierszy zmienił się od chwili odczytu strony, nic nie zostanie potwierdzone, zobaczysz zwykłą informację, a lista zostanie odczytana ponownie.
- Potwierdzenie kończy się razem z wierszem: gdy sprint znów zgadza się z Flow albo się zamyka, albo gdy wraca zespół, którego brakowało, jego potwierdzenie jest usuwane przy najbliższym odświeżeniu połączenia albo przy najbliższym potwierdzeniu w tym zespole; gdy sprint znika z dokumentu Flow, przy najbliższym odświeżeniu. Dzięki temu różnica, która wraca, jest znów otwarta. Zespół, którego brakuje we Flow, zachowuje potwierdzenia swoich sprintów, tak samo przy dokumencie, który Flow uciął. Sprint doprowadzony do zgodności i z powrotem do tych samych wartości samymi zmianami w planie (import przepustowości, edycja okresu), bez odświeżenia połączenia i bez potwierdzenia w tym zespole w międzyczasie, nadal wygląda na potwierdzony. Usunięcie połączenia usuwa jego potwierdzenia.
- Jira, elementy, które zniknęły: Astrolabe czyta teraz każdy zniknięty element raz, po jego identyfikatorze, i rozróżnia przypadki: „Usunięty w Jirze (albo konto połączenia już go nie widzi)” albo „Konto połączenia już go nie widzi”; element, który Jira nadal zwraca (wyszedł poza projekty połączenia), zachowuje szerszy opis, tak samo jak element jeszcze nieodczytany. Odczyt, który się nie powiódł, został przerwany albo nie zmieścił się w jednym odświeżeniu (100 na odświeżenie), jest powtarzany przy kolejnych odświeżeniach, dopóki Jira nie odpowie. Elementy oznaczone jako zniknięte już przed tą wersją też są klasyfikowane, a potwierdzone odchylenie „zniknął”, którego przyczyna się zmienia, otwiera się jeden raz.
- Import z Jiry ze strony Planu: osoba odpowiedzialna za strumień prac uruchamia go z menu strumienia. Połączenie wybiera się w oknie, gdy jest ich kilka, a strumień prac jest już ustawiony.
- Osie czasu: kamień milowy, którego daty obejmują tylko weekendy lub święta, jest oznaczony „Nie obejmuje żadnego dnia roboczego: tylko weekendy lub święta” na stronach projektu i zespołu.
- Bazy odniesienia: po wybraniu bazy odniesienia roadmapa i strona programów wymieniają także projekty usunięte od tamtej pory, przygaszone i oznaczone „(usunięty)”, z ich zamrożonym przedziałem.
- Bezpieczeństwo: wywołania, które serwer wysyła do Jiry i Flow, odrzucają też przestarzały zakres adresów IPv6 zgodnych z IPv4.
- Niczego nie zapisujemy w Jirze ani we Flow.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.9.0",
    date: "2026-11-10",
    en: `**Astrolabe 1.9.0: acknowledge a capacity difference from Flow, and a Flow capacity flag on the team page.**

- Acknowledge a sprint: on Deviations, Capacity from Flow, and in the Flow section of the team page, each line has an Acknowledge button for the team's manager or an administrator. It means "known, leave it". A line stays acknowledged until that sprint's figures change (its dates, the days it holds, either figure, the gap or the severity); then it reads "changed since" and is open again. Closing sprints reopen nothing, new sprints arrive open, and a rename in Flow changes nothing. Sprints without capacity in the plan are acknowledged one by one, and a team that is no longer in Flow is acknowledged as the team's own row, from the Deviations page or the team page.
- The Status filter on Deviations now covers Capacity from Flow as well: Open (the default), Acknowledged or All. The totals say "N acknowledged", and the severity badge of an acknowledged line is dimmed. On the team page, "Capacity vs Flow" counts the open differences and adds "· N acknowledged"; with only acknowledged ones it reads "No open difference · N acknowledged", never "In line with Flow", because the figures still differ.
- The team page's header shows one flag, "Capacity differs from Flow: N open differences", in the worst severity among them. The weeks strip marks the weeks of the sprints in dispute with a corner mark (a triangle for a warning, a ring for an info), and the Weekly load table says "Differs from Flow" on those weeks. Only open differences flag: acknowledging one silences it. The marks follow the current plan, so a proposal preview's strip shows none. The roadmap and the programs page carry no such flag.
- Nothing moves by itself and nothing is written to Flow. Every signed-in user sees the acknowledgements; only the team's manager or an administrator can acknowledge or withdraw one.
- Proven against the built-in Flow stub; not yet compared with a real Flow.`,
    pl: `**Astrolabe 1.9.0: potwierdzanie różnic przepustowości względem Flow i znacznik przepustowości z Flow na stronie zespołu.**

- Potwierdzanie sprintu: w Odchyleniach, w sekcji „Przepustowość z Flow”, i w sekcji Flow na stronie zespołu każdy wiersz ma przycisk „Potwierdź” dla kierownika/czki zespołu albo administratora/ki. Znaczy on: „wiem o tym, zostaw”. Wiersz pozostaje potwierdzony, dopóki nie zmienią się wartości tego sprintu (jego daty, liczba dni, które obejmuje, którakolwiek z wartości, różnica albo ważność); wtedy pokazuje „zmieniono od tego czasu” i jest znów otwarty. Zamykające się sprinty niczego nie otwierają na nowo, nowe sprinty pojawiają się jako otwarte, a zmiana nazwy we Flow niczego nie zmienia. Sprinty bez przepustowości w planie potwierdza się po jednym, a zespół, którego nie ma już we Flow, potwierdza się jako wiersz samego zespołu, na stronie Odchyleń albo na stronie zespołu.
- Filtr Stan w Odchyleniach obejmuje teraz także „Przepustowość z Flow”: Otwarte (domyślnie), Potwierdzone albo Wszystkie. Sumy podają „N potwierdzonych”, a oznaczenie ważności potwierdzonego wiersza jest przygaszone. Na stronie zespołu „Przepustowość a Flow” liczy otwarte różnice i dodaje „· N potwierdzonych”; gdy są tylko potwierdzone, pokazuje „Brak otwartych różnic · N potwierdzonych”, a nigdy „Zgodnie z Flow”, bo wartości nadal się różnią.
- Nagłówek strony zespołu pokazuje jeden znacznik, „Przepustowość różni się od Flow: N otwartych różnic”, w najwyższej ważności spośród nich. Oś tygodni oznacza tygodnie sprintów, w których jest różnica, znacznikiem w rogu (trójkąt dla ostrzeżenia, kółko dla informacji), a tabela Obciążenie tygodniowe pisze „Różni się od Flow” przy tych tygodniach. Znaczniki pojawiają się tylko dla otwartych różnic: potwierdzenie ją wycisza. Znaczniki odpowiadają bieżącemu planowi, więc oś w podglądzie propozycji ich nie pokazuje. Roadmapa i strona programów nie mają takiego znacznika.
- Nic nie przesuwa się samo i niczego nie zapisujemy we Flow. Potwierdzenia widzi każda zalogowana osoba; potwierdzić albo wycofać potwierdzenie może tylko kierownik/czka zespołu albo administrator/ka.
- Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.`,
  },
  {
    version: "1.8.0",
    date: "2026-11-10",
    en: `**Astrolabe 1.8.0: schedule proposals across several teams, and warnings that follow the moves you tick.**

- A new page, Schedule proposals, under Planning: pick the teams you want to plan together (a team's manager sees the teams they manage, an administrator sees every team) and press "Propose". Astrolabe places the teams in dependency order, each one around the dates of the teams placed before it, and repeats until the dates stop changing. Nothing is saved until you accept.
- One section per team, in the order the teams were placed ("placed 2 of 3"), each with the same table as the team page: current and proposed dates, the change, the link warnings, the milestones that could not be placed and the pinned ones that stay. A line above the sections says how many rounds it took: "Placed in 2 passes · settled". "Not settled" means the teams depend on each other in a loop, so every pass moved something again; the dates shown are the last pass's, so check the link warnings before you accept.
- Under each section, "Proposed load" shows the team's load per week after the moves you ticked. It only warns; nothing moves by itself.
- One accept across teams: tick the moves you want in any of the sections and press "Accept selected across teams". All the ticked moves are saved in one step. You must manage every team in the proposal (or be an administrator). If the plan of those teams changed since the proposal, Astrolabe shows a fresh proposal and keeps your ticks for the milestones that still move; a milestone someone else rescheduled in the meantime is skipped and the rest are saved, with the skipped ones listed.
- On the team page, after "Propose schedule": the link warnings (the red "would violate" badges and the Conflict badge) and the proposed weekly load now follow the moves you tick. Untick a move and the warnings and the load describe the plan without it, instead of the plan with every move accepted. With every move ticked, nothing changes.`,
    pl: `**Astrolabe 1.8.0: propozycje harmonogramu dla kilku zespołów naraz i ostrzeżenia, które uwzględniają zaznaczone zmiany.**

- Nowa strona, Propozycje harmonogramu, w sekcji Planowanie: wybierz zespoły, które chcesz planować razem (kierownik/czka zespołu widzi zespoły, którymi zarządza, administrator/ka widzi wszystkie), i naciśnij „Zaproponuj”. Astrolabe układa zespoły w kolejności zależności, każdy wokół terminów zespołów ułożonych wcześniej, i powtarza to, aż terminy przestaną się zmieniać. Nic nie zostanie zapisane, dopóki nie zaakceptujesz propozycji.
- Jedna sekcja na zespół, w kolejności, w jakiej zespoły ułożono („kolejność układania: 2 z 3”), z taką samą tabelą jak na stronie zespołu: obecne i proponowane terminy, zmiana, ostrzeżenia o zależnościach, kamienie milowe, których nie udało się umieścić, i przypięte, które zostają na miejscu. Wiersz nad sekcjami podaje, ile przebiegów to zajęło: „Ułożono w 2 przebiegach · terminy się ustabilizowały”. „Terminy nie ustabilizowały się” oznacza, że zespoły zależą od siebie nawzajem w pętli, więc każdy przebieg znów coś przesunął; pokazane terminy pochodzą z ostatniego przebiegu, więc przed zaakceptowaniem sprawdź ostrzeżenia o zależnościach.
- Pod każdą sekcją „Proponowane obciążenie” pokazuje obciążenie zespołu w kolejnych tygodniach po zaznaczonych zmianach. Tylko ostrzega; nic nie przesuwa się samo.
- Jedna akceptacja dla wszystkich zespołów: zaznacz zmiany w dowolnych sekcjach i naciśnij „Zaakceptuj zaznaczone we wszystkich zespołach”. Wszystkie zaznaczone zmiany zapisujemy jednym krokiem. Musisz zarządzać każdym zespołem z propozycji (albo być administratorem/ką). Jeśli plan tych zespołów zmienił się od czasu propozycji, Astrolabe pokazuje nową propozycję i zachowuje Twoje zaznaczenia dla kamieni milowych, które nadal się przesuwają; kamień milowy, którego termin ktoś inny zmienił w międzyczasie, pomijamy, a resztę zapisujemy i wymieniamy pominięte.
- Na stronie zespołu, po „Zaproponuj harmonogram”: ostrzeżenia o zależnościach (czerwone oznaczenia „byłaby niedotrzymana” i oznaczenie „Konflikt”) oraz proponowane obciążenie tygodniowe uwzględniają teraz zaznaczone zmiany. Odznacz zmianę, a ostrzeżenia i obciążenie opiszą plan bez niej, a nie plan ze wszystkimi zmianami zaakceptowanymi. Gdy zaznaczone są wszystkie zmiany, nic się nie zmienia.`,
  },
  {
    version: "1.7.0",
    date: "2026-11-09",
    en: `**Astrolabe 1.7.0: the critical path on more pages, pinned dates and two baselines compared.**

- The critical path on the team page: turn on "Critical path" in the team's toolbar to outline the milestones and dependencies on the chain that drives the end of each milestone's own project, and to get a Slack column. The toggle is the same one as on the project page, so one choice is remembered for both. Slack is measured toward the end of the milestone's own project, so both pages say the same about the same milestone. A dependency is marked only when it lies on the chain of a project this team works on.
- The critical path on the roadmap: pick "Critical path to…" in the toolbar, or "Show critical path to this project" in a project's row menu. The roadmap emphasises that project, the projects upstream of it that drive its end and the arrows between them, and a "Critical path to …" panel under the timeline lists them with their dates and slack, filtered-out projects included. Nothing moves; it is computed from the planned dates.
- A Slack column for every dependency: with "Critical path" on, the project page's Dependencies table shows how many working days each link could slip before it is violated, or by how many working days it is already violated.
- Pin dates: a team's manager or an administrator can pin a scheduled milestone's dates from its row menu ("Pin dates", "Unpin dates"), and everyone sees the pin on the bar. Propose schedule keeps a pinned milestone where it is, books its load, plans the others around it and counts it in the summary ("N pinned"). A pin does not lock anything: dragging the bar or the schedule dialog still moves the milestone, and it stays pinned. Moving a milestone back to Unscheduled removes its pin.
- Two baselines compared: on a baseline's page, "Compare against" now offers any other baseline as well as the live plan. The page then lists only the rows that changed between the two, in working days, and names both sides. The overlay on the timelines still compares one baseline with the live plan.
- Rank movement: with a baseline picked, the roadmap reads "5 (was 3)" in the rank column of a project that moved, and the totals line counts the projects that moved up, moved down, were newly ranked or lost their rank. The comparison page says "Rank 3 → 5" on the project's row.`,
    pl: `**Astrolabe 1.7.0: ścieżka krytyczna na kolejnych stronach, przypięte terminy i porównanie dwóch baz odniesienia.**

- Ścieżka krytyczna na stronie zespołu: włącz „Ścieżka krytyczna” na pasku zespołu, aby obrysować kamienie milowe i zależności leżące na łańcuchu wyznaczającym koniec własnego projektu każdego kamienia milowego, i aby zobaczyć kolumnę Luz. Przełącznik jest ten sam co na stronie projektu, więc jeden wybór jest zapamiętany dla obu stron. Luz liczymy względem końca własnego projektu kamienia milowego, więc obie strony mówią to samo o tym samym kamieniu milowym. Zależność jest oznaczona tylko wtedy, gdy leży na łańcuchu projektu, nad którym pracuje ten zespół.
- Ścieżka krytyczna na Roadmapie: wybierz „Ścieżka krytyczna do…” na pasku narzędzi albo „Pokaż ścieżkę krytyczną do tego projektu” w menu wiersza projektu. Roadmapa wyróżnia ten projekt, projekty przed nim, które wyznaczają jego koniec, i strzałki między nimi, a panel „Ścieżka krytyczna do projektu …” pod osią czasu wymienia je z datami i luzem, także projekty ukryte filtrami. Nic się nie przesuwa; liczymy z planowanych dat.
- Luz dla każdej zależności: przy włączonej „Ścieżce krytycznej” tabela Zależności na stronie projektu pokazuje, o ile dni roboczych każde powiązanie może się przesunąć, zanim zostanie naruszone, albo o ile dni roboczych jest już naruszone.
- Przypinanie terminów: kierownik/czka zespołu lub administrator/ka może przypiąć terminy zaplanowanego kamienia milowego z menu jego wiersza („Przypnij terminy”, „Odepnij terminy”), a przypięcie widzi każda osoba na pasku. „Zaproponuj harmonogram” zostawia przypięty kamień milowy tam, gdzie jest, uwzględnia jego obciążenie, układa pozostałe wokół niego i liczy go w podsumowaniu („przypięte: N”). Przypięcie niczego nie blokuje: przeciągnięcie paska lub okno harmonogramu nadal przesuwa kamień milowy, a on pozostaje przypięty. Przeniesienie kamienia milowego z powrotem do niezaplanowanych zdejmuje przypięcie.
- Porównanie dwóch baz odniesienia: na stronie bazy odniesienia „Porównaj z” oferuje teraz także każdą inną bazę odniesienia, nie tylko aktualny plan. Strona wymienia wtedy tylko wiersze, które zmieniły się między nimi, w dniach roboczych, i nazywa obie strony. Nakładka na osiach czasu nadal porównuje jedną bazę odniesienia z aktualnym planem.
- Zmiana pozycji w rankingu: gdy wybrana jest baza odniesienia, Roadmapa pokazuje „5 (było 3)” w kolumnie rankingu projektu, który zmienił pozycję, a wiersz podsumowania liczy projekty, które awansowały, spadły, trafiły do rankingu lub z niego wypadły. Strona porównania podaje w wierszu projektu „Pozycja w rankingu: 3 → 5”.`,
  },
  {
    version: "1.6.0",
    date: "2026-11-08",
    en: `**Astrolabe 1.6.0: capacity compared with Flow.**

- Deviations, Capacity from Flow: for every team linked to a Flow team, Astrolabe compares the plan's capacity with Flow's, sprint by sprint, for the current and future sprints. The plan having 0.5 man-days or more above Flow is a warning, below Flow an info. Sprints with no capacity in the plan are listed too, folded into one line per team, and a linked Flow team that is no longer in Flow is a warning.
- The comparison counts the same days and figures as Import capacity…, so after an import a team reads "In line with Flow". The team page's Flow section shows the same comparison under "Capacity vs Flow".
- Import capacity… shows what an import would change. It never changes a hand-entered period, and a sprint where Flow has 0 must be ticked by hand.
- A team imported with 1.5.0 may show differences until it is imported again; the preview offers the update.
- Closed sprints and sprints longer than 60 days are not compared. When a Flow connection is disabled or its last read failed, its lines are marked stale and "in line" is not claimed.
- Nothing is stored and nothing is written to Flow. Every signed-in user can read the comparison, including Flow's per-sprint figures.
- Proven against the built-in Flow stub, and checked on a copy of a real Flow 1.57.1's data: every difference listed matched the import preview, and no import was applied. The Jira sync, import and deviations are still proven against the built-in stub only.`,
    pl: `**Astrolabe 1.6.0: przepustowość porównana z Flow.**

- Odchylenia, „Przepustowość z Flow”: dla każdego zespołu powiązanego z zespołem Flow Astrolabe porównuje przepustowość z planu z przepustowością z Flow, sprint po sprincie, dla sprintów bieżących i przyszłych. Jeśli w planie jest o 0,5 osobodnia lub więcej niż we Flow, to ostrzeżenie; jeśli mniej niż we Flow, to informacja. Sprinty bez przepustowości w planie też są wymienione, zwinięte w jeden wiersz na zespół, a powiązany zespół Flow, którego nie ma już we Flow, to ostrzeżenie.
- Porównanie liczy te same dni i wartości co „Importuj przepustowość…”, więc po imporcie zespół pokazuje „Zgodnie z Flow”. Sekcja Flow na stronie zespołu pokazuje to samo porównanie pod nazwą „Przepustowość a Flow”.
- „Importuj przepustowość…” pokazuje, co zmieniłby import. Nigdy nie zmienia okresu wpisanego ręcznie, a sprint, w którym Flow podaje 0, trzeba zaznaczyć ręcznie.
- Zespół zaimportowany w wersji 1.5.0 może pokazywać różnice do czasu ponownego importu; podgląd proponuje aktualizację.
- Sprintów zamkniętych i dłuższych niż 60 dni nie porównujemy. Gdy połączenie z Flow jest wyłączone albo jego ostatni odczyt się nie powiódł, jego wiersze są oznaczone jako nieaktualne i nie twierdzimy, że plan jest zgodny.
- Niczego nie przechowujemy i niczego nie zapisujemy we Flow. Każda zalogowana osoba może zobaczyć porównanie, także wartości Flow dla poszczególnych sprintów.
- Sprawdzone na wbudowanej atrapie Flow oraz na kopii danych prawdziwego Flow 1.57.1: każda wymieniona różnica zgadzała się z podglądem importu, a żadnego importu nie zastosowaliśmy. Synchronizacja, import i odchylenia z Jiry są nadal sprawdzone wyłącznie na wbudowanej atrapie.`,
  },
  {
    version: "1.5.1",
    date: "2026-11-08",
    en: `**Astrolabe 1.5.1: fixes from the first real Jira and Flow connections.**

- Jira connections in development: with the built-in Jira stub switched on, every Jira site was answered by the stub, real ones too, so a real site's Test connection failed or showed the stub's data. Now only a site whose name starts with "stub-" (such as stub-sample.atlassian.net) goes to the stub, and every other site reaches Atlassian. A connection answered by the stub carries a "Development stub" badge, on its page and in the Test connection result.
- After the upgrade, a development connection to sample.atlassian.net reaches the real Atlassian and keeps doing so until you delete it. Test again any connection that the stub used to answer.
- Flow connections: a refused base URL now says why. Either it is not written as the bare origin (lowercase, no path, no default port), or it is not one of the origins this server allows. New connection lists the allowed origins. A Flow running in its own compose stack is reached with the new docker-compose.real-flow.yaml: the base URL names the host flow-app on port 8084.
- Importing capacity counts the days Flow counts. A sprint ends on its planned end, and a completion counts only when there is no planned end. A day shared by two sprints belongs to the earlier one, and a sprint wholly inside another counts no day. Flow's team-default figure is a total for the whole sprint and is spread over all of its working days.
- A sprint longer than 60 days (usually a wrong date in Jira) counts only the days no other sprint holds, as in Flow 1.57.1, and is not selected by default.
- A sprint the import cannot take keeps its imported period. Removing a period without importing its sprint's new row leaves the earlier sprint's figure in force.
- Connecting and Test connection are verified against a real Jira Cloud site and a real Flow 1.57.1. The capacity preview was compared with the real Flow's figures, but no import was applied there. The Jira sync, import and deviations are still proven against the built-in stub only.`,
    pl: `**Astrolabe 1.5.1: poprawki po pierwszych połączeniach z prawdziwymi Jirą i Flow.**

- Połączenia z Jirą w środowisku deweloperskim: przy włączonej wbudowanej atrapie Jiry atrapa odpowiadała za każdą witrynę Jiry, także prawdziwą, więc „Przetestuj połączenie” dla prawdziwej witryny kończyło się błędem albo pokazywało dane atrapy. Teraz do atrapy trafia tylko witryna, której nazwa zaczyna się od „stub-” (na przykład stub-sample.atlassian.net), a każda inna łączy się z Atlassianem. Połączenie obsługiwane przez atrapę ma oznaczenie „Atrapa deweloperska” na swojej stronie i w wyniku testu połączenia.
- Po aktualizacji deweloperskie połączenie z sample.atlassian.net łączy się z prawdziwym Atlassianem i robi to, dopóki go nie usuniesz. Przetestuj ponownie każde połączenie, za które wcześniej odpowiadała atrapa.
- Połączenia z Flow: odrzucony adres bazowy mówi teraz dlaczego. Albo nie jest zapisany jako samo źródło (małymi literami, bez ścieżki i bez domyślnego portu), albo nie jest jednym ze źródeł dozwolonych na tym serwerze. Okno „Nowe połączenie” pokazuje dozwolone źródła. Z Flow działającym we własnym stosie compose łączysz się przez nowy plik docker-compose.real-flow.yaml: adres bazowy wskazuje hosta flow-app na porcie 8084.
- Import przepustowości liczy te same dni co Flow. Sprint kończy się w planowanym dniu końca, a data zakończenia liczy się tylko wtedy, gdy planowanego końca nie ma. Dzień wspólny dla dwóch sprintów należy do wcześniejszego, a sprint w całości zawarty w innym nie liczy żadnego dnia. Wartość domyślna zespołu z Flow to suma na cały sprint i rozkładamy ją na wszystkie jego dni robocze.
- Sprint dłuższy niż 60 dni (zwykle przez błędną datę w Jirze) liczy tylko dni, których nie zajmuje żaden inny sprint, tak jak we Flow 1.57.1, i nie jest domyślnie zaznaczony.
- Sprint, którego import nie może przyjąć, zachowuje swój zaimportowany okres. Usunięcie okresu bez zaimportowania nowego wiersza jego sprintu pozostawia w tych dniach wartość wcześniejszego sprintu.
- Łączenie i test połączenia sprawdziliśmy na prawdziwej witrynie Jira Cloud i na prawdziwym Flow 1.57.1. Podgląd przepustowości porównaliśmy z wartościami prawdziwego Flow, ale żadnego importu tam nie zastosowaliśmy. Synchronizacja, import i odchylenia z Jiry są nadal sprawdzone wyłącznie na wbudowanej atrapie.`,
  },
  {
    version: "1.5.0",
    date: "2026-11-08",
    en: `**Astrolabe 1.5.0: teams and capacity from Flow.**

- Flow connections: under Administration, Flow, administrators add a connection to a Flow instance with a Flow service token. The token is stored encrypted and never shown again. Test connection checks the token and the data, Refresh now reads Flow, and the connection is then read on its own every hour (5 minutes to once a day, or manual only). Astrolabe only reads from Flow; nothing is ever written to it.
- Linking teams: the team's manager or an administrator links an Astrolabe team to its Flow team from the team page. The Flow team with the same name is suggested, and on the connection page administrators can link every suggested team at once.
- Roster: a linked team's page shows who is in the Flow team now and who was before, with the dates. It is information only: Astrolabe has no roster of its own yet.
- Importing capacity: "Import capacity…" on a linked team's page previews Flow's sprints first. A sprint's man-days are spread over its working days (weekends and public holidays excluded), so the weekly capacity adds up to what Flow says. You tick the sprints to import, and each one becomes a capacity period marked "Flow". Importing again updates those periods when Flow changed, and offers to remove those whose sprint is gone, only if you tick them.
- A hand-entered period is never changed or removed by an import. A sprint that starts on the date of a hand-entered period is left out and says so, and editing an imported period yourself makes it hand-entered for good.
- If Flow revokes the token or it expires, the connection's runs fail with "Flow rejected the token: it was revoked or expired - issue a new one in Flow and update the connection". Saving the new token makes a polling connection read Flow again at once.
- Proven against a built-in Flow stub only; not yet tested against a real Flow.`,
    pl: `**Astrolabe 1.5.0: zespoły i przepustowość z Flow.**

- Połączenia z Flow: w sekcji Administracja, na stronie Flow, administratorzy/rki dodają połączenie z instancją Flow za pomocą tokenu usługi Flow. Token zapisujemy zaszyfrowany i nigdy więcej go nie pokazujemy. „Przetestuj połączenie” sprawdza token i dane, „Odśwież teraz” czyta Flow, a potem połączenie jest odczytywane samo co godzinę (od 5 minut do doby albo tylko ręcznie). Astrolabe tylko czyta z Flow; niczego tam nie zapisuje.
- Powiązanie zespołów: kierownik/czka zespołu lub administrator/ka wiąże zespół Astrolabe z jego zespołem we Flow na stronie zespołu. Proponowany jest zespół Flow o tej samej nazwie, a na stronie połączenia administratorzy/rki mogą powiązać wszystkie proponowane zespoły naraz.
- Skład: strona powiązanego zespołu pokazuje, kto jest teraz w zespole Flow, a kto był wcześniej, wraz z datami. To tylko informacja: Astrolabe nie ma jeszcze własnego składu zespołu.
- Import przepustowości: „Importuj przepustowość…” na stronie powiązanego zespołu najpierw pokazuje podgląd sprintów z Flow. Osobodni sprintu rozkładamy na jego dni robocze (bez weekendów i świąt państwowych), więc przepustowość tygodniowa sumuje się do wartości z Flow. Zaznaczasz sprinty do zaimportowania, a każdy staje się okresem przepustowości z oznaczeniem „Flow”. Ponowny import aktualizuje te okresy, gdy Flow się zmieni, i proponuje usunięcie tych, których sprintu już nie ma, ale tylko jeśli je zaznaczysz.
- Okres wpisany ręcznie nigdy nie jest zmieniany ani usuwany przez import. Sprint zaczynający się w dniu okresu wpisanego ręcznie jest pomijany z wyjaśnieniem, a własna edycja zaimportowanego okresu na stałe czyni go okresem wpisanym ręcznie.
- Jeśli Flow unieważni token albo token wygaśnie, przebiegi połączenia kończą się błędem „Flow odrzucił token: został unieważniony albo wygasł - wystaw nowy w Flow i zaktualizuj połączenie”. Zapisanie nowego tokenu sprawia, że połączenie odpytywane automatycznie od razu znów czyta Flow.
- Sprawdzone wyłącznie na wbudowanej atrapie Flow; jeszcze nie przetestowane na prawdziwym Flow.`,
  },
  {
    version: "1.4.1",
    date: "2026-11-07",
    en: `**Astrolabe 1.4.1: clearer connection tests and spread-out retries.**

- Test connection: when the Jira site cannot be reached, only the first check fails. The checks that could not run after it now read "Skipped" in gray, instead of five more failures, and the result counts only the real failures.
- Retries after a failed poll: a connection's next attempt is now spread by up to half its polling interval (an hour at most), so connections that failed together (for example while Jira was down) no longer all retry at the same moment. The next poll time shown for the connection includes this.
- A connection whose Jira data can never be fully read (an item the sync cannot store, or child issues that always fail to load) no longer forces a full read on every poll: after three such polls in a row it falls back to one full read a day and logs a warning for administrators.
- Nothing is written to Jira: corrections are made in Astrolabe.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.4.1: czytelniejsze testy połączenia i rozłożone ponowne próby.**

- Przetestuj połączenie: gdy witryna Jira jest nieosiągalna, nie powodzi się tylko pierwsza sonda. Sondy, których po niej nie uruchomiono, mają teraz szary stan „Pominięty” zamiast pięciu kolejnych błędów, a wynik liczy tylko rzeczywiste niepowodzenia.
- Ponowne próby po nieudanym odpytaniu: następna próba połączenia jest teraz rozłożona o maksymalnie połowę jego odstępu odpytywania (najwyżej o godzinę), więc połączenia, które zawiodły razem (na przykład gdy Jira nie działała), nie ponawiają już wszystkie w tej samej chwili. Uwzględnia to czas następnego odpytania pokazywany przy połączeniu.
- Połączenie, którego danych z Jiry nigdy nie da się odczytać w całości (element, którego synchronizacja nie może zapisać, albo zgłoszenia podrzędne, których odczyt zawsze się nie udaje), nie wymusza już pełnego odczytu przy każdym odpytaniu: po trzech takich odpytaniach z rzędu przechodzi na jeden pełny odczyt na dobę i zapisuje ostrzeżenie dla administratorów/ek.
- Nic nie jest zapisywane do Jiry: korekty wprowadza się w Astrolabe.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.4.0",
    date: "2026-11-07",
    en: `**Astrolabe 1.4.0: coverage and roll-ups.**

- Jira items the plan misses: for a linked program or project, the Deviations page now lists the open Jira items under it that nothing in the plan is linked to (a warning, with their keys; finished Jira items are not listed). Acknowledge it once, and it reopens if another unplanned item appears.
- Plan items Jira does not track: the same rows list the linked program's projects and the linked project's milestones that are not linked to a Jira item (an info, with their names). Both lists show ten entries and "and N more" beyond that.
- Children done: when every child issue of a linked epic is done in Jira while the epic is still open and the plan's end is still ahead, the Deviations page says so (an info).
- Roll-up on milestone chips: a milestone linked to an epic shows "5/12 · 34 pt" after its Jira key and flags on the project and team pages and in the unscheduled tray: child issues done of all, and story points (left out when Jira has none). Its full sentence is the tooltip and the accessible name, and the Deviations page shows the same figure under the Jira item. No figure means the last read found no child issues for that epic.
- Where it comes from: the same polling and Refresh now as before, with no extra clicks. The first run after the upgrade is a full read plus the child issues. After that, changed stories arrive with each poll and the child list is re-read once a day, so a story deleted in Jira can still count in a roll-up for up to a day.
- Existing acknowledgements stay unless the item gains a coverage or children deviation, which reopens it.
- Nothing is written to Jira: corrections are made in Astrolabe.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.4.0: pokrycie i podsumowania.**

- Elementy Jiry, których brakuje w planie: dla powiązanego programu lub projektu strona Odchylenia wymienia teraz otwarte elementy Jiry pod nim, z którymi nic w planie nie jest powiązane (ostrzeżenie, z ich kluczami; zakończone elementy Jiry nie są wymieniane). Potwierdzasz je raz, a wracają, gdy pojawi się kolejny niezaplanowany element.
- Elementy planu, których Jira nie śledzi: te same wiersze wymieniają projekty powiązanego programu i kamienie milowe powiązanego projektu, które nie są powiązane z żadnym elementem Jiry (informacja, z ich nazwami). Obie listy pokazują dziesięć pozycji i „i jeszcze N” ponad to.
- Dzieci ukończone: gdy wszystkie zgłoszenia podrzędne powiązanego epiku są ukończone w Jirze, a epik jest nadal otwarty i koniec planu jest jeszcze przed nami, strona Odchylenia to zgłasza (informacja).
- Podsumowanie na kamieniach milowych: kamień milowy powiązany z epikiem pokazuje „5/12 · 34 pkt” po kluczu Jiry i flagach na stronach projektu i zespołu oraz na liście niezaplanowanych: ukończone zgłoszenia podrzędne ze wszystkich oraz punkty historii (pomijane, gdy Jira ich nie ma). Pełne zdanie jest podpowiedzią i nazwą dostępną, a strona Odchylenia pokazuje tę samą liczbę pod elementem Jiry. Brak liczby oznacza, że ostatni odczyt nie znalazł zgłoszeń podrzędnych tego epiku.
- Skąd to się bierze: z tego samego odpytywania i „Odśwież teraz” co dotąd, bez dodatkowych kliknięć. Pierwszy odczyt po aktualizacji jest pełny i obejmuje zgłoszenia podrzędne. Potem zmienione historie napływają z każdym odpytywaniem, a lista zgłoszeń podrzędnych jest czytana raz na dobę, więc historia usunięta w Jirze może jeszcze przez dobę wliczać się do podsumowania.
- Istniejące potwierdzenia pozostają, chyba że element zyska odchylenie pokrycia lub zgłoszeń podrzędnych, co ponownie go otwiera.
- Nic nie jest zapisywane do Jiry: korekty wprowadza się w Astrolabe.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.3.0",
    date: "2026-11-07",
    en: `**Astrolabe 1.3.0: polling, status, acknowledge and Jira markers.**

- Polling: each Jira connection is read by itself, every 15 minutes by default. Set another interval from 5 minutes to a day, or "Manual only", in the connection's Polling group; "Refresh now" keeps working either way. After a failed run the retries back off (one interval, then twice as long each time, up to six hours, never sooner than the interval). Any change to the connection (a new token, a mapping change, a new test) polls it at once. A connection that has not been tested yet is not polled, and neither is a disabled one. Connections that already exist start polling every 15 minutes after the upgrade; set them to Manual only to keep the old behaviour.
- Status: every connection shows one of Current, Stale (no successful run for three intervals), Failed (the latest run failed or was interrupted, with the failure count and its code), Never synced or Disabled, together with the last success and the next poll. You see it on the Jira list, the connection page, the Deviations page and, for administrators, in the new Sync section of the telemetry panel.
- Acknowledge until changed: on the Deviations page, owners and administrators acknowledge a linked item's deviations once. The item leaves the open list and stops raising flags until anything on either side changes a deviation, which reopens it as "changed since". The new Status filter shows Open (the default), Acknowledged or All, and Unacknowledge withdraws it.
- Jira flags: the roadmap, programs, project and team pages now flag the deviations of linked projects and milestones, with the same warning and info icons and counts as the other flags. The roadmap's flag panel names the Jira item and the difference; programs and work streams add up their projects' flags; a project whose milestones deviate also gets one "N milestones deviate from Jira" flag. Acknowledged items, items of a disabled connection and estimates that cannot be compared raise no flag. The project and team pages get a Flags column with the Jira key as a link.
- Jira dates bar: a linked row draws the dates Jira holds as a dashed outline along the top of its row. The "Jira dates" toggle in the timeline toolbar hides it, and your choice is remembered in the browser. Jira dates far outside the plan's own dates never stretch the timeline.
- Nothing is written to Jira: corrections are made in Astrolabe.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.3.0: odpytywanie, status, potwierdzanie i znaczniki Jiry.**

- Odpytywanie: każde połączenie z Jirą jest odczytywane samo, domyślnie co 15 minut. W grupie Odpytywanie połączenia ustawisz inny odstęp, od 5 minut do doby, albo „Tylko ręcznie”; „Odśwież teraz” działa w obu przypadkach. Po nieudanym odczycie ponowne próby są odsuwane (najpierw o jeden odstęp, potem każdorazowo dwa razy dłużej, do sześciu godzin, nigdy wcześniej niż po jednym odstępie). Każda zmiana połączenia (nowy token, zmiana mapowania, nowy test) powoduje natychmiastowy odczyt. Połączenie, którego jeszcze nie przetestowano, nie jest odpytywane, podobnie jak wyłączone. Istniejące połączenia po aktualizacji zaczynają być odpytywane co 15 minut; aby zachować dotychczasowe działanie, ustaw w nich „Tylko ręcznie”.
- Stan: każde połączenie ma jeden ze stanów: Aktualne, Nieaktualne (brak udanego odczytu przez trzy odstępy), Błąd (ostatni odczyt się nie powiódł albo został przerwany, z liczbą niepowodzeń i kodem), Nie synchronizowano lub Wyłączone, a obok ostatni sukces i następny odczyt. Zobaczysz go na liście Jiry, na stronie połączenia, na stronie Odchylenia, a administratorzy/rki także w nowej sekcji Synchronizacja panelu telemetrii.
- Potwierdzanie do zmiany: na stronie Odchylenia właściciele/ki i administratorzy/rki potwierdzają odchylenia powiązanego elementu jednorazowo. Element znika z listy otwartych i przestaje wywoływać flagi, dopóki jakakolwiek zmiana po którejkolwiek stronie nie zmieni odchylenia; wtedy wraca jako „zmieniono od tego czasu”. Nowy filtr Stan pokazuje Otwarte (domyślnie), Potwierdzone lub Wszystkie, a „Cofnij potwierdzenie” je wycofuje.
- Flagi Jiry: strony Roadmapa, Programy, projektu i zespołu flagują teraz odchylenia powiązanych projektów i kamieni milowych, z tymi samymi ikonami ostrzeżeń i informacji oraz licznikami co pozostałe flagi. Panel flag roadmapy wskazuje element Jiry i różnicę; programy i strumienie pracy sumują flagi swoich projektów; projekt, którego kamienie milowe odbiegają, dostaje też jedną flagę „N kamieni milowych odbiega od Jiry”. Elementy potwierdzone, elementy wyłączonego połączenia i estymaty, których nie da się porównać, nie wywołują flag. Strony projektu i zespołu mają kolumnę Flagi z kluczem Jiry jako odnośnikiem.
- Pasek dat z Jiry: powiązany wiersz rysuje daty, które zna Jira, jako przerywany obrys wzdłuż góry wiersza. Przełącznik „Daty z Jiry” na pasku narzędzi osi czasu go ukrywa, a Twój wybór jest zapamiętywany w przeglądarce. Daty z Jiry daleko poza datami planu nigdy nie rozciągają osi czasu.
- Nic nie jest zapisywane do Jiry: korekty wprowadza się w Astrolabe.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.2.1",
    date: "2026-11-07",
    en: `**Astrolabe 1.2.1: a keyboard fix.**

- Closing a delete dialog with Escape (or Cancel) gives the focus back to the row's menu button that opened it in one more case: when the dialog takes a moment longer to leave the page.
- Under the hood: Java 21.0.13 and updated libraries, among them a Netty release with security fixes.`,
    pl: `**Astrolabe 1.2.1: poprawka obsługi klawiatury.**

- Zamknięcie okna usuwania klawiszem Escape (lub przyciskiem Anuluj) oddaje fokus przyciskowi menu wiersza, który je otworzył, w jeszcze jednym przypadku: gdy okno znika ze strony nieco dłużej.
- Pod spodem: Java 21.0.13 i zaktualizowane biblioteki, w tym wydanie Netty z poprawkami bezpieczeństwa.`,
  },
  {
    version: "1.2.0",
    date: "2026-11-07",
    en: `**Astrolabe 1.2.0: import from Jira.**

- Import: on a Jira connection's page, an administrator presses "Import from Jira…", picks the work stream, the owner, an optional default team, program and project, and which of the connection's Jira projects to read. Only administrators have the button for now (the API already allows plan owners onto their own items).
- Preview first: every Jira item is listed as created, linked to an existing plan item, or skipped, with the reason. Nothing is written to Jira, and nothing reaches the plan until you press Import. You tick what to import; Import is disabled while the scope has more than 2,000 items, so narrow the Jira projects.
- Apply: the ticked items become programs, projects and milestones under the chosen work stream, each linked to its Jira item, in one change to the plan.
- Never overwrites: an existing plan item is never changed, and an item that is already linked is skipped, so importing again never duplicates what is already linked; items you left out, or whose plan item was deleted since, are offered again.
- Matching is by name, ignoring case, among the items under the same parent (names are cut at 100 characters; accents count). An unlinked plan item with that name is linked instead of duplicated; one that is already linked, or a program name used in another work stream, makes the item skip. An item that was renamed in Jira does not match its plan item and shows up as a new one, so read the preview before you import.
- Parents: an item goes under the plan item linked to its direct Jira parent, inside the chosen work stream. If it has no such parent, it goes under the default program or project you picked, or is skipped; if its parent is itself skipped, so is it. This includes an item whose parent sits on a Jira level you did not map.
- Dates: with "Copy Jira's dates" on (it is by default), a milestone gets Jira's dates when you manage its team (an administrator: any team) and Jira holds valid dates that contain a working day; otherwise it is created without dates, with a note. Estimates are converted only when the mapping's unit is days or it gives man-days per unit; otherwise the milestone gets 0 man-days and a note. A milestone's team is the one named like Jira's Team, else your default team, else the item is skipped.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.2.0: import z Jiry.**

- Import: na stronie połączenia z Jirą administrator/ka naciska „Importuj z Jiry…”, wybiera strumień pracy, właściciela/kę, opcjonalnie domyślny zespół, program i projekt oraz to, które projekty Jiry połączenia mają zostać odczytane. Na razie przycisk mają tylko administratorzy/rki (API pozwala już właścicielom/kom planu importować na własne elementy).
- Najpierw podgląd: każdy element Jiry jest wymieniony jako utworzony, powiązany z istniejącym elementem planu albo pominięty, wraz z powodem. Nic nie jest zapisywane w Jirze i nic nie trafia do planu, dopóki nie naciśniesz „Importuj”. Zaznaczasz, co zaimportować; Import jest wyłączony, gdy zakres ma ponad 2000 elementów, więc zawęź projekty Jiry.
- Zapis: zaznaczone elementy stają się programami, projektami i kamieniami milowymi w wybranym strumieniu pracy, każdy powiązany ze swoim elementem Jiry, w jednej zmianie planu.
- Bez nadpisywania: istniejący element planu nigdy nie jest zmieniany, a element już powiązany jest pomijany, więc ponowny import nie duplikuje tego, co już powiązano; elementy pominięte lub takie, których element planu usunięto, są proponowane ponownie.
- Dopasowanie następuje po nazwie, bez względu na wielkość liter, wśród elementów pod tym samym rodzicem (nazwy są obcinane do 100 znaków; znaki diakrytyczne się liczą). Niepowiązany element planu o takiej nazwie zostaje powiązany zamiast zduplikowany; element już powiązany albo nazwa programu użyta w innym strumieniu pracy powoduje pominięcie. Element, którego nazwę zmieniono w Jirze, nie pasuje do swojego elementu planu i pojawia się jako nowy, więc przeczytaj podgląd przed importem.
- Rodzice: element trafia pod element planu powiązany z jego bezpośrednim rodzicem w Jirze, w wybranym strumieniu pracy. Jeśli takiego rodzica nie ma, trafia pod domyślny program lub projekt, który wybrano, albo jest pomijany; jeśli jego rodzic jest pominięty, on również. Dotyczy to także elementu, którego rodzic leży na poziomie Jiry bez mapowania.
- Daty: przy włączonym „Kopiuj daty z Jiry” (domyślnie jest włączone) kamień milowy dostaje daty z Jiry, gdy zarządzasz jego zespołem (administrator/ka: dowolnym zespołem), a Jira ma poprawne daty zawierające dzień roboczy; w przeciwnym razie powstaje bez dat, z uwagą. Estymaty są przeliczane tylko wtedy, gdy jednostką są dni albo mapowanie podaje osobodni na jednostkę; w przeciwnym razie kamień milowy dostaje 0 osobodni i uwagę. Zespołem kamienia milowego jest ten o nazwie takiej jak zespół w Jirze, w razie braku zespół domyślny, a jeśli i jego nie ma, element jest pomijany.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.1.0",
    date: "2026-11-07",
    en: `**Astrolabe 1.1.0: Jira connection, links and deviations.**

- Connection: Administration, Jira holds the connections to your Jira Cloud site. The API token is stored encrypted and is never shown again. "Test connection" checks the site probe by probe (site lookup, account, issue types, search, fields, projects, one issue) and shows the scope each failed probe needs.
- Mapping: map the program, project and milestone levels to Jira hierarchy levels, and pick the start, end, estimate and Team fields. After the first Test connection the defaults are read from your site (Jira Plans' "Target start" and "Target end" first), and "Peek at an issue" shows how one issue reads through the mapping.
- Links: owners and administrators link a project or milestone to one Jira item, one to one, from the project page; an administrator links a program on the connection page.
- Refresh: an administrator presses "Refresh now" to read the linked items from Jira on demand.
- Deviations: the new Deviations page lists where the plan and Jira disagree (dates in working days, dates on one side only, names, parents, hierarchy levels, estimates, progress, items gone from Jira). The project and team pages show a chip with the link and its deviation count.
- Nothing is written back to Jira: corrections are made in Astrolabe.
- Proven against a built-in Jira stub; not yet tested against a real Jira site.`,
    pl: `**Astrolabe 1.1.0: połączenie z Jirą, powiązania i odchylenia.**

- Połączenie: Administracja, Jira zawiera połączenia z Twoją witryną Jira Cloud. Token API jest przechowywany w postaci zaszyfrowanej i nigdy nie jest pokazywany ponownie. „Przetestuj połączenie” sprawdza witrynę krok po kroku (wyszukanie witryny, konto, typy zgłoszeń, wyszukiwanie, pola, projekty, jedno zgłoszenie) i pokazuje zakres uprawnień potrzebny każdemu krokowi, który się nie powiódł.
- Mapowanie: przypisz poziomy programu, projektu i kamienia milowego do poziomów hierarchii Jiry oraz wybierz pola początku, końca, estymaty i zespołu. Po pierwszym teście połączenia domyślne ustawienia są odczytywane z Twojej witryny (najpierw „Target start” i „Target end” z Jira Plans), a „Zajrzyj do zgłoszenia” pokazuje, jak jedno zgłoszenie odczytuje się przez mapowanie.
- Powiązania: właściciele/ki elementu i administratorzy/rki powiązują projekt lub kamień milowy z jednym elementem Jiry, w relacji jeden do jednego, na stronie projektu; program powiązuje administrator/ka na stronie połączenia.
- Odświeżanie: administrator/ka używa „Odśwież teraz”, żeby odczytać z Jiry powiązane elementy na żądanie.
- Odchylenia: nowa strona Odchylenia pokazuje, gdzie plan i Jira się różnią (daty w dniach roboczych, daty tylko po jednej stronie, nazwy, rodzic, poziomy hierarchii, estymaty, postęp, elementy usunięte z Jiry). Strony projektu i zespołu pokazują znacznik z powiązaniem i liczbą jego odchyleń.
- Nic nie jest zapisywane z powrotem do Jiry: korekty wprowadza się w Astrolabe.
- Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira.`,
  },
  {
    version: "1.0.1",
    date: "2026-11-05",
    en: `**Astrolabe 1.0.1: keyboard focus in dialogs and menus.**

- Dialogs: closing a dialog now returns the keyboard focus to what opened it, the row's menu button or the button you pressed, instead of the start of the page. If saving removed that row or moved it elsewhere, the focus goes to the page's main content.
- Menus: Tab and Shift+Tab now close an open menu and move on from its button. Escape still closes it and stays on the button.
- Account menu: opened from the keyboard, it starts on its first item, like the other menus, so an arrow key moves through the menu instead of changing the theme. Tab reaches the theme switch and then leaves the menu.`,
    pl: `**Astrolabe 1.0.1: fokus klawiatury w oknach dialogowych i menu.**

- Okna dialogowe: zamknięcie okna przenosi teraz fokus klawiatury na to, co je otworzyło, czyli na przycisk menu wiersza albo naciśnięty przycisk, a nie na początek strony. Jeśli zapis usunął ten wiersz lub przeniósł go gdzie indziej, fokus trafia na główną treść strony.
- Menu: Tab i Shift+Tab zamykają teraz otwarte menu i przechodzą dalej od jego przycisku. Escape nadal je zamyka i zostaje na przycisku.
- Menu konta: otwarte z klawiatury zaczyna od pierwszej pozycji, jak pozostałe menu, więc strzałka porusza się po menu, a nie zmienia motywu. Tab przechodzi na przełącznik motywu, a potem opuszcza menu.`,
  },
  {
    version: "1.0.0",
    date: "2026-11-05",
    en: `**Astrolabe 1.0.0: the checkup.**

- Page titles: the browser tab now names the page you are on.
- Keyboard focus: moving to another page puts the focus on its content. After a delete the focus goes to the page's heading without scrolling the list; after a cancel it returns to the row's menu button.
- Row menus: a menu opens with the focus on its first available item, and Escape returns it to the menu button. The menus and the baseline overlays now pass the automated accessibility scan, and the red Delete item is easier to read.
- Changing your own password: after 5 wrong current passwords, password changes are locked for 15 minutes. Signing in is not affected, and a password reset by email or by an administrator lifts the lock.
- Sign-in codes: an account keeps at most 3 sign-in codes valid. A new sign-in always sends a fresh code and the oldest one stops working, so use the code from the latest email.
- Running Astrolabe: the local Kubernetes stack now serves plain HTTP through its own overlay, and the Docker Compose app runs on a read-only file system like the Kubernetes pod.
- Performance was measured again at the full scale of the plan and stays within its targets, so no performance changes were needed.`,
    pl: `**Astrolabe 1.0.0: przegląd.**

- Tytuły stron: karta przeglądarki pokazuje teraz nazwę otwartej strony.
- Fokus klawiatury: przejście na inną stronę przenosi fokus na jej treść. Po usunięciu fokus trafia na nagłówek strony bez przewijania listy, a po anulowaniu wraca na przycisk menu wiersza.
- Menu wierszy: menu otwiera się z fokusem na pierwszej dostępnej pozycji, a Escape przenosi go z powrotem na przycisk menu. Menu i nakładki baz odniesienia przechodzą teraz automatyczny test dostępności, a czerwona pozycja Usuń jest czytelniejsza.
- Zmiana własnego hasła: po 5 błędnych podaniach obecnego hasła zmiana hasła jest zablokowana na 15 minut. Blokada nie wpływa na logowanie, a znosi ją reset hasła przez e-mail lub przez administratora/administratorkę.
- Kody logowania: na koncie ważne są najwyżej 3 kody logowania. Każde nowe logowanie wysyła nowy kod, a najstarszy przestaje działać, więc użyj kodu z najnowszej wiadomości.
- Uruchamianie Astrolabe: lokalny stos Kubernetes działa teraz po zwykłym HTTP dzięki własnej nakładce, a aplikacja w Docker Compose działa na systemie plików tylko do odczytu, tak jak pod w Kubernetes.
- Ponownie zmierzyliśmy wydajność przy pełnej skali planu: mieści się w założonych celach, więc nie wymagała zmian.`,
  },
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

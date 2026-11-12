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

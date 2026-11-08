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

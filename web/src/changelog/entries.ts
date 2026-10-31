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

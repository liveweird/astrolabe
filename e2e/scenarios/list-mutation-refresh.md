# List mutation refresh races

The suite owns uniquely named records, created through the real API. It signs in as the seed
administrator and never changes existing user or person records. Cleanup releases held responses and
deletes only owned records through normal APIs, even when an assertion fails.

## Scenario: a pending Users filter cannot restore a deleted user

1. Create a uniquely named user, then sign in as administrator.
2. Load a settled list containing it; change the name filter to start a new query.
3. Hold the first real response for that query while its previous rows remain actionable.
4. Delete the record through its row menu and confirmation; verify DELETE 204 and GET 404.
5. Deliver the pre-delete response after deletion succeeds.
   - *Expected*: the deleted row disappears without reloading or changing the selected filter.
6. Remove the owned record through the API and release the intercepted request.

## Scenario: a pending People filter cannot restore a deleted person

1. Create a uniquely named person, then sign in as administrator.
2. Load a settled list containing it; change the name filter to start a new query.
3. Hold the first real response for that query while its previous rows remain actionable.
4. Delete the record through its row menu and confirmation; verify DELETE 204 and GET 404.
5. Deliver the pre-delete response after deletion succeeds.
   - *Expected*: the deleted row disappears without reloading or changing the selected filter.
6. Remove the owned record through the API and release the intercepted request.

## Scenario: a pending Feature Flags filter cannot undo a successful toggle

1. Create a throwaway user with MFA disabled; sign in as the seed administrator.
2. Filter Feature Flags to that user and verify its MFA switch is off.
3. Change to another matching name filter and hold its first real response.
4. Toggle MFA on while the previous row remains visible; verify PUT 204 and persisted MFA enabled.
5. Release the response captured before the update.
   - *Expected*: the switch is enabled and on, with the selected name filter preserved.
6. Release the intercepted response and delete only the throwaway user through the API.

## Scenario: a team page left, then reopened after a write on the project page, shows no stale list while its refetch is held

1. Create a team with no manager and a plan with one project; the team has two scheduled milestones (2027) and one in the tray. Sign in as the seed administrator.
2. Open the team page and read its two scheduled rows; follow a milestone's link to the project page (in the single-page app, so the cached team page stays).
3. On the project page, schedule the tray milestone with its Schedule button; verify PUT 200.
4. Hold the team view's GET, then go Back to the team page.
   - *Expected*: no row of the old list is shown while the refetch is held (the cached copy was dropped by the write).
5. Release the held GET.
   - *Expected*: all three rows show; Move to top on one of them sends an order PUT of three milestones that includes the newly scheduled one.
6. Remove the owned records through the API and release the held request.

# User management

- **Spec**: [tests/users.spec.ts](../tests/users.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`); one throwaway user created through
  the UI (email carries the `e2e` marker)
- **Owns** (exclusive server-side state): its throwaway user, deleted at the end; the seed
  admin is never mutated — its row is only read (the own-row assertions)

## Scenario: admin creates a user who signs in, changes their password, and is finally deleted

1. The admin signs in, opens the Users page (`/users`) and filters the Users list to their own row.
   - *Expected*: the row carries the **You** badge and offers **Edit** but neither **Delete**
     nor **Reset password** (self-reset needs the current password; self-delete is blocked
     server-side too).
2. The admin creates a throwaway user — no password field anywhere; on create, the one-time
   reveal modal shows the generated 16-character password (masked until **Show password**),
   which the journey captures before deliberately closing the modal.
3. The new user signs in with the revealed password.
   - *Expected*: no **Users** item in the nav, and `/users` bounces to the Home page — the management
     surface is ADMIN-only.
4. They change their own password on the **Change password** page (current + new + confirm).
   - *Expected*: the app signs this device out by itself: the sign-in page opens with "Your password was
     changed. Sign in with your new password." (the change ended every token of the account).
5. Back as the admin: the throwaway user is promoted to **Administrator** via the edit form
   (the name-filtered list then shows the Admin badge), and afterwards deleted via the row's
   confirm modal.
6. A fresh, filtered load of the list shows no such user, and signing in with the deleted
   account's (changed) password is rejected.

## Scenario: an admin's demotion and deletion reach a signed-in user on their next request

- **Actors**: the seed administrator in one browser context; one throwaway user (promoted to Administrator first) in a
  second context. Both are cleaned up: the user is deleted in the scenario itself.

1. The admin creates a throwaway user and promotes it to **Administrator**; the user signs in in the second context and
   sees the **Users** nav item.
2. The admin removes the Administrator role.
   - *Expected*: on the user's next navigation the old token is refused, the silent refresh brings the regular-user
     roles, the **Users** item disappears, `/users` bounces home, and the user is still signed in.
3. The admin deletes the user.
   - *Expected*: the user's next navigation cannot refresh either: it lands on the sign-in page with "You've been
     signed out."

## Scenario: a new login with the linked-person switch on also creates the person, offered as an owner

- **Actors**: the seed administrator; one throwaway login created through the UI with the **Also create a linked
  person** switch on (the form's default; every other spec's `createUserViaUi` turns it off, so a throwaway login leaves no
  person behind).
- **Owns**: the throwaway login and the person the create made (the person deleted through the API, then the login's row,
  in a `finally`).

1. The admin creates the login on `/users/new` with the switch on.
   - *Expected*: the create answer carries a `personId`.
2. The admin opens the People list filtered to the login's name.
   - *Expected*: a person with that name is listed, showing the login's email.
3. The admin opens **New work stream** on the Plan page and searches the Owner picker for the name.
   - *Expected*: the person is offered as an owner (the dialog is then dismissed; nothing is created).

## Not covered here (and why)

- **The last-administrator 409s and the self-delete 403** — pinned exhaustively by the server
  suite (`UserRoutesTest`, with `TestUsers.withSoloAdmins`) and the page unit tests; e2e keeps
  to the happy lifecycle.
- **The row action "Create a person"** and the switch-off / person-conflict paths — pinned by the server suite
  (`UserCreatePersonTest`) and the page unit tests (`Users.test.tsx`, `CreateUser.test.tsx`).
- **The admin Reset-password reveal** — unit-tested (`Users.test.tsx`); the create-flow reveal
  covered here exercises the same component.

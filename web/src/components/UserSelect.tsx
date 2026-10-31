import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listUsers } from "../api/users";
import { useAdmin } from "../auth";
import SearchPicker, { type PickedOption } from "./SearchPicker";

/**
 * The person editor's Login field: a searchable, clearable picker over the users list. `GET /users` is ADMIN-only, and so is
 * every person write, so the query is `enabled` for an ADMIN session only.
 */
export default function UserSelect({
  picked,
  onPick,
  error,
}: {
  picked: PickedOption | null;
  onPick: (picked: PickedOption | null) => void;
  error?: ReactNode;
}) {
  const { t } = useTranslation();
  const admin = useAdmin();
  return (
    <SearchPicker
      label={t("people.login")}
      description={t("people.loginHint")}
      placeholder={t("people.pickLogin")}
      clearLabel={t("people.clearLogin")}
      noMatchLabel={t("people.noMatchingUsers")}
      queryKey={["users", "picker"]}
      search={async (term) => {
        const page = await listUsers({ page: 1, pageSize: 50, sort: "name", name: term || undefined });
        return page.items.map((u) => ({ value: String(u.id), label: `${u.name} (${u.email})` }));
      }}
      enabled={admin}
      error={error}
      picked={picked}
      onPick={onPick}
    />
  );
}

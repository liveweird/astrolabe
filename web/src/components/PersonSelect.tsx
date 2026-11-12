import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listPeople } from "../api/people";
import SearchPicker, { type PickedOption } from "./SearchPicker";

/**
 * A searchable, clearable picker over the people directory (`GET /people` is open to every signed-in user, so — unlike the
 * ADMIN-only users search — the query runs for any session): the team editor's Manager and the plan editors' Owner.
 * Options read `name (email)` or just `name`; the caller holds the pick (its label survives later searches).
 */
export default function PersonSelect({
  label,
  description,
  placeholder,
  clearLabel,
  picked,
  onPick,
  disabled,
  error,
  compact,
  clearable,
}: {
  label: string;
  description?: string;
  placeholder: string;
  clearLabel: string;
  picked: PickedOption | null;
  onPick: (picked: PickedOption | null) => void;
  disabled?: boolean;
  /** A field error (a validation or a server conflict the form maps onto this control). */
  error?: ReactNode;
  /** A table-row cell: small, the label as the accessible name only (`SearchPicker`). */
  compact?: boolean;
  /** Passed to `SearchPicker`: false hides the clear button (default true). */
  clearable?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SearchPicker
      label={label}
      description={description}
      placeholder={placeholder}
      clearLabel={clearLabel}
      noMatchLabel={t("people.noMatching")}
      queryKey={["people", "picker"]}
      search={async (term) => {
        const page = await listPeople({ page: 1, pageSize: 50, sort: "name", name: term || undefined });
        return page.items.map((p) => ({ value: String(p.id), label: p.email ? `${p.name} (${p.email})` : p.name }));
      }}
      picked={picked}
      onPick={onPick}
      disabled={disabled}
      error={error}
      compact={compact}
      clearable={clearable}
    />
  );
}

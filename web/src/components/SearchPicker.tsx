import { useState, type ReactNode } from "react";
import { Select } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import ErrorAlert from "./ErrorAlert";

/** The picked entry, held by the caller (the form) so its label survives later searches. */
export type PickedOption = { value: string; label: string };

/**
 * A searchable, clearable single Select over a server-side name search (debounced 300 ms — the `AddMemberPicker` pattern):
 * the one body behind `PersonSelect` (owners, managers) and `UserSelect` (a person's login). The wrappers own the query and
 * the texts; this owns the search-box mechanics.
 */
export default function SearchPicker({
  label,
  description,
  placeholder,
  clearLabel,
  noMatchLabel,
  queryKey,
  search,
  enabled = true,
  disabled,
  error,
  picked,
  onPick,
  compact = false,
  clearable = true,
}: {
  label: string;
  description?: string;
  placeholder: string;
  clearLabel: string;
  /** "No matching …" — states a COMPLETED search for the CURRENT term. */
  noMatchLabel: string;
  /** The query-key prefix; the debounced term is appended. */
  queryKey: readonly unknown[];
  /** Runs the server-side search (page size and sort belong to the caller); `term` is "" for the unfiltered head. */
  search: (term: string) => Promise<PickedOption[]>;
  enabled?: boolean;
  /** The control is read-only for this session (a plan editor the caller may only look at). */
  disabled?: boolean;
  /** A field error (a server conflict the form maps onto this control). */
  error?: ReactNode;
  picked: PickedOption | null;
  onPick: (picked: PickedOption | null) => void;
  /** An inline cell (a table row): the small size, and the label is the control's accessible name, not a visible caption. */
  compact?: boolean;
  /** Whether the clear button is offered (default). A caller whose empty pick means "nothing chosen yet" shows it only once there is one. */
  clearable?: boolean;
}) {
  const [searchValue, setSearchValue] = useState(picked?.label ?? "");
  // The caller may change the pick without a choice here (clearing a row's own owner hands it back the dialog's): the box follows the
  // pick's label, the derived-state pattern (set during render, no effect), else it would show the old label for a value it no longer holds.
  const [seenLabel, setSeenLabel] = useState(picked?.label ?? "");
  if ((picked?.label ?? "") !== seenLabel) {
    setSeenLabel(picked?.label ?? "");
    setSearchValue(picked?.label ?? "");
  }
  // Choosing an option makes Mantine put its label into the search box — that is not a search term.
  const term = picked !== null && searchValue === picked.label ? "" : searchValue.trim();
  const [debounced] = useDebouncedValue(term, 300);
  const settling = term !== debounced;

  const results = useQuery({
    queryKey: [...queryKey, debounced],
    queryFn: () => search(debounced),
    placeholderData: keepPreviousData,
    enabled,
  });
  const loading = results.isLoading || results.isPlaceholderData;
  // The picked entry leads the options under its own (stable) label: a new term replaces the rows
  // and Mantine drops a value that is no longer in `data`.
  const options = (results.data ?? []).filter((o) => o.value !== picked?.value);
  if (picked !== null) options.unshift(picked);

  return (
    <>
      <Select
        label={compact ? undefined : label}
        aria-label={compact ? label : undefined}
        size={compact ? "xs" : undefined}
        description={description}
        placeholder={placeholder}
        data={options}
        searchable
        clearable={clearable}
        clearButtonProps={{ "aria-label": clearLabel }}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        value={picked?.value ?? null}
        onChange={(value, option) => onPick(value !== null && option ? { value: option.value, label: option.label } : null)}
        nothingFoundMessage={loading || results.isError || settling ? undefined : noMatchLabel}
        disabled={disabled}
        // A compact cell has a fixed height: a failed search is the red border (no message under it, no alert after it).
        error={error ?? (compact && results.isError ? true : undefined)}
        aria-busy={loading}
      />
      {results.isError && !compact && <ErrorAlert error={results.error} />}
    </>
  );
}

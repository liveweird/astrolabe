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
  error,
  picked,
  onPick,
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
  /** A field error (a server conflict the form maps onto this control). */
  error?: ReactNode;
  picked: PickedOption | null;
  onPick: (picked: PickedOption | null) => void;
}) {
  const [searchValue, setSearchValue] = useState(picked?.label ?? "");
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
        label={label}
        description={description}
        placeholder={placeholder}
        data={options}
        searchable
        clearable
        clearButtonProps={{ "aria-label": clearLabel }}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        value={picked?.value ?? null}
        onChange={(value, option) => onPick(value !== null && option ? { value: option.value, label: option.label } : null)}
        nothingFoundMessage={loading || results.isError || settling ? undefined : noMatchLabel}
        error={error}
        aria-busy={loading}
      />
      {results.isError && <ErrorAlert error={results.error} />}
    </>
  );
}

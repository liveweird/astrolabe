import { Navigate, useLocation } from "react-router-dom";

/**
 * A retired page's address that still works (1.29): a `replace` redirect to `to`, with `params` set over the old address's own query (so `?programId=`
 * and the other parameters a bookmark carried are kept) and its hash. A `replace`, so Back does not return to the address that only redirects.
 * `carry={false}`: the old query is dropped (its parameters mean nothing at the new page), only `params` and the hash remain.
 */
export default function LegacyRedirect({ to, params, carry = true }: { to: string; params?: Readonly<Record<string, string>>; carry?: boolean }) {
  const { search, hash } = useLocation();
  const next = new URLSearchParams(params);
  if (carry) for (const [name, value] of new URLSearchParams(search)) if (params === undefined || !Object.hasOwn(params, name)) next.append(name, value);
  const query = next.toString();
  return <Navigate replace to={`${to}${query === "" ? "" : `?${query}`}${hash}`} />;
}

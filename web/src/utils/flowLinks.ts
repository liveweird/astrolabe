/** The ONE place the Flow route family is spelled out — never hand-assemble a connection URL. */
export const flowConnectionsPath = "/integrations/flow";
export const flowConnectionPath = (id: number) => `${flowConnectionsPath}/${id}`;

/** `http://flow:8084/` → `http://flow:8084`; blank or not http(s) (defence in depth: never a `javascript:` href) → undefined. */
export function flowBaseHref(baseUrl: string | null | undefined): string | undefined {
  let origin = baseUrl?.trim() ?? "";
  while (origin.endsWith("/")) origin = origin.slice(0, -1);
  const lower = origin.toLowerCase();
  return lower.startsWith("https://") || lower.startsWith("http://") ? origin : undefined;
}

import { timeoutSignal } from "./http";

// The build the server is serving NOW, read from the shell it serves: vite.config.ts writes the
// build's commit into index.html as <meta name="astrolabe-build">, from the same constant that feeds
// `__APP_COMMIT__`. index.html is `no-cache` (plugins/Http.kt), so a deploy is never masked. A plain
// `fetch` on purpose: the shell is public and this read must never carry (or refresh) a session.
// Keep the name in step with the plugin in vite.config.ts.
const BUILD_META = 'meta[name="astrolabe-build"]';

/** The commit of the served shell. REJECTS when it cannot say (a non-200, a body with no stamp, a failed fetch): "unknown" is never "equal". */
export async function getServedBuild(): Promise<string> {
  const res = await fetch(`${import.meta.env.BASE_URL}index.html`, { cache: "no-store", signal: timeoutSignal() });
  if (res.status !== 200) throw new Error(`index.html answered ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const commit = doc.querySelector(BUILD_META)?.getAttribute("content")?.trim();
  if (!commit) throw new Error("index.html carries no build stamp");
  return commit;
}

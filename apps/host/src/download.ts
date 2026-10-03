/** A small file from the internet, for tools the helper installs itself. The caller checks its hash. */
export type Download = (url: string) => Promise<Uint8Array>;

const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Far above anything the helper fetches (terminal-notifier is about 400 KB). */
const MAX_BYTES = 20_000_000;

/** Fetches `url` over https, following redirects. Throws in plain words when it did not arrive whole. */
export const downloadBytes: Download = async (url) => {
  if (!url.startsWith("https://")) throw new Error("Only https downloads are allowed.");
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The download failed with HTTP ${response.status}.`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_BYTES) throw new Error("The download is larger than expected.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error("The download is larger than expected.");
  return bytes;
};

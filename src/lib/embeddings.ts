/**
 * Embedding API wrapper — Voyage AI voyage-3 (1024 dims).
 *
 * Anthropic's recommended partner for RAG use cases. Simple REST
 * endpoint; no npm package needed.
 *
 * Returns null when VOYAGE_API_KEY is unset so callers degrade
 * gracefully to keyword-based retrieval. Throws on API errors so
 * the job retry loop handles transient failures.
 *
 * env: VOYAGE_API_KEY — Voyage AI secret key (starts with "pa-")
 */

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-3";

type VoyageResponse = {
  data: Array<{ embedding: number[] }>;
};

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;

  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: [text], model: VOYAGE_MODEL }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(
      `Voyage AI embedding failed: HTTP ${res.status} — ${body.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as VoyageResponse;
  return json.data[0]?.embedding ?? null;
}

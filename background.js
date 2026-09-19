const ROSTER_API =
  "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2/events/{eventId}/registrations/?page={page}&page_size=50";
const ELO_API = "https://eloshowdown.com/riftbound/api/player-search/?q={query}";

const CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [500, 1500];
const ELO_CACHE_TTL_MS = 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`Request failed (${res.status}): ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(err) {
  if (err.name === "AbortError") return true; // timeout
  if (typeof err.status !== "number") return true; // network error, no response
  return err.status === 429 || err.status >= 500;
}

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchJsonOnce(url);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES || !isRetryable(err)) throw err;
      await sleep(RETRY_BACKOFF_MS[attempt] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
    }
  }
  throw lastErr;
}

async function fetchRoster(eventId) {
  const names = [];
  let page = 1;
  while (page) {
    const url = ROSTER_API.replace("{eventId}", eventId).replace("{page}", page);
    const data = await fetchJson(url);
    for (const entry of data.results || []) {
      if (entry.best_identifier) names.push(entry.best_identifier);
    }
    page = data.next_page_number || null;
  }
  return names;
}

const CACHE_NAMESPACE = "riftscout:elo:v2"; // bump to invalidate old entries after cache-logic changes

function cacheKey(name) {
  return `${CACHE_NAMESPACE}:${name.toLowerCase()}`;
}

async function getCachedElo(name) {
  const key = cacheKey(name);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (entry && Date.now() - entry.ts < ELO_CACHE_TTL_MS) {
    return entry.result;
  }
  return null;
}

async function setCachedElo(name, result) {
  const key = cacheKey(name);
  await chrome.storage.session.set({ [key]: { result, ts: Date.now() } });
}

async function lookupEloUncached(name) {
  const url = ELO_API.replace("{query}", encodeURIComponent(name));
  const data = await fetchJson(url);
  const results = data.results || [];
  if (results.length === 0) {
    return { name, elo: null, matches: null, community: "", note: "not found on eloshowdown" };
  }

  // Prefer a byte-exact name match over a merely case-insensitive one — the
  // roster's own casing is a strong, free signal for which account is
  // actually theirs (e.g. roster has "notheroesatall", eloshowdown has both
  // "notheroesatall" and "NotHeroesAtAll" as separate accounts).
  const caseExact = results.filter((r) => r.name === name);
  const caseInsensitive = results.filter((r) => (r.name || "").toLowerCase() === name.toLowerCase());

  if (caseExact.length === 1) {
    const m = caseExact[0];
    return { name, elo: m.elo, matches: m.matches, community: m.community, note: "" };
  }
  if (caseInsensitive.length === 1) {
    const m = caseInsensitive[0];
    return { name, elo: m.elo, matches: m.matches, community: m.community, note: "" };
  }

  // Still tied: a genuine ambiguity between multiple distinct accounts.
  // Leave it unresolved here — the port handler may resolve it with a
  // community-majority guess once it has the whole roster's context.
  const candidates = caseExact.length > 0 ? caseExact : caseInsensitive;
  return {
    name,
    elo: null,
    matches: null,
    community: "",
    note: "ambiguous",
    heuristic: false,
    candidates: candidates.map((c) => ({
      name: c.name,
      community: c.community,
      elo: c.elo,
      matches: c.matches,
    })),
  };
}

async function lookupElo(name) {
  const cached = await getCachedElo(name);
  if (cached) return cached;

  const result = await lookupEloUncached(name);
  // Only cache confident, unambiguous results here. Community-majority
  // guesses are attached later (see resolveAmbiguousByCommunity) and must
  // never be cached globally by name — a different event with the same
  // ambiguous name could have a different majority community and thus a
  // different correct guess.
  if (result.elo !== null) {
    await setCachedElo(name, result);
  }
  return result;
}

// Resolves any still-ambiguous results using the roster's own community
// makeup: if exactly one candidate for a tied name matches the community
// that most of the *confidently resolved* players share, guess that one —
// but keep it visibly flagged (`heuristic: true`) and keep `candidates`
// around so the UI can show what the other option was.
function resolveAmbiguousByCommunity(results) {
  const communityCounts = new Map();
  for (const r of results) {
    if (r.elo !== null && !r.heuristic && r.community) {
      communityCounts.set(r.community, (communityCounts.get(r.community) || 0) + 1);
    }
  }

  let majorityCommunity = null;
  let topCount = 0;
  let tiedForTop = false;
  for (const [community, count] of communityCounts) {
    if (count > topCount) {
      majorityCommunity = community;
      topCount = count;
      tiedForTop = false;
    } else if (count === topCount) {
      tiedForTop = true;
    }
  }
  if (tiedForTop) majorityCommunity = null;

  if (!majorityCommunity) return results;

  return results.map((r) => {
    if (r.elo !== null || !r.candidates) return r;
    const matches = r.candidates.filter((c) => c.community === majorityCommunity);
    if (matches.length !== 1) return r;
    const m = matches[0];
    return {
      ...r,
      elo: m.elo,
      matches: m.matches,
      community: m.community,
      heuristic: true,
      note: "guessed by community match",
    };
  });
}

// Runs `worker` over `items` with at most `concurrency` in flight at once.
// `onSettled` fires after each item resolves (order not guaranteed).
async function runPool(items, concurrency, worker, onSettled) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    onSettled(results[i]);
    await runNext();
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runNext);
  await Promise.all(workers);
  return results;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "roster-elo") return;

  port.onMessage.addListener(async (msg) => {
    if (!msg || (!msg.eventId && !Array.isArray(msg.names))) return;

    try {
      // Some sites (e.g. playriftbound.com) have their roster read directly
      // from the page's DOM by the content script and sent as `names`;
      // others (the locator) send an `eventId` and we fetch the roster
      // ourselves via the registrations API. The locator also sends
      // `extraNames` (whatever's currently rendered) merged in regardless —
      // its API silently omits the logged-in viewer's own registration, so
      // the DOM is the only place that name shows up.
      const apiNames = Array.isArray(msg.names) ? msg.names : await fetchRoster(msg.eventId);
      const names = msg.extraNames ? [...apiNames, ...msg.extraNames] : apiNames;
      const uniqueNames = [...new Set(names)];
      let done = 0;

      const results = await runPool(uniqueNames, CONCURRENCY, lookupElo, () => {
        done += 1;
        port.postMessage({ type: "progress", done, total: uniqueNames.length });
      });

      port.postMessage({ type: "done", results: resolveAmbiguousByCommunity(results) });
    } catch (err) {
      port.postMessage({ type: "error", message: err.message || String(err) });
    }
  });
});

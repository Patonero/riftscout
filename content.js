(function () {
  const HIGH_THRESHOLD = 1300;
  const MID_THRESHOLD = 1000;
  const ROUTE_POLL_MS = 1000;

  // The roster's own name element can contain extra child nodes (e.g. a
  // "(You)" span for the logged-in user's own card on the locator site), so
  // `.textContent` isn't safe to use as the lookup key — pull only the
  // element's own direct text nodes, which hold just the player's name.
  function getOwnText(el) {
    return Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join("")
      .trim();
  }

  // playriftbound.com renders the same "(You)" annotation as literal text
  // inside the single name node (e.g. "Vonnycakes (You)") rather than as a
  // separate child element, so `getOwnText`'s node-filtering trick doesn't
  // help there — strip the suffix directly instead.
  function stripYouSuffix(name) {
    return name.replace(/\s*\(you\)\s*$/i, "").trim();
  }

  // --- Site adapters -------------------------------------------------
  // Both sites share everything non-trivial (port messaging, badge
  // tiering/tooltips, the debounced mutation-observer re-apply, the SPA
  // route-change poll, and all of background.js). Only "how do I find the
  // roster and read/annotate it" differs, so that's all an adapter covers.

  const LOCATOR_ADAPTER = {
    matchesHeading: (el) => el.textContent.trim().toUpperCase().startsWith("ROSTER ("),
    getContainer: (heading) => heading.parentElement,
    getCards: (container) =>
      container.querySelectorAll(".bg-player-card-bg, .grid.grid-cols-1.gap-2 > div"),
    getNameFromCard: (card) => {
      const nameEl = card.querySelector("h4");
      return nameEl ? stripYouSuffix(getOwnText(nameEl)) : "";
    },
    getBadgeAnchor: (card) => card.querySelector(".flex.items-center.space-x-3") || card,
    // Put the button in its own row alongside the "ROSTER (N)" heading,
    // right-aligned across from it — the conventional spot for a section-
    // level action, so it reads immediately as "the roster's action" rather
    // than a stray line of text (the heading has no such row today, so one
    // is created once and reused on re-injection).
    getButtonAnchor: (heading) => {
      const existingRow = heading.parentElement;
      if (existingRow.classList.contains("rb-elo-header-row")) return existingRow;
      const row = document.createElement("div");
      row.className = "rb-elo-header-row";
      existingRow.insertBefore(row, heading);
      row.appendChild(heading);
      return row;
    },
    // No nearby button looks right to borrow from here either (the "List
    // View" toggle is a small tab control, not a primary action) — this
    // site also relies on the baseline `.rb-elo-button-default` styling.
    getReferenceButton: () => null,
    needsBackgroundFetch: true,
    theme: "dark",
  };

  const PLAYRIFTBOUND_ADAPTER = {
    matchesHeading: (el) => el.textContent.trim().toUpperCase() === "REGISTERED PLAYERS",
    getContainer: (heading) => heading.parentElement.parentElement.children[1],
    getCards: (container) => container.querySelectorAll(":scope > div"),
    getNameFromCard: (card) => {
      const nameEl = card.querySelector('span[class*="tt_uppercase"]') || card.querySelector("span");
      return nameEl ? stripYouSuffix(nameEl.textContent.trim()) : "";
    },
    getBadgeAnchor: (card) => card,
    getButtonAnchor: (heading) => heading.parentElement,
    // The only nearby buttons on this site are large primary CTAs
    // ("Register" / "Event is Full") — borrowing their classes would look
    // wrong on a small inline action, so this site relies on the baseline
    // `.rb-elo-button` styling in content.css instead.
    getReferenceButton: () => null,
    needsBackgroundFetch: false,
    theme: "light",
  };

  function getAdapter() {
    return location.hostname === "playriftbound.com" ? PLAYRIFTBOUND_ADAPTER : LOCATOR_ADAPTER;
  }

  const adapter = getAdapter();

  // --- Shared logic ----------------------------------------------------

  let eloCache = null; // Map<lowercaseName, result>
  let badgeObserver = null;
  let observedContainer = null;
  let initObserver = null;
  let currentEventId = extractEventId();

  function extractEventId() {
    const match = location.pathname.match(/(\d+)\/?$/);
    return match ? match[1] : null;
  }

  function findRosterHeading() {
    return Array.from(document.querySelectorAll("h2")).find((el) => adapter.matchesHeading(el));
  }

  function tierClass(result) {
    if (!result || result.elo === null || result.elo === undefined) return "rb-elo-unknown";
    if (result.heuristic) return "rb-elo-guess";
    if (result.elo >= HIGH_THRESHOLD) return "rb-elo-high";
    if (result.elo >= MID_THRESHOLD) return "rb-elo-mid";
    return "rb-elo-low";
  }

  function describeCandidate(c) {
    return `${c.name} (${c.community}, ${c.elo} ELO)`;
  }

  function buildBadge(result) {
    const badge = document.createElement("span");
    badge.className = `rb-elo-badge rb-theme-${adapter.theme} ${tierClass(result)}`;

    if (!result || result.elo === null || result.elo === undefined) {
      badge.textContent = "ELO ?";
      if (result && result.candidates) {
        badge.title = `Multiple accounts match — ${result.candidates.map(describeCandidate).join(", ")}`;
      } else {
        badge.title = result ? result.note : "no data";
      }
    } else if (result.heuristic) {
      badge.textContent = `~${result.elo}`;
      const others = (result.candidates || []).filter((c) => c.elo !== result.elo || c.community !== result.community);
      const alsoFound = others.length ? ` — also found ${others.map(describeCandidate).join(", ")}` : "";
      badge.title = `Best guess, matched by community (${result.matches} matches — ${result.community})${alsoFound}`;
    } else {
      badge.textContent = result.elo.toString();
      badge.title = `${result.matches} matches — ${result.community}`;
    }
    return badge;
  }

  // Inserting/replacing badges is itself a DOM mutation on the container
  // `badgeObserver` watches, so writes here must happen with that observer
  // paused — otherwise each re-apply retriggers the observer, which
  // schedules another re-apply, forever (an infinite feedback loop that
  // pins the CPU and freezes the tab).
  function applyBadges() {
    if (!eloCache || !observedContainer) return;
    if (badgeObserver) badgeObserver.disconnect();

    try {
      const cards = adapter.getCards(observedContainer);
      cards.forEach((card) => {
        const name = adapter.getNameFromCard(card);
        if (!name) return;

        const result = eloCache.get(name.toLowerCase()) || null;
        const resultKey = result ? `${result.elo}:${!!result.heuristic}` : "null";
        const existing = card.querySelector(".rb-elo-badge");
        if (existing && existing.dataset.eloValue === resultKey) {
          return; // already showing the correct value, don't touch the DOM
        }
        if (existing) existing.remove();

        const badge = buildBadge(result);
        badge.dataset.eloValue = resultKey;
        adapter.getBadgeAnchor(card).appendChild(badge);
      });
    } finally {
      if (badgeObserver && observedContainer) {
        badgeObserver.observe(observedContainer, {
          childList: true,
          subtree: true,
        });
      }
    }
  }

  function startObserver(container) {
    stopObserver();
    observedContainer = container;
    let debounceTimer = null;
    badgeObserver = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applyBadges, 150);
    });
    badgeObserver.observe(container, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (badgeObserver) {
      badgeObserver.disconnect();
      badgeObserver = null;
    }
    observedContainer = null;
  }

  function setButtonLabel(button, text) {
    button.textContent = text;
  }

  function showError(button, message) {
    let errorEl = button.parentElement.querySelector(".rb-elo-error");
    if (!errorEl) {
      errorEl = document.createElement("span");
      errorEl.className = `rb-elo-error rb-theme-${adapter.theme}`;
      button.parentElement.appendChild(errorEl);
    }
    errorEl.textContent = message;
  }

  function clearError(button) {
    const errorEl = button.parentElement.querySelector(".rb-elo-error");
    if (errorEl) errorEl.remove();
  }

  function onButtonClick(button, container) {
    clearError(button);
    setButtonLabel(button, "Scanning…");
    button.disabled = true;

    // Always read whatever names are currently rendered, even on sites
    // where the roster is normally fetched via API in the background — the
    // locator's registrations API turns out to silently omit the logged-in
    // viewer's own registration, so relying on it alone would always miss
    // the "(You)" row. Merging in the rendered DOM is cheap and closes that
    // gap regardless of the underlying cause.
    const domNames = Array.from(adapter.getCards(container))
      .map((card) => adapter.getNameFromCard(card))
      .filter(Boolean);

    let payload;
    if (adapter.needsBackgroundFetch) {
      const eventId = extractEventId();
      if (!eventId) {
        showError(button, "Could not determine event ID from URL");
        setButtonLabel(button, "Scout ELOs");
        button.disabled = false;
        return;
      }
      payload = { eventId, extraNames: domNames };
    } else {
      payload = { names: domNames };
    }

    let settled = false;
    const port = chrome.runtime.connect({ name: "roster-elo" });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      showError(
        button,
        "Connection to extension lost — try reloading the page.",
      );
      setButtonLabel(button, "Scout ELOs");
      button.disabled = false;
    });

    port.onMessage.addListener((msg) => {
      if (msg.type === "progress") {
        setButtonLabel(button, `Scanning ${msg.done}/${msg.total}…`);
      } else if (msg.type === "done") {
        settled = true;
        eloCache = new Map(msg.results.map((r) => [r.name.toLowerCase(), r]));
        startObserver(container);
        applyBadges();
        setButtonLabel(button, "Re-scout ELOs");
        button.disabled = false;
      } else if (msg.type === "error") {
        settled = true;
        showError(button, `Failed to load ELOs: ${msg.message}`);
        setButtonLabel(button, "Scout ELOs");
        button.disabled = false;
      }
    });
    port.postMessage(payload);
  }

  function injectButton(heading) {
    if (document.querySelector(".rb-elo-button")) return;

    const container = adapter.getContainer(heading);
    const referenceButton = adapter.getReferenceButton(heading);

    const button = document.createElement("button");
    button.className = referenceButton
      ? `${referenceButton.className} rb-elo-button`
      : "rb-elo-button rb-elo-button-default";
    button.type = "button";
    button.addEventListener("click", () => onButtonClick(button, container));

    adapter.getButtonAnchor(heading).appendChild(button);

    if (eloCache) {
      // Some sites (e.g. playriftbound.com) poll for live updates and
      // periodically re-render the roster section, which wipes out our
      // injected button/badges along with the old DOM. If we already have
      // results for this page, restore both immediately instead of making
      // the user click again.
      button.textContent = "Re-scout ELOs";
      startObserver(container);
      applyBadges();
    } else {
      button.textContent = "Scout ELOs";
    }
  }

  function tryInject() {
    const heading = findRosterHeading();
    if (heading) {
      injectButton(heading);
      return true;
    }
    return false;
  }

  // Kept running for the page's whole lifetime rather than stopping after
  // the first successful injection: some sites (playriftbound.com) poll for
  // live updates and periodically replace the roster section's DOM, which
  // silently removes our button along with it. Re-running `tryInject()` on
  // every mutation is cheap and a no-op once the button already exists, so
  // this just re-heals whenever that happens.
  function watchForHeading() {
    tryInject();
    if (initObserver) return;
    let debounceTimer = null;
    initObserver = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(tryInject, 200);
    });
    initObserver.observe(document.body, { childList: true, subtree: true });
  }

  function resetForNewPage() {
    eloCache = null;
    stopObserver();
    if (initObserver) {
      initObserver.disconnect();
      initObserver = null;
    }
    const oldButton = document.querySelector(".rb-elo-button");
    if (oldButton) oldButton.remove();
    const oldError = document.querySelector(".rb-elo-error");
    if (oldError) oldError.remove();
    watchForHeading();
  }

  watchForHeading();

  // Both sites are client-side-routed apps, so navigating between event
  // pages doesn't always trigger a full content-script reload. Poll the
  // URL for an event ID change and reset state when it happens.
  setInterval(() => {
    const newEventId = extractEventId();
    if (newEventId !== currentEventId) {
      currentEventId = newEventId;
      resetForNewPage();
    }
  }, ROUTE_POLL_MS);
})();

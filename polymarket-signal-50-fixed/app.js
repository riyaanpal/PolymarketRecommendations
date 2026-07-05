const DATA_URL = "data/recommendations.json";

const elements = {
  grid: document.querySelector("#signal-grid"),
  notice: document.querySelector("#notice"),
  headerStatus: document.querySelector("#header-status"),
  eligible: document.querySelector("#stat-eligible"),
  inspected: document.querySelector("#stat-inspected"),
  candidates: document.querySelector("#stat-candidates"),
  updated: document.querySelector("#stat-updated"),
  duration: document.querySelector("#stat-duration"),
  methodButton: document.querySelector("#method-button")
};

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function percentage(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${Math.round(numeric * 100)}%`;
}

function dateLabel(value) {
  if (!value) return "Not run yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function supporterChips(supporters) {
  const shown = supporters.slice(0, 5);
  const chips = shown
    .map(
      (supporter) =>
        `<span class="supporter-chip">#${escapeHtml(supporter.rank)} ${escapeHtml(supporter.name)}</span>`
    )
    .join("");
  const remainder = supporters.length - shown.length;
  return `${chips}${remainder > 0 ? `<span class="supporter-chip">+${remainder} more</span>` : ""}`;
}

function recommendationCard(item, index) {
  const side = String(item.outcome || "Unknown");
  const supporters = Array.isArray(item.supporters) ? item.supporters : [];
  return `
    <article class="signal-card">
      <div class="rank-box">0${index + 1}</div>
      <div class="market-body">
        <div class="market-topline">
          <span class="category">${escapeHtml(item.category || "Other")}</span>
          <span class="side-pill">Side: ${escapeHtml(side)}</span>
        </div>
        <h3 class="market-title">${escapeHtml(item.title)}</h3>
        <div class="market-metrics">
          <span><strong>${integer.format(item.supporterCount || 0)}</strong> same-side holders</span>
          <span><strong>${integer.format(item.opposingSupporters || 0)}</strong> opposing</span>
          <span><strong>${percentage(item.consensusRate)}</strong> agreement</span>
          <span><strong>${money.format(item.totalCurrentValue || 0)}</strong> combined value</span>
          <span><strong>${percentage(item.avgEntryPrice)}</strong> avg entry</span>
        </div>
        <div class="supporters" aria-label="Supporting traders">
          ${supporterChips(supporters)}
        </div>
      </div>
      <div class="signal-action">
        <div class="price">${percentage(item.currentPrice)}</div>
        <div class="price-label">current market price</div>
        <a class="market-link" href="${escapeHtml(item.marketUrl)}" target="_blank" rel="noreferrer noopener">
          Open on Polymarket ↗
        </a>
      </div>
    </article>
  `;
}

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.classList.remove("hidden");
}

function render(data) {
  const stats = data.stats || {};
  const recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];

  elements.eligible.textContent = integer.format(stats.eligibleTraders || 0);
  elements.inspected.textContent = integer.format(stats.leaderboardUsersInspected || 0);
  elements.candidates.textContent = integer.format(stats.candidateMarkets || 0);
  elements.updated.textContent = dateLabel(data.generatedAt);
  elements.duration.textContent = data.durationSeconds
    ? `scan completed in ${integer.format(data.durationSeconds)}s`
    : "daily snapshot";

  if (data.status === "not_generated") {
    elements.headerStatus.innerHTML = '<span class="status-dot"></span><span>Awaiting first refresh</span>';
    elements.grid.innerHTML = "";
    showNotice(
      "The site is ready, but the first live snapshot has not run. In GitHub, open Actions → Daily Polymarket refresh → Run workflow."
    );
    return;
  }

  elements.headerStatus.innerHTML = `<span class="status-dot"></span><span>Updated ${escapeHtml(dateLabel(data.generatedAt))}</span>`;

  if (!recommendations.length) {
    elements.grid.innerHTML = "";
    showNotice(
      "No active markets met the minimum same-side overlap today. The next scheduled refresh will check again."
    );
    return;
  }

  if (recommendations.length < 5) {
    showNotice(
      `Only ${recommendations.length} market${recommendations.length === 1 ? "" : "s"} passed every consensus and tradeability rule today.`
    );
  }

  elements.grid.innerHTML = recommendations.map(recommendationCard).join("");
}

async function load() {
  try {
    const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    elements.grid.innerHTML = "";
    elements.headerStatus.innerHTML = '<span class="status-dot"></span><span>Snapshot unavailable</span>';
    showNotice(`Could not load the daily data file: ${error.message}`);
  }
}

elements.methodButton.addEventListener("click", () => {
  document.querySelector("#methodology").scrollIntoView({ behavior: "smooth" });
});

load();

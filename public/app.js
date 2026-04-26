/* eslint-disable no-unused-vars */
let ALL_METRICS = [];
let COUNTRIES = [];
let currentSort = "combined";
let sortDir = "desc";
let currentCid = null;
let ratings = {};
let pins = {};
let userNotes = {};
let hidden = {};
let profile = {
  youName: "You",
  partnerName: "Partner",
  weights: {},
  accentColor: "#c8a96e",
  partnerAccentColor: "#c8a96e",
};
let partnerData = null; // { partnerId, partnerName } from /api/me

async function init() {
  const res = await fetch("/api/countries");
  const data = await res.json();
  ALL_METRICS = data.metrics;
  COUNTRIES = data.countries;
  await loadData();

  // Check for pending invite and auto-pair if exists
  try {
    const checkRes = await fetch("/api/invite/check", { method: "POST" });
    const checkData = await checkRes.json();
    if (checkData.paired) {
      console.log("Auto-paired with partner");
    }
  } catch {
    // Silent fail - no pending invite
  }

  // Load partner info BEFORE first render
  await loadPartner();
  updatePairedState();

  await renderLB();
  setupEventListeners();
}

async function loadPartner() {
  const res = await fetch("/api/me");
  if (res.ok) {
    partnerData = await res.json();
    console.log("partnerData from /api/me:", partnerData);

    // Load current user's profile from API
    if (partnerData.name) {
      profile.youName = partnerData.name;
    }
    if (partnerData.accentColor) {
      profile.accentColor = partnerData.accentColor;
    }

    // Load partner's profile
    if (partnerData?.partnerId) {
      profile.partnerName = partnerData.partnerName || "Partner";
      profile.partnerAccentColor = partnerData.partnerAccentColor || "#c8a96e";
    } else {
      profile.partnerName = "Partner";
    }
  } else {
    console.error("Failed to load partner data:", res.status);
  }

  // Also check passkey status
  const pkRes = await fetch("/api/passkey/exists");
  if (pkRes.ok) {
    const pkData = await pkRes.json();
    partnerData.hasPasskey = pkData.hasPasskey;
  }

  renderPairTab();
  updateLegendNames();
  updatePairedState();
}

function renderPairTab() {
  const el = document.getElementById("pair-content");
  if (!el) return;

  if (partnerData?.partnerId) {
    const partnerColor = partnerData.partnerAccentColor || "#c8a96e";
    el.innerHTML = `<div style="padding: 16px; text-align: center">
      <div style="margin-bottom: 16px; padding: 12px; background: var(--bg3); border-radius: 8px">
        <div style="font-size: 12px; color: var(--text3); margin-bottom: 4px">Partner</div>
        <div style="font-size: 18px; margin-bottom: 8px">${
      partnerData.partnerName || "Your partner"
    }</div>
        <div style="display: flex; align-items: center; justify-content: center; gap: 8px">
          <span style="width: 16px; height: 16px; border-radius: 50%; background: ${partnerColor}"></span>
          <span style="font-size: 12px; color: var(--text2)">${partnerColor}</span>
        </div>
      </div>
      <button class="btn btn-danger" onclick="unpair()">Unpair</button>
    </div>`;
  } else {
    el.innerHTML = `<div style="padding: 16px; text-align: center">
      <p style="margin-bottom: 12px; color: var(--text2)">Invite a partner to compare scores together</p>
      <button class="btn" style="background: var(--accent); border: none; color: var(--bg); padding: 10px 20px; border-radius: 6px; cursor: pointer" onclick="createInvite()">Create Invite Link</button>
      <div id="inviteLink" style="margin-top: 16px; display: none">
        <input type="text" id="inviteInput" readonly style="width: 100%; padding: 8px; background: var(--bg3); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-family: 'DM Mono', monospace; font-size: 12px">
        <p style="font-size: 11px; color: var(--text3); margin-top: 8px">Share this link with your partner</p>
      </div>
    </div>`;
  }
}

async function createInvite() {
  const res = await fetch("/api/invite", { method: "POST" });
  if (res.ok) {
    const data = await res.json();
    document.getElementById("inviteLink").style.display = "block";
    document.getElementById("inviteInput").value = data.url;
  }
}

async function unpair() {
  if (confirm("Are you sure you want to unpair?")) {
    await fetch("/api/unpair", { method: "POST" });
    partnerData = null;
    renderPairTab();
    updatePairedState();
  }
}

async function loadData() {
  const res = await fetch("/api/data");
  if (res.ok) {
    const data = await res.json();
    ratings = data.ratings || {};
    pins = data.pins || {};
    userNotes = data.notes || {};
    hidden = data.hidden || {};
    profile = data.prefs ||
      { youName: "You", partnerName: "Partner", weights: {} };
  }

  COUNTRIES.forEach((c) => {
    if (!ratings[c.id]) ratings[c.id] = { you: c.you, partner: c.partner };
  });

  ALL_METRICS.forEach((m) => {
    if (profile.weights[m.k] === undefined) profile.weights[m.k] = 3;
  });

  updateLegendNames();
}

function updateLegendNames() {
  document.getElementById("legend-her").textContent = profile.youName || "You";
  document.getElementById("legend-partner").textContent = profile.partnerName ||
    "Partner";
  updateAccentColorUI();
}

function updatePairedState() {
  const isPaired = !!partnerData?.partnerId;
  console.log("updatePairedState:", isPaired, "partnerData:", partnerData);
  document.body.classList.toggle("paired", isPaired);
  document.body.classList.toggle("solo", !isPaired);
}

function ws(id) {
  const c = COUNTRIES.find((x) => x.id === id);
  const r = ratings[id] || { you: 0, partner: 0 };
  const you = r.you || 0;
  const partner = r.partner || 0;

  const youW = profile.weights;
  const isPaired = !!partnerData?.partnerId;

  const tw = ALL_METRICS.reduce((s, m) => s + (youW[m.k] || 3), 0);

  // Use your weights for metric score
  const msYou = ALL_METRICS.reduce(
    (s, m) => s + (c.metrics[m.k] || 5) * (youW[m.k] || 3),
    0,
  ) / tw;

  // You gets 50% personal + 50% metric, unless paired then average
  const youScore = (you / 5 * 10 * 0.5) + (msYou * 0.5);

  if (!isPaired) {
    return youScore;
  }

  // When paired, use partner's weights too
  const partnerW = profile.partnerWeights || youW;
  const twPartner = ALL_METRICS.reduce((s, m) => s + (partnerW[m.k] || 3), 0);
  const msPartner = ALL_METRICS.reduce(
    (s, m) => s + (c.metrics[m.k] || 5) * (partnerW[m.k] || 3),
    0,
  ) / twPartner;

  const partnerScore = (partner / 5 * 10 * 0.5) + (msPartner * 0.5);

  // Average of both weighted scores (not your personal + partner's personal, but combined approach)
  // Each person has already done 50% their rating + 50% their metric-scores
  // So we just average the two final scores
  return (youScore + partnerScore) / 2;
}

function scoreCol(v) {
  const p = v / 10;
  return p >= 0.8
    ? "#8fbf7f"
    : p >= 0.6
    ? "#c8a96e"
    : p >= 0.4
    ? "#bf9f6e"
    : "#bf7f7f";
}

function bar(v) {
  return `<div class="bar-wrap"><div class="bar-fill" style="width:${
    Math.round(v * 10)
  }%;background:${scoreCol(v)}"></div></div>`;
}

function renderLB() {
  const isPaired = !!partnerData?.partnerId;
  const data = COUNTRIES.filter((c) => !hidden[c.id]).map((c) => {
    const r = ratings[c.id] || { you: 0, partner: 0 };
    return {
      id: c.id,
      name: c.name,
      flagEmoji: c.flagEmoji,
      metrics: c.metrics,
      r,
      score: ws(c.id),
      gap: Math.abs((r.you || 0) - (r.partner || 0)),
    };
  });

  const dir = sortDir === "desc" ? 1 : -1;
  data.sort((a, b) => {
    let av, bv;
    if (currentSort === "combined") {
      av = a.score;
      bv = b.score;
    } else if (currentSort === "you") {
      av = a.r.you || 0;
      bv = b.r.you || 0;
    } else if (currentSort === "partner") {
      av = a.r.partner || 0;
      bv = b.r.partner || 0;
    } else if (currentSort === "disagreement") {
      av = a.gap;
      bv = b.gap;
    } else if (currentSort === "pinned") {
      av = pins[a.id] ? 1 : 0;
      bv = pins[b.id] ? 1 : 0;
    } else {
      av = a.metrics[currentSort] || 0;
      bv = b.metrics[currentSort] || 0;
    }
    return (bv - av) * dir;
  });

  const tbody = document.getElementById("lbBody");
  tbody.innerHTML = "";

  data.forEach((c, i) => {
    const rank = i + 1;
    const rc = rank === 1
      ? "top1"
      : rank === 2
      ? "top2"
      : rank === 3
      ? "top3"
      : "";
    const pr = pins[c.id] ? "pinned-row" : "";
    const youV = c.r.you != null ? Number(c.r.you).toFixed(1) : "—";
    const partnerV = c.r.partner != null ? Number(c.r.partner).toFixed(1) : "—";

    const mk = ["cost", "education", "weather", "safety", "healthcare", "visa"];
    const mc = mk.map((k) =>
      `<td>${
        bar(c.metrics[k])
      } <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--text2)">${
        c.metrics[k].toFixed(1)
      }</span></td>`
    ).join("");

    const nt = userNotes[c.id] && userNotes[c.id].trim() ? "* " : "";
    const gapCell = c.r.you != null && c.r.partner != null
      ? `<span class="gap-badge">${c.gap.toFixed(1)}</span>`
      : "—";
    const pinStar = pins[c.id] ? "⭐" : "☆";

    let row = `<tr class="${rc} ${pr}" onclick="openDetail('${c.id}')">` +
      `<td><span class="rank-num">${rank}</span></td>` +
      `<td><div style="display:flex;align-items:center;gap:8px"><span class="flag">${c.flagEmoji}</span><span class="country-name">${nt}${c.name}</span></div></td>` +
      `<td><span class="score-you">${youV}</span></td>`;

    if (isPaired) {
      row += `<td><span class="score-partner">${partnerV}</span></td>`;
    }

    row += `<td><span class="score-combined">${c.score.toFixed(2)}</span></td>`;

    if (isPaired) {
      row += `<td>${gapCell}</td>`;
    }

    row += mc +
      `<td onclick="event.stopPropagation();togglePin('${c.id}')" style="cursor:pointer;font-size:15px;text-align:center">${pinStar}</td>` +
      `<td onclick="event.stopPropagation();toggleHide('${c.id}')" style="text-align:center"><button class="hide-btn" title="Hide this country">✕</button></td>` +
      `</tr>`;
    tbody.innerHTML += row;
  });

  document.querySelectorAll(".lb-table th").forEach((t) => {
    t.classList.remove("sorted");
    const sd = t.querySelector(".sort-dir");
    if (sd) sd.remove();
  });

  const th = document.getElementById("th-" + currentSort);
  if (th) {
    th.classList.add("sorted");
    const arrow = document.createElement("span");
    arrow.className = "sort-dir";
    arrow.innerHTML = sortDir === "desc" ? " ↓" : " ↑";
    th.appendChild(arrow);
  }
}

function setSort(key) {
  if (currentSort === key) {
    sortDir = sortDir === "desc" ? "asc" : "desc";
  } else {
    currentSort = key;
    sortDir = "desc";
  }
  renderLB();
}

function togglePin(id) {
  pins[id] = !pins[id];
  persist("pins", pins);
  renderLB();
}

function toggleHide(id) {
  hidden[id] = true;
  persist("hidden", hidden);
  renderLB();
}

function openDetail(id) {
  currentCid = id;
  const c = COUNTRIES.find((x) => x.id === id);
  const r = ratings[id] || { you: 0, partner: 0 };

  document.getElementById("d-flag").textContent = c.flagEmoji;
  document.getElementById("d-name").textContent = c.name;
  document.getElementById("d-visa").textContent = c.visa;
  document.getElementById("sc-you-lbl").textContent = profile.youName || "You";
  document.getElementById("sc-partner-lbl").textContent = profile.partnerName ||
    "Partner";
  document.getElementById("edit-you").value = r.you ?? "";
  document.getElementById("edit-partner").value = r.partner ?? "";
  refreshWS();

  const ML = {
    cost: "Cost of living",
    housing: "Housing",
    groceries: "Groceries & food",
    healthcare: "Healthcare",
    education: "Education",
    safety: "Safety",
    weather: "Weather",
    language: "Language",
    family: "Family",
    visa: "Visa ease",
    nightlife: "Nightlife & social",
    nature: "Nature & outdoors",
    culture: "Culture & arts",
    shopping: "Shopping",
    transport: "Transport",
    internet: "Internet",
    politics: "Political stability",
    expat: "Expat community",
  };

  document.getElementById("d-metrics").innerHTML = ALL_METRICS.map((m) => {
    const k = m.k;
    const v = c.metrics[k] || 5;
    const w = profile.weights[k] || 3;
    return `<div class="metric-card"><div class="metric-card-label">${
      ML[k]
    }</div>` +
      `<div class="metric-card-row">` +
      `<span class="metric-card-score" style="color:${scoreCol(v)}">${
        v.toFixed(1)
      }</span>` +
      `<div class="metric-card-bar"><div class="metric-card-fill" style="width:${
        v * 10
      }%;background:${scoreCol(v)}"></div></div>` +
      `<span class="metric-wt">wt:${w}</span>` +
      `</div></div>`;
  }).join("");

  drawSpider(c);

  const kp = c.keyPoints || {};
  const secs = [
    { key: "pros", cls: "kp-pros", icon: "+", title: "Highlights" },
    { key: "cons", cls: "kp-cons", icon: "!", title: "Drawbacks" },
    { key: "thingsToDo", cls: "kp-do", icon: ">", title: "Things to do" },
    { key: "watchOut", cls: "kp-watch", icon: "~", title: "Watch out for" },
  ];

  document.getElementById("d-keypoints").innerHTML = secs.map((s) => {
    const items = (kp[s.key] || []).map((i) => `<li>${i}</li>`).join("");
    return `<div class="kp-section ${s.cls}">` +
      `<div class="kp-hdr"><span class="kp-icon">${s.icon}</span><span class="kp-title">${s.title}</span></div>` +
      `<ul class="kp-list">${items}</ul>` +
      `</div>`;
  }).join("");

  const vd = c.visaDetails || {};
  const rd = c.residency || {};

  let vHtml = "";
  vHtml += `<p class="vr-section-label vr-visa-label">Visa</p>`;
  vHtml += `<div class="vr-cards">`;
  const visaFields = [
    ["Income requirement", vd.Income],
    ["Duration", vd.Duration],
    ["Process", vd.Process],
    ["Visa type", c.visa],
  ];
  visaFields.forEach((f) => {
    if (f[1]) {
      vHtml += `<div class="vr-card"><div class="vr-card-label">${
        f[0]
      }</div><div class="vr-card-val">${f[1]}</div></div>`;
    }
  });
  vHtml += `</div>`;

  const partnerVal = vd.PartnerIncluded || "Unknown";
  const partnerCls = partnerVal.toLowerCase().includes("yes")
    ? "vr-partner-yes"
    : partnerVal.toLowerCase().includes("no")
    ? "vr-partner-no"
    : "vr-partner-cond";
  vHtml +=
    `<div class="vr-card" style="margin-bottom:14px;grid-column:span 2"><div class="vr-card-label">Partner / spouse included</div><div class="vr-card-val">${partnerVal}<span class="vr-partner-badge ${partnerCls}">${
      partnerVal.split(".")[0]
    }</span></div></div>`;

  vHtml +=
    `<p class="vr-section-label vr-residency-label">Permanent Residency</p>`;
  vHtml += `<div class="vr-cards">`;
  const resFields = [
    ["Residency after", rd.PermanentResidency],
    ["Income required", rd.ResidencyIncome],
    ["Language test", rd.LanguageTest],
    ["Partner residency", rd.PartnerResidency],
  ];
  resFields.forEach((f) => {
    if (f[1]) {
      vHtml += `<div class="vr-card"><div class="vr-card-label">${
        f[0]
      }</div><div class="vr-card-val">${f[1]}</div></div>`;
    }
  });
  vHtml += `</div>`;

  vHtml += `<p class="vr-section-label vr-citizenship-label">Citizenship</p>`;
  vHtml += `<div class="vr-cards">`;
  const citFields = [
    ["Citizenship after", rd.Citizenship],
    ["Language required", rd.CitizenshipLanguage],
    ["Test required", rd.CitizenshipTest],
    ["Dual citizenship", rd.DualCitizenship],
    ["Partner citizenship", rd.PartnerCitizenship],
    ["Notes", rd.CitizenshipNotes],
  ];
  citFields.forEach((f) => {
    if (f[1]) {
      vHtml += `<div class="vr-card"><div class="vr-card-label">${
        f[0]
      }</div><div class="vr-card-val">${f[1]}</div></div>`;
    }
  });
  vHtml += `</div>`;

  vHtml += `<div class="overview-note" style="margin-top:4px">${
    c.description || ""
  }</div>`;
  document.getElementById("d-visablock").innerHTML = vHtml;

  const locs = c.locations || [];
  const locHtml = locs.length
    ? `<div class="loc-grid">${
      locs.map((l) => {
        let rows = "";
        if (l.pop) {
          rows +=
            `<div class="loc-row"><span class="loc-key">Population</span><span class="loc-val">${l.pop}</span></div>`;
        }
        if (l.cost) {
          rows +=
            `<div class="loc-row"><span class="loc-key">Avg 2-bed rent</span><span class="loc-val">${l.cost}</span></div>`;
        }
        if (l.vibe) {
          rows +=
            `<div class="loc-row"><span class="loc-key">Vibe</span><span class="loc-val">${l.vibe}</span></div>`;
        }
        if (l.note) {
          rows +=
            `<div class="loc-row"><span class="loc-key">Best for</span><span class="loc-val">${l.note}</span></div>`;
        }
        const tags = (l.tags || []).map((t) =>
          `<span class="loc-tag">${t}</span>`
        ).join("");
        return `<div class="loc-card"><div class="loc-name">${l.name}${tags}</div><div class="loc-region">${l.region}</div>${rows}</div>`;
      }).join("")
    }</div>`
    : `<div class="overview-note">No location data yet.</div>`;
  document.getElementById("d-locations").innerHTML = locHtml;

  const col = c.col || {};
  let colHtml = "";
  const colSections = [
    { key: "groceries", title: "Groceries (typical prices)" },
    { key: "eating", title: "Eating & drinking out" },
    { key: "transport", title: "Transport & utilities" },
    { key: "leisure", title: "Leisure & lifestyle" },
  ];

  colSections.forEach((s) => {
    const items = col[s.key] || [];
    if (!items.length) return;
    colHtml +=
      `<div class="col-section"><div class="col-section-title">${s.title}</div><div class="col-grid">`;
    items.forEach((item) => {
      const vsCls = item.vs === "cheaper"
        ? "col-cheaper"
        : item.vs === "pricier"
        ? "col-pricier"
        : "col-same";
      const vsLabel = item.vs === "cheaper"
        ? " vs UK"
        : item.vs === "pricier"
        ? " vs UK"
        : "";
      colHtml +=
        `<div class="col-item"><span class="col-item-name">${item.name}</span><span class="col-item-price">${item.price}<span class="col-item-vs ${vsCls}">${vsLabel}</span></span></div>`;
    });
    colHtml += `</div></div>`;
  });

  if (!colHtml) {
    colHtml = '<div class="overview-note">No cost of living data yet.</div>';
  }
  document.getElementById("d-col").innerHTML = colHtml;

  document.getElementById("our-notes").value = userNotes[id] || "";
  document.getElementById("notesSaved").classList.remove("show");

  switchTab("overview");
  document.getElementById("detailOverlay").classList.add("open");
}

function drawSpider(c) {
  const SM = [
    "healthcare",
    "education",
    "safety",
    "weather",
    "cost",
    "housing",
    "family",
    "nature",
    "culture",
    "language",
  ];
  const SL = {
    healthcare: "Health",
    education: "Edu",
    safety: "Safety",
    weather: "Weather",
    cost: "Cost",
    housing: "Housing",
    family: "Family",
    nature: "Nature",
    culture: "Culture",
    language: "Language",
  };
  const N = SM.length;
  const cx = 165, cy = 165, R = 115, S = 330;

  const pts = SM.map((k, i) => {
    const a = -Math.PI / 2 + 2 * Math.PI * i / N;
    const v = (c.metrics[k] || 5) / 10;
    return {
      x: cx + R * v * Math.cos(a),
      y: cy + R * v * Math.sin(a),
      lx: cx + (R + 24) * Math.cos(a),
      ly: cy + (R + 24) * Math.sin(a),
      lb: SL[k],
    };
  });

  let grids = "";
  [0.25, 0.5, 0.75, 1].forEach((g) => {
    const pp = SM.map((_, i) => {
      const a = -Math.PI / 2 + 2 * Math.PI * i / N;
      return (cx + R * g * Math.cos(a)) + "," + (cy + R * g * Math.sin(a));
    }).join(" ");
    grids +=
      `<polygon points="${pp}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="1"/>`;
  });

  let axes = "";
  SM.forEach((_, i) => {
    const a = -Math.PI / 2 + 2 * Math.PI * i / N;
    axes += `<line x1="${cx}" y1="${cy}" x2="${cx + R * Math.cos(a)}" y2="${
      cy + R * Math.sin(a)
    }" stroke="rgba(255,255,255,.08)" stroke-width="1"/>`;
  });

  const poly = pts.map((p) => p.x + "," + p.y).join(" ");
  const dots = pts.map((p) =>
    `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#c8a96e"/>`
  ).join("");
  const lbls = pts.map((p) =>
    `<text x="${p.lx}" y="${p.ly}" text-anchor="middle" dominant-baseline="middle" font-size="9" fill="rgba(255,255,255,.5)" font-family="DM Mono,monospace">${p.lb}</text>`
  ).join("");

  document.getElementById("spiderWrap").innerHTML =
    `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">` +
    grids + axes +
    `<polygon points="${poly}" fill="rgba(200,169,110,.18)" stroke="#c8a96e" stroke-width="2" stroke-linejoin="round"/>` +
    dots + lbls + `</svg>`;
}

function refreshWS() {
  const you = parseFloat(document.getElementById("edit-you").value);
  const partner = parseFloat(document.getElementById("edit-partner").value);

  if (!isNaN(you)) ratings[currentCid].you = Math.min(5, Math.max(0, you));
  else ratings[currentCid].you = null;

  if (!isNaN(partner)) {
    ratings[currentCid].partner = Math.min(5, Math.max(0, partner));
  } else ratings[currentCid].partner = null;

  document.getElementById("d-combined").textContent = ws(currentCid).toFixed(2);
}

function liveUpdate() {
  refreshWS();
  saveData();
  renderLB();
}

function saveNote() {
  userNotes[currentCid] = document.getElementById("our-notes").value;
  persist("notes", userNotes);
  const el = document.getElementById("notesSaved");
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2000);
  renderLB();
}

async function persist(key, value) {
  await fetch("/api/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

async function saveData() {
  await persist("ratings", ratings);
}

function switchTab(name) {
  document.querySelectorAll(".d-tab").forEach((b) =>
    b.classList.remove("active")
  );
  document.querySelectorAll(".d-tab-content").forEach((d) =>
    d.classList.remove("active")
  );
  document.getElementById("tab-" + name).classList.add("active");
  document.querySelectorAll(".d-tab").forEach((b) => {
    if (
      b.getAttribute("onclick") &&
      b.getAttribute("onclick").includes(`"${name}"`)
    ) b.classList.add("active");
  });
  if (name === "spider") drawSpider(COUNTRIES.find((x) => x.id === currentCid));
}

function bgClose(e, id) {
  if (e.target === document.getElementById(id)) closeOverlay(id);
}

function closeOverlay(id) {
  document.getElementById(id).classList.remove("open");
}

function setupEventListeners() {
  document.getElementById("profile-btn").addEventListener("click", openProfile);
}

function openProfile() {
  // Check passkey status
  fetch("/api/passkey/exists").then((r) => r.json()).then((d) => {
    const btn = document.getElementById("passkeySetupBtn");
    const status = document.getElementById("passkeyStatus");
    if (btn && d.hasPasskey) {
      btn.textContent = "Passkey Active";
      btn.disabled = true;
      if (status) {
        status.textContent = "You can use this passkey to sign in.";
        status.style.color = "var(--accent)";
        status.style.display = "block";
      }
    }
  });

  document.getElementById("p-your-name").value = profile.youName || "";
  document.getElementById("p-accent-color").value = profile.accentColor ||
    "#c8a96e";

  const colorInput = document.getElementById("p-accent-color");
  if (colorInput) {
    colorInput.oninput = () => {
      profile.accentColor = colorInput.value;
      autoSaveProfile();
    };
  }

  updateAccentColorUI();

  const rows = ALL_METRICS.map((m) => {
    const w = profile.weights[m.k] || 3;
    return `<div class="weight-row">` +
      `<div style="flex:1"><div class="weight-label">${m.label}</div><div class="weight-sub">${m.sub}</div></div>` +
      `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">` +
      `<input type="range" min="1" max="5" step="1" value="${w}" data-key="${m.k}" oninput="this.nextElementSibling.textContent=this.value;autoSaveProfile()" style="width:80px">` +
      `<span class="weight-val">${w}</span>` +
      `</div>` +
      `</div>`;
  }).join("");
  document.getElementById("weightsGrid").innerHTML = rows;
  document.getElementById("profileOverlay").classList.add("open");
}

function autoSaveProfile() {
  profile.youName = document.getElementById("p-your-name").value || "You";
  profile.partnerName = "Partner";
  profile.accentColor = document.getElementById("p-accent-color")?.value ||
    "#c8a96e";

  updateAccentColorUI();
  persistProfileToServer();

  document.querySelectorAll("#weightsGrid input[type=range]").forEach((inp) => {
    const key = inp.dataset.key;
    profile.weights[key] = parseInt(inp.value);
  });

  persist("prefs", profile);
  renderLB();
}

async function persistProfileToServer() {
  await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: profile.youName,
      accentColor: profile.accentColor,
    }),
  });
}

function updateAccentColorUI() {
  const myColor = profile?.accentColor || "#c8a96e";
  const partnerColor = profile?.partnerAccentColor || myColor;
  document.documentElement.style.setProperty("--her", myColor);
  document.documentElement.style.setProperty("--him", partnerColor);
}

function saveProfile() {
  profile.youName = document.getElementById("p-your-name").value || "You";
  profile.partnerName = document.getElementById("p-partner-name")?.value ||
    "Partner";
  profile.accentColor = document.getElementById("p-accent-color")?.value ||
    "#c8a96e";

  updateAccentColorUI();
  persistProfileToServer();

  document.querySelectorAll("#weightsGrid input[type=range]").forEach((inp) => {
    const key = inp.dataset.key;
    profile.weights[key] = parseInt(inp.value);
  });

  persist("prefs", profile);
  renderLB();
}

function switchProfileTab(name, btn) {
  document.querySelectorAll(".d-tab").forEach((t) =>
    t.classList.remove("active")
  );
  btn.classList.add("active");
  document.querySelectorAll("[id^=ptab-]").forEach((div) =>
    div.style.display = "none"
  );
  document.getElementById(`ptab-${name}`).style.display = "block";

  if (name === "hidden") renderHidden();
}

function renderHidden() {
  const list = document.getElementById("hiddenList");
  const empty = document.getElementById("hiddenEmpty");
  if (!list || !empty) return;

  const hiddenIds = Object.keys(hidden).filter((id) => hidden[id]);
  if (hiddenIds.length === 0) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  list.innerHTML = hiddenIds.map((id) => {
    const c = COUNTRIES.find((x) => x.id === id);
    return c
      ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
      <span>${c.flagEmoji} ${c.name}</span>
      <button class="btn" style="background:var(--accent);border:none;color:var(--bg);padding:4px 12px;border-radius:4px;cursor:pointer" onclick="unhide('${id}')">Unhide</button>
    </div>`
      : "";
  }).join("");
}

function unhide(id) {
  delete hidden[id];
  persist("hidden", hidden);
  renderHidden();
  renderLB();
}

async function setupPasskey() {
  const btn = document.getElementById("passkeySetupBtn");
  const status = document.getElementById("passkeyStatus");

  btn.disabled = true;
  btn.textContent = "Setting up...";
  status.style.display = "none";

  try {
    const beginRes = await fetch("/auth/passkey/register/begin", {
      method: "POST",
    });
    if (!beginRes.ok) {
      const errText = await beginRes.text();
      throw new Error(`Failed to start: ${errText}`);
    }

    const result = await beginRes.json();

    // Convert base64url challenge to ArrayBuffer
    const challengeB64 = result.options.challenge;
    const userIdB64 = result.options.user.id;
    const options = { ...result.options };
    options.challenge = Uint8Array.from(
      atob(challengeB64.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    options.user = {
      ...options.user,
      id: Uint8Array.from(
        atob(userIdB64.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      ),
    };
    options.excludeCredentials = (options.excludeCredentials || []).map(
      (c) => ({
        ...c,
        id: Uint8Array.from(
          atob(c.id.replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        ),
      }),
    );

    const cred = await navigator.credentials.create({ publicKey: options });

    const finishRes = await fetch("/auth/passkey/register/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: result.challengeId,
        response: cred,
      }),
    });

    if (!finishRes.ok) {
      const errText = await finishRes.text();
      throw new Error(`Failed to complete: ${errText}`);
    }

    status.textContent = "Passkey set up successfully!";
    status.style.color = "var(--accent)";
    status.style.display = "block";
    btn.textContent = "Passkey Active";
  } catch (err) {
    status.textContent = err.message || "Failed to set up passkey";
    status.style.color = "var(--err)";
    status.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Set up Passkey";
  }
}

// Expose functions for inline HTML handlers
globalThis.setSort = setSort;
globalThis.togglePin = togglePin;
globalThis.toggleHide = toggleHide;
globalThis.openDetail = openDetail;
globalThis.liveUpdate = liveUpdate;
globalThis.saveNote = saveNote;
globalThis.bgClose = bgClose;
globalThis.closeOverlay = closeOverlay;
globalThis.switchTab = switchTab;
globalThis.autoSaveProfile = autoSaveProfile;
globalThis.openProfile = openProfile;
globalThis.saveProfile = saveProfile;
globalThis.switchProfileTab = switchProfileTab;
globalThis.setupPasskey = setupPasskey;
globalThis.createInvite = createInvite;
globalThis.unpair = unpair;
globalThis.unhide = unhide;
globalThis.updateAccentColorUI = updateAccentColorUI;
globalThis.persistProfileToServer = persistProfileToServer;
globalThis.updateLegendNames = updateLegendNames;
globalThis.updatePairedState = updatePairedState;

document.addEventListener("DOMContentLoaded", init);

import { useState, useMemo, useCallback, useRef, useEffect } from "react";

// ─── PERSISTED KEYS REGISTRY ───
const PERSISTED_KEYS = ["bets", "expenses", "profiles", "activeProfile", "bankrollEntries", "bankrollHistory", "expensesPaidManual", "bankBalances", "jan1Bankrolls", "profileNotes", "bookLimits", "apiEndpoints", "w2gDocuments", "expenseReceipts", "taxOtherIncome", "taxFilingStatus", "profitGoals", "freeBetMode"];

// ─── PERSISTENCE HOOK — cloud-first with localStorage cache ───
function usePersistedState(key, defaultValue) {
  const prefixedKey = `et_${key}`;
  const cloudLoaded = useRef(false);

  // Initialize from localStorage cache (instant render, no flash)
  const [state, setState] = useState(() => {
    try {
      const stored = localStorage.getItem(prefixedKey);
      if (stored !== null) return JSON.parse(stored);
    } catch (e) {}
    return typeof defaultValue === "function" ? defaultValue() : defaultValue;
  });

  // On mount, async load from cloud storage (cross-device source of truth)
  useEffect(() => {
    let mounted = true;
    if (!window.storage) { cloudLoaded.current = true; return; }
    (async () => {
      try {
        const result = await window.storage.get(prefixedKey);
        if (mounted && result && result.value) {
          const parsed = JSON.parse(result.value);
          setState(parsed);
          try { localStorage.setItem(prefixedKey, result.value); } catch {}
        }
      } catch {} // Key doesn't exist in cloud yet — keep local value
      finally { if (mounted) cloudLoaded.current = true; }
    })();
    return () => { mounted = false; };
  }, [prefixedKey]);

  // Write to both localStorage + cloud on every state change (after initial cloud load)
  useEffect(() => {
    if (!cloudLoaded.current) return;
    const json = JSON.stringify(state);
    try { localStorage.setItem(prefixedKey, json); } catch {}
    if (window.storage) {
      (async () => { try { await window.storage.set(prefixedKey, json); } catch {} })();
    }
  }, [prefixedKey, state]);

  return [state, setState];
}

// Special variant for Set<string> — serializes as array
function usePersistedSet(key, defaultValue) {
  const prefixedKey = `et_${key}`;
  const cloudLoaded = useRef(false);

  const [state, setState] = useState(() => {
    try {
      const stored = localStorage.getItem(prefixedKey);
      if (stored !== null) return new Set(JSON.parse(stored));
    } catch {}
    return defaultValue instanceof Set ? defaultValue : new Set();
  });

  useEffect(() => {
    let mounted = true;
    if (!window.storage) { cloudLoaded.current = true; return; }
    (async () => {
      try {
        const result = await window.storage.get(prefixedKey);
        if (mounted && result && result.value) {
          setState(new Set(JSON.parse(result.value)));
          try { localStorage.setItem(prefixedKey, result.value); } catch {}
        }
      } catch {}
      finally { if (mounted) cloudLoaded.current = true; }
    })();
    return () => { mounted = false; };
  }, [prefixedKey]);

  useEffect(() => {
    if (!cloudLoaded.current) return;
    const json = JSON.stringify([...state]);
    try { localStorage.setItem(prefixedKey, json); } catch {}
    if (window.storage) {
      (async () => { try { await window.storage.set(prefixedKey, json); } catch {} })();
    }
  }, [prefixedKey, state]);

  return [state, setState];
}

// ─── VERSION & UPDATE SYSTEM ───
const APP_VERSION = "1.0.0";
const VERSION_CHECK_URL = "/version.json";
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000; // check every 5 min

const semverCompare = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
};

const registerServiceWorker = async () => {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    reg.addEventListener("updatefound", () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          window.dispatchEvent(new CustomEvent("sw-update-available", { detail: { registration: reg } }));
        }
      });
    });
    reg.update();
    setInterval(() => reg.update(), UPDATE_CHECK_INTERVAL);
    return reg;
  } catch (err) {
    console.warn("[Update] SW registration failed:", err);
    return null;
  }
};

const checkVersionEndpoint = async () => {
  try {
    const res = await fetch(`${VERSION_CHECK_URL}?_=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

const SPORTS = ["Football", "Basketball", "Baseball", "Hockey", "Soccer", "Tennis", "MMA", "Golf", "Other"];
const LEAGUES = {
  Football: ["NFL", "NCAAF", "CFL", "XFL", "USFL"],
  Basketball: ["NBA", "NCAAB", "NCAAW", "WNBA", "EuroLeague"],
  Baseball: ["MLB", "KBO", "NPB"],
  Hockey: ["NHL"],
  Soccer: ["EPL", "MLS", "La Liga", "Champions League", "Serie A", "Bundesliga", "Ligue 1", "Liga MX"],
  Tennis: ["ATP", "WTA", "Grand Slam"],
  MMA: ["UFC", "Bellator", "PFL", "ONE"],
  Golf: ["PGA", "LIV", "LPGA", "DP World"],
  Other: ["Multi-Sport Parlay"],
};
const ALL_LEAGUES = Object.values(LEAGUES).flat();
const LEAGUE_TO_SPORT = {};
Object.entries(LEAGUES).forEach(([sport, leagues]) => leagues.forEach(l => { LEAGUE_TO_SPORT[l] = sport; }));
// Legacy: old bets might have sport="Soccer" etc. — map those too
SPORTS.forEach(s => { if (!LEAGUE_TO_SPORT[s]) LEAGUE_TO_SPORT[s] = s; });

// Normalize a bet object — adds league/sport fields if missing, handles old format
const normalizeBet = (b) => {
  if (b.league && b.sport && SPORTS.includes(b.sport)) {
    // If it's a parlay/RR under "Other" sport with "Other" league, reclassify as Multi-Sport Parlay
    if (b.sport === "Other" && b.league === "Other" && (b.parlay || b.type === "Parlay" || b.type === "Round Robin")) {
      return { ...b, league: "Multi-Sport Parlay" };
    }
    return b;
  }
  // Old format: b.sport contains a league name like "NFL"
  const raw = b.league || b.sport || "Other";
  let league = raw;
  let sport = LEAGUE_TO_SPORT[raw] || (SPORTS.includes(raw) ? raw : "Other");
  // Classify unknown parlays as Multi-Sport Parlay
  if (sport === "Other" && league === "Other" && (b.parlay || b.type === "Parlay" || b.type === "Round Robin")) {
    league = "Multi-Sport Parlay";
  }
  return { ...b, league, sport };
};
const BET_TYPES = ["Moneyline", "Spread", "Over/Under", "Parlay", "Round Robin", "Prop", "Futures", "Live"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_HEADER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const EXPENSE_CATEGORIES = [
  { id: "hardware", label: "Hardware", icon: "⊞" },
  { id: "software", label: "Software / SaaS", icon: "◈" },
  { id: "data", label: "Data & Subscriptions", icon: "◉" },
  { id: "vpn", label: "VPN / Proxy", icon: "◐" },
  { id: "hosting", label: "Hosting / Cloud", icon: "△" },
  { id: "education", label: "Education / Courses", icon: "▣" },
  { id: "travel", label: "Travel", icon: "✦" },
  { id: "office", label: "Office / Workspace", icon: "⬡" },
  { id: "legal", label: "Legal / Accounting", icon: "§" },
  { id: "misc", label: "Miscellaneous", icon: "○" },
];

const RECURRENCE_OPTIONS = ["One-time", "Weekly", "Monthly", "Quarterly", "Annually"];

const TAX_BRACKETS_2025 = [
  { min: 0, max: 11925, rate: 0.10 },
  { min: 11925, max: 48475, rate: 0.12 },
  { min: 48475, max: 103350, rate: 0.22 },
  { min: 103350, max: 197300, rate: 0.24 },
  { min: 197300, max: 250525, rate: 0.32 },
  { min: 250525, max: 626350, rate: 0.35 },
  { min: 626350, max: Infinity, rate: 0.37 },
];

const SAMPLE_BETS = [];

const generateSampleExpenses = () => [];

const formatMoney = (n) => {
  const abs = Math.abs(n);
  const formatted = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs.toFixed(2);
  return n < 0 ? `-$${formatted}` : `$${formatted}`;
};
const formatOdds = (o) => (o > 0 ? `+${o}` : `${o}`);
const impliedProb = (odds) => odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
const calcTax = (income) => {
  let tax = 0, remaining = income;
  for (const bracket of TAX_BRACKETS_2025) {
    if (remaining <= 0) break;
    const taxable = Math.min(remaining, bracket.max - bracket.min);
    tax += taxable * bracket.rate;
    remaining -= taxable;
  }
  return tax;
};

const Sparkline = ({ data, color, height = 40, width = 120 }) => {
  if (!data.length) return null;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const points = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * (height - 4) - 2}`).join(" ");
  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={width} cy={height - ((data[data.length - 1] - min) / range) * (height - 4) - 2} r="3" fill={color} />
    </svg>
  );
};

const MiniBar = ({ value, max, color }) => (
  <div style={{ width: "100%", height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3 }}>
    <div style={{ width: `${Math.min(100, (Math.abs(value) / (max || 1)) * 100)}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.6s ease" }} />
  </div>
);

const c = {
  bg: "#0a0b0f", card: "#12131a", cardHover: "#181924",
  border: "#1e2030", borderLight: "#2a2d45",
  text: "#e8e9f0", textDim: "#6b6f8a", textMuted: "#3d4060",
  green: "#00e68a", greenDim: "rgba(0,230,138,0.12)", greenGlow: "rgba(0,230,138,0.25)",
  red: "#ff4d6a", redDim: "rgba(255,77,106,0.12)",
  blue: "#4d94ff", blueDim: "rgba(77,148,255,0.12)",
  purple: "#a855f7", purpleDim: "rgba(168,85,247,0.12)",
  amber: "#f59e0b", amberDim: "rgba(245,158,11,0.12)",
  cyan: "#06b6d4", cyanDim: "rgba(6,182,212,0.12)",
  pink: "#ec4899", pinkDim: "rgba(236,72,153,0.12)",
};

const selectStyle = { background: c.card, border: `1px solid ${c.border}`, borderRadius: 8, padding: "6px 12px", color: c.text, fontSize: 12, outline: "none", cursor: "pointer", appearance: "auto" };
const inputStyle = { background: c.bg, border: `1px solid ${c.border}`, borderRadius: 8, padding: "8px 12px", color: c.text, fontSize: 14, outline: "none", fontFamily: "'JetBrains Mono', monospace" };
const navBtnStyle = { background: c.card, border: `1px solid ${c.border}`, borderRadius: 8, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", color: c.text, fontSize: 18, cursor: "pointer" };
const btnPrimary = { background: `linear-gradient(135deg, ${c.green}, #00b86e)`, border: "none", borderRadius: 10, padding: "10px 20px", color: "#000", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: 0.3 };
const btnSecondary = { background: "rgba(255,255,255,0.04)", border: `1px solid ${c.border}`, borderRadius: 10, padding: "10px 20px", color: c.text, fontSize: 13, fontWeight: 500, cursor: "pointer" };
const fieldLabel = { fontSize: 11, color: c.textDim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" };
const fieldInput = { ...inputStyle, width: "100%", fontSize: 13, padding: "9px 12px" };

const StatCard = ({ label, value, sub, color, spark }) => (
  <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 8, position: "relative", overflow: "hidden" }}>
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, transparent, ${color}, transparent)` }} />
    <span style={{ fontSize: 12, color: c.textDim, letterSpacing: 1.2, textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>{label}</span>
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
      <span style={{ fontSize: 28, fontWeight: 700, color: c.text, fontFamily: "'Space Grotesk', sans-serif", letterSpacing: -1 }}>{value}</span>
      {spark && <Sparkline data={spark} color={color} height={32} width={80} />}
    </div>
    {sub && <span style={{ fontSize: 12, color, fontFamily: "'JetBrains Mono', monospace" }}>{sub}</span>}
  </div>
);

export default function BettingTracker() {
  // ═══ PERSISTED USER DATA ═══
  const [bets, setBets] = usePersistedState("bets", []);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [filterSport, setFilterSport] = useState("All");
  const [filterLeague, setFilterLeague] = useState("All");
  const [filterType, setFilterType] = useState("All");
  const [selectedDay, setSelectedDay] = useState(null);
  const [taxOtherIncome, setTaxOtherIncome] = usePersistedState("taxOtherIncome", 0);
  const [taxFilingStatus, setTaxFilingStatus] = usePersistedState("taxFilingStatus", "single");
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear()));
  const [dashYear, setDashYear] = useState(String(new Date().getFullYear()));
  const [profitGoals, setProfitGoals] = usePersistedState("profitGoals", {}); // { "2026": { goal: 100000, targetMonth: 12 } }
  const [freeBetMode, setFreeBetMode] = usePersistedState("freeBetMode", "exclude"); // "exclude" | "include" — how to treat free bet losses
  const [showGoalEditor, setShowGoalEditor] = useState(false);
  const [goalForm, setGoalForm] = useState({ year: String(new Date().getFullYear()), goal: "", targetMonth: "12" });
  const [hoveredCumIdx, setHoveredCumIdx] = useState(null);
  const [evFocus, setEvFocus] = useState("combined"); // "pregame" | "live" | "combined"
  const [mcSeed, setMcSeed] = useState(42);
  const [dashPeriod, setDashPeriod] = useState("all"); // "month" | "ytd" | "all"
  const [scatterShowWins, setScatterShowWins] = useState(true);
  const [scatterShowLosses, setScatterShowLosses] = useState(true);
  const [scatterSport, setScatterSport] = useState("All");
  const [scatterType, setScatterType] = useState("All"); // "All" | "Live" | "Pre-game"
  const [expenses, setExpenses] = usePersistedState("expenses", []);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [expenseForm, setExpenseForm] = useState({ name: "", category: "software", amount: "", recurrence: "Monthly", startDate: new Date().toISOString().slice(0, 10), notes: "", active: true });
  const [expenseFilter, setExpenseFilter] = useState("all");
  const [importTab, setImportTab] = useState("csv");
  const [csvText, setCsvText] = useState("");
  const [csvPreview, setCsvPreview] = useState(null);
  const [importStatus, setImportStatus] = useState(null);

  // ── PROFILES ──
  const [profiles, setProfiles] = usePersistedState("profiles", [{ id: "cameron", name: "Cameron" }]);
  const [activeProfile, setActiveProfile] = usePersistedState("activeProfile", "cameron");
  const [importProfile, setImportProfile] = useState(() => profiles[0]?.id || "cameron");
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null); // profile id being edited
  const [editProfileName, setEditProfileName] = useState("");
  const [confirmDeleteProfile, setConfirmDeleteProfile] = useState(null); // profile id pending delete

  // ── BANKROLL ──
  const [bankrollEntries, setBankrollEntries] = usePersistedState("bankrollEntries", []);
  const [showAddBook, setShowAddBook] = useState(false);
  const [bookForm, setBookForm] = useState({ book: "", balance: "" });
  const [editingBook, setEditingBook] = useState(null);
  const [bankrollHistory, setBankrollHistory] = usePersistedState("bankrollHistory", []);
  const [showAddTxn, setShowAddTxn] = useState(false);
  const [txnForm, setTxnForm] = useState({ date: new Date().toISOString().slice(0, 10), type: "deposit", book: "", amount: "", note: "", purpose: "general" });
  // Manual expense-paid overrides: Set of "YYYY-MM" keys
  const [expensesPaidManual, setExpensesPaidManual] = usePersistedSet("expensesPaidManual", new Set());
  // Bank balance = cash on hand not deposited in any book
  const [bankBalances, setBankBalances] = usePersistedState("bankBalances", {});
  const [editingBankBal, setEditingBankBal] = useState(false);
  // Jan 1 starting bankroll per profile (books + bank combined)
  const [jan1Bankrolls, setJan1Bankrolls] = usePersistedState("jan1Bankrolls", {});
  const [editingJan1, setEditingJan1] = useState(false);
  // Profile notes — passwords, usernames, phone numbers, etc.
  const [profileNotes, setProfileNotes] = usePersistedState("profileNotes", {});
  const [showAddNote, setShowAddNote] = useState(false);
  const [noteForm, setNoteForm] = useState({ label: "", value: "", sensitive: false });
  const [revealedNotes, setRevealedNotes] = useState(new Set());
  // Sportsbook limits per profile
  const [bookLimits, setBookLimits] = usePersistedState("bookLimits", {});
  const [showAddLimit, setShowAddLimit] = useState(false);
  const [limitForm, setLimitForm] = useState({ book: "", sport: "All", limit: "", status: "limited", date: new Date().toISOString().slice(0, 10) });
  const [editingLimit, setEditingLimit] = useState(null);
  const [apiEndpoints, setApiEndpoints] = usePersistedState("apiEndpoints", [
    { id: 1, name: "The Odds API", url: "https://api.the-odds-api.com/v4/sports", key: "", sport: "All", active: false, lastSync: null, status: "disconnected" },
    { id: 2, name: "Pinnacle (via OpticOdds)", url: "https://api.opticodds.com/api/v3/odds/pinnacle", key: "", sport: "All", active: false, lastSync: null, status: "disconnected" },
    { id: 3, name: "Bookmaker.eu (via OpticOdds)", url: "https://api.opticodds.com/api/v3/odds/bookmaker", key: "", sport: "All", active: false, lastSync: null, status: "disconnected" },
    { id: 4, name: "BetOnline.ag (via OpticOdds)", url: "https://api.opticodds.com/api/v3/odds/betonline", key: "", sport: "All", active: false, lastSync: null, status: "disconnected" },
  ]);
  const [showAddApi, setShowAddApi] = useState(false);
  const [confirmClearBets, setConfirmClearBets] = useState(false);
  const [apiForm, setApiForm] = useState({ name: "", url: "", key: "", sport: "All", active: true });
  const fileInputRef = useRef(null);
  const w2gInputRef = useRef(null);
  const receiptInputRef = useRef(null);
  const quickReceiptRef = useRef(null);
  const receiptExpenseIdRef = useRef(null);

  // ─── W-2G DOCUMENTS ───
  const [w2gDocuments, setW2gDocuments] = usePersistedState("w2gDocuments", []);
  const [showAddW2g, setShowAddW2g] = useState(false);
  const [w2gForm, setW2gForm] = useState({ sportsbook: "", amount: "", date: new Date().toISOString().slice(0, 10), taxWithheld: "", notes: "" });
  const [w2gFiles, setW2gFiles] = useState([]); // temp files for current add

  // ─── RECEIPT ATTACHMENTS (keyed by expense id) ───
  const [expenseReceipts, setExpenseReceipts] = usePersistedState("expenseReceipts", {});

  // ─── EXPORT ───
  const [accountingExportYear, setAccountingExportYear] = useState(String(new Date().getFullYear()));

  // ─── UPDATE SYSTEM ───
  const [updateAvailable, setUpdateAvailable] = useState(null); // { version, notes, changelog, forceUpdate }
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const swRegistrationRef = useRef(null);

  useEffect(() => {
    // 1. Register service worker
    registerServiceWorker().then(reg => { swRegistrationRef.current = reg; });

    // 2. Listen for SW-level update detection
    const handleSWUpdate = () => {
      // SW found a new version — trigger version.json check too
      checkVersionEndpoint().then(data => {
        if (data && semverCompare(data.version, APP_VERSION) > 0) {
          setUpdateAvailable(data);
          setUpdateDismissed(false);
        }
      });
    };
    window.addEventListener("sw-update-available", handleSWUpdate);

    // 3. Also check version.json on load + interval (covers non-SW browsers)
    const checkUpdate = async () => {
      const data = await checkVersionEndpoint();
      if (data && semverCompare(data.version, APP_VERSION) > 0) {
        setUpdateAvailable(data);
        setUpdateDismissed(false);
      }
    };
    checkUpdate();
    const interval = setInterval(checkUpdate, UPDATE_CHECK_INTERVAL);

    // 4. Listen for visibility change — check when user returns to tab
    const handleVisibility = () => {
      if (!document.hidden) checkUpdate();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("sw-update-available", handleSWUpdate);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(interval);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    // Tell waiting SW to take over, then reload
    if (swRegistrationRef.current?.waiting) {
      swRegistrationRef.current.waiting.postMessage("SKIP_WAITING");
    }
    // Small delay to let SW activate before reload
    setTimeout(() => window.location.reload(), 300);
  }, []);

  const filtered = useMemo(() => bets.map(normalizeBet).filter(b => (activeProfile === "all" || (b.profile || profiles[0]?.id) === activeProfile) && (filterSport === "All" || b.sport === filterSport) && (filterLeague === "All" || b.league === filterLeague) && (filterType === "All" || b.type === filterType)), [bets, filterSport, filterLeague, filterType, activeProfile]);

  // Profile-only filtered bets (no sport/league/type filter) for calendar, monthly charts, goal
  const profileBets = useMemo(() => bets.map(normalizeBet).filter(b => activeProfile === "all" || (b.profile || profiles[0]?.id) === activeProfile), [bets, activeProfile]);

  // Reusable stats computation
  const computeStats = (betsList) => {
    const totalStake = betsList.reduce((s, b) => s + b.stake, 0);
    const totalProfit = betsList.reduce((s, b) => s + b.profit, 0);
    // Free bet adjusted profit: exclude losses on free bets (wins still count)
    const freeBetLosses = betsList.filter(b => b.freeBet && b.result === "lost").reduce((s, b) => s + b.profit, 0);
    const freeBetCount = betsList.filter(b => b.freeBet).length;
    const adjustedProfit = totalProfit - freeBetLosses; // removes negative losses = adds them back
    const wins = betsList.filter(b => b.result === "won").length;
    const pushes = betsList.filter(b => b.result === "push").length;
    const losses = betsList.filter(b => b.result === "lost").length;
    const graded = wins + losses; // exclude pushes from win rate denominator
    const roi = totalStake ? (totalProfit / totalStake) * 100 : 0;
    const clvEligible = betsList.filter(b => !b.parlay && !b.noClosingLine && b.type !== "Parlay" && b.type !== "Round Robin");
    const clvBets = clvEligible.map(b => ({ ...b, clv: ((impliedProb(b.closingOdds) - impliedProb(b.odds)) / impliedProb(b.odds)) * 100 }));
    const avgCLV = clvBets.length ? clvBets.reduce((s, b) => s + b.clv, 0) / clvBets.length : 0;
    const dailyPL = {};
    betsList.forEach(b => { dailyPL[b.date] = (dailyPL[b.date] || 0) + b.profit; });
    let cum = 0;
    const cumulative = Object.keys(dailyPL).sort().map(d => { cum += dailyPL[d]; return cum; });
    const bySport = {}, byBook = {}, byLeague = {};
    betsList.forEach(b => {
      const league = b.league || b.sport || "Other";
      const sport = b.sport || "Other";
      if (!byLeague[league]) byLeague[league] = { profit: 0, count: 0, wins: 0, pushes: 0, stake: 0, sport };
      byLeague[league].profit += b.profit; byLeague[league].count++; byLeague[league].stake += b.stake;
      if (b.result === "won") byLeague[league].wins++;
      if (b.result === "push") byLeague[league].pushes++;
      if (!bySport[sport]) bySport[sport] = { profit: 0, count: 0, wins: 0, pushes: 0, stake: 0 };
      bySport[sport].profit += b.profit; bySport[sport].count++; bySport[sport].stake += b.stake;
      if (b.result === "won") bySport[sport].wins++;
      if (b.result === "push") bySport[sport].pushes++;
      if (!byBook[b.sportsbook]) byBook[b.sportsbook] = { profit: 0, count: 0 };
      byBook[b.sportsbook].profit += b.profit; byBook[b.sportsbook].count++;
    });
    let streak = 0, streakType = "";
    for (let i = betsList.length - 1; i >= 0; i--) {
      if (betsList[i].result === "push") continue; // skip pushes in streak calc
      if (!streakType) { streakType = betsList[i].result; streak = 1; }
      else if (betsList[i].result === streakType) streak++;
      else break;
    }
    const dayEntries = Object.entries(dailyPL);
    const bestDay = dayEntries.length ? dayEntries.reduce((a, b) => b[1] > a[1] ? b : a) : ["—", 0];
    const worstDay = dayEntries.length ? dayEntries.reduce((a, b) => b[1] < a[1] ? b : a) : ["—", 0];
    return { total: betsList.length, wins, losses, pushes, winRate: graded ? (wins / graded) * 100 : 0, totalStake, totalProfit, adjustedProfit, freeBetCount, freeBetLosses, roi, avgCLV, clvBets, dailyPL, cumulative, bySport, byLeague, byBook, streak, streakType, bestDay, worstDay, avgStake: betsList.length ? totalStake / betsList.length : 0 };
  };

  // Full stats for strategy tab, MC sim, etc.
  const stats = useMemo(() => computeStats(filtered), [filtered]);

  // Dashboard period filter
  const dashFiltered = useMemo(() => {
    if (dashPeriod === "all") return filtered;
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    if (dashPeriod === "month") {
      const prefix = `${year}-${month}`;
      return filtered.filter(b => b.date.startsWith(prefix));
    }
    // ytd
    return filtered.filter(b => b.date.startsWith(String(year)));
  }, [filtered, dashPeriod]);

  const dashStats = useMemo(() => computeStats(dashFiltered), [dashFiltered]);

  const taxStats = useMemo(() => {
    const taxBets = taxYear === "all" ? bets : bets.filter(b => b.date.startsWith(taxYear));
    const grossWinnings = taxBets.filter(b => b.result === "won").reduce((s, b) => s + b.payout, 0);
    const totalLosses = taxBets.filter(b => b.result === "lost").reduce((s, b) => s + b.stake, 0);
    const netGambling = grossWinnings - totalLosses;
    const taxableGambling = Math.max(0, netGambling);
    const totalIncome = taxOtherIncome + taxableGambling;
    const taxWithGambling = calcTax(totalIncome);
    const gamblingTax = taxWithGambling - calcTax(taxOtherIncome);
    const effectiveRate = taxableGambling ? (gamblingTax / taxableGambling) * 100 : 0;
    return { grossWinnings, totalLosses, netGambling, taxableGambling, totalIncome, taxWithGambling, gamblingTax, effectiveRate, quarterlyEstimate: gamblingTax / 4, betCount: taxBets.length };
  }, [bets, taxOtherIncome, taxYear]);

  const expenseStats = useMemo(() => {
    const active = expenses.filter(e => e.active);
    const annualized = active.reduce((sum, e) => {
      const amt = parseFloat(e.amount) || 0;
      switch (e.recurrence) { case "Weekly": return sum + amt * 52; case "Monthly": return sum + amt * 12; case "Quarterly": return sum + amt * 4; case "Annually": return sum + amt; default: return sum + amt; }
    }, 0);
    const monthlyBurn = active.reduce((sum, e) => {
      const amt = parseFloat(e.amount) || 0;
      switch (e.recurrence) { case "Weekly": return sum + amt * 4.33; case "Monthly": return sum + amt; case "Quarterly": return sum + amt / 3; case "Annually": return sum + amt / 12; default: return sum; }
    }, 0);
    const oneTimeTotal = expenses.filter(e => e.recurrence === "One-time").reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const byCategory = {};
    active.forEach(e => {
      const cat = EXPENSE_CATEGORIES.find(ec => ec.id === e.category) || { label: e.category, icon: "○" };
      const amt = parseFloat(e.amount) || 0;
      let annual;
      switch (e.recurrence) { case "Weekly": annual = amt * 52; break; case "Monthly": annual = amt * 12; break; case "Quarterly": annual = amt * 4; break; case "Annually": annual = amt; break; default: annual = amt; }
      if (!byCategory[e.category]) byCategory[e.category] = { label: cat.label, icon: cat.icon, total: 0, count: 0 };
      byCategory[e.category].total += annual; byCategory[e.category].count++;
    });
    return { annualized, monthlyBurn, oneTimeTotal, byCategory, netAfterExpenses: stats.totalProfit - annualized, activeCount: active.length, totalCount: expenses.length };
  }, [expenses, stats.totalProfit]);

  // EV & Variance analysis: CLV-based EV for pre-game (with real CLV only), assumed 5% for live
  const evStats = useMemo(() => {
    const LIVE_EV_EDGE = 0.05; // assumed 5% edge on live bets
    // Pre-game with real closing lines (exclude parlays, RR, and fabricated CLV)
    const preGame = filtered.filter(b => b.type !== "Live" && !b.parlay && !b.noClosingLine && b.type !== "Parlay" && b.type !== "Round Robin");
    const live = filtered.filter(b => b.type === "Live");

    // Pre-game: EV derived from CLV
    // CLV% = (closeProb - openProb) / openProb
    // Expected profit per bet = CLV% * stake (simplified: if you have X% edge, expected profit is X% of stake)
    const preGameAnalysis = preGame.map(b => {
      const openProb = impliedProb(b.odds);
      const closeProb = impliedProb(b.closingOdds);
      const clvPct = (closeProb - openProb) / openProb; // decimal, e.g. 0.03 = 3%
      const expectedProfit = clvPct * b.stake;
      return { ...b, isLive: false, clvPct, expectedProfit, actualProfit: b.profit, variance: b.profit - expectedProfit };
    });

    // Live: assumed flat 5% EV
    const liveAnalysis = live.map(b => {
      const expectedProfit = LIVE_EV_EDGE * b.stake;
      return { ...b, isLive: true, clvPct: LIVE_EV_EDGE, expectedProfit, actualProfit: b.profit, variance: b.profit - expectedProfit };
    });

    const all = [...preGameAnalysis, ...liveAnalysis];
    const totalExpected = all.reduce((s, b) => s + b.expectedProfit, 0);
    const totalActual = all.reduce((s, b) => s + b.actualProfit, 0);
    const totalVariance = totalActual - totalExpected;

    // Pre-game aggregates
    const pgExpected = preGameAnalysis.reduce((s, b) => s + b.expectedProfit, 0);
    const pgActual = preGameAnalysis.reduce((s, b) => s + b.actualProfit, 0);
    const pgStake = preGameAnalysis.reduce((s, b) => s + b.stake, 0);
    const pgAvgClv = preGameAnalysis.length ? preGameAnalysis.reduce((s, b) => s + b.clvPct, 0) / preGameAnalysis.length * 100 : 0;

    // Live aggregates
    const liveExpected = liveAnalysis.reduce((s, b) => s + b.expectedProfit, 0);
    const liveActual = liveAnalysis.reduce((s, b) => s + b.actualProfit, 0);
    const liveStake = liveAnalysis.reduce((s, b) => s + b.stake, 0);

    // Monthly EV vs Actual for chart — combined + per-category
    const monthlyEv = {}, monthlyPg = {}, monthlyLv = {};
    preGameAnalysis.forEach(b => {
      const key = b.date.slice(0, 7);
      if (!monthlyPg[key]) monthlyPg[key] = { expected: 0, actual: 0 };
      monthlyPg[key].expected += b.expectedProfit;
      monthlyPg[key].actual += b.actualProfit;
    });
    liveAnalysis.forEach(b => {
      const key = b.date.slice(0, 7);
      if (!monthlyLv[key]) monthlyLv[key] = { expected: 0, actual: 0 };
      monthlyLv[key].expected += b.expectedProfit;
      monthlyLv[key].actual += b.actualProfit;
    });
    all.forEach(b => {
      const key = b.date.slice(0, 7);
      if (!monthlyEv[key]) monthlyEv[key] = { expected: 0, actual: 0 };
      monthlyEv[key].expected += b.expectedProfit;
      monthlyEv[key].actual += b.actualProfit;
    });
    // All unique months sorted
    const allMonths = [...new Set([...Object.keys(monthlyEv), ...Object.keys(monthlyPg), ...Object.keys(monthlyLv)])].sort();
    const buildCum = (src) => {
      let ce = 0, ca = 0;
      return allMonths.map(key => {
        const d = src[key] || { expected: 0, actual: 0 };
        ce += d.expected; ca += d.actual;
        const [y, m] = key.split("-");
        return { key, label: `${MONTHS[parseInt(m) - 1]} ${y.slice(2)}`, cumExpected: ce, cumActual: ca, cumVariance: ca - ce };
      });
    };
    const cumCombined = buildCum(monthlyEv);
    const cumPreGame = buildCum(monthlyPg);
    const cumLive = buildCum(monthlyLv);

    return {
      preGame: { count: preGame.length, stake: pgStake, expected: pgExpected, actual: pgActual, variance: pgActual - pgExpected, avgClv: pgAvgClv },
      live: { count: live.length, stake: liveStake, expected: liveExpected, actual: liveActual, variance: liveActual - liveExpected, edge: LIVE_EV_EDGE * 100 },
      total: { count: all.length, expected: totalExpected, actual: totalActual, variance: totalVariance },
      cumCombined, cumPreGame, cumLive,
      all,
    };
  }, [filtered]);

  // ─── MEMOIZED MONTE CARLO ───
  const mcData = useMemo(() => {
    if (filtered.length < 20) return null;
    const n = filtered.length;
    const wr = stats.winRate / 100;
    const avgWinPay = filtered.filter(b => b.result === "won").reduce((s, b) => s + b.profit, 0) / (stats.wins || 1);
    const avgLossPay = filtered.filter(b => b.result === "lost").reduce((s, b) => s + b.profit, 0) / (stats.losses || 1);

    const sims = 2000;
    const paths = [];
    let s = mcSeed;
    const rand = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

    const percentiles = { p5: [], p25: [], p50: [], p75: [], p95: [] };
    const checkpoints = 20;
    const step = Math.max(1, Math.floor(n / checkpoints));
    const cpIndices = Array.from({ length: checkpoints }, (_, i) => Math.min(n, (i + 1) * step));
    const cpSet = new Set(cpIndices);

    for (let sim = 0; sim < sims; sim++) {
      let cum = 0;
      const cpVals = [];
      for (let bet = 1; bet <= n; bet++) {
        cum += rand() < wr ? avgWinPay : avgLossPay;
        if (cpSet.has(bet)) cpVals.push(cum);
      }
      paths.push(cpVals);
    }

    for (let cp = 0; cp < checkpoints; cp++) {
      const vals = paths.map(p => p[cp]).sort((a, b) => a - b);
      percentiles.p5.push(vals[Math.floor(sims * 0.05)]);
      percentiles.p25.push(vals[Math.floor(sims * 0.25)]);
      percentiles.p50.push(vals[Math.floor(sims * 0.5)]);
      percentiles.p75.push(vals[Math.floor(sims * 0.75)]);
      percentiles.p95.push(vals[Math.floor(sims * 0.95)]);
    }

    const sortedBets = [...filtered].sort((a, b) => a.date.localeCompare(b.date));
    const actualAtCp = [];
    let cumActual = 0, betIdx = 0;
    for (const cpI of cpIndices) {
      while (betIdx < cpI && betIdx < sortedBets.length) { cumActual += sortedBets[betIdx].profit; betIdx++; }
      actualAtCp.push(cumActual);
    }

    const allVals = [...percentiles.p5, ...percentiles.p95, ...actualAtCp];
    const minY = Math.min(...allVals);
    const maxY = Math.max(...allVals);
    const range = maxY - minY || 1;
    const W = 700, H = 220, padL = 0, padR = 10, padT = 10, padB = 20;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const toX = (i) => padL + (i / (checkpoints - 1)) * chartW;
    const toY = (v) => padT + (1 - (v - minY) / range) * chartH;
    const makePath = (arr) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");
    const makeArea = (top, bot) => {
      const fwd = top.map((v, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");
      const rev = [...bot].reverse().map((v, i) => `L${toX(bot.length - 1 - i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");
      return fwd + " " + rev + " Z";
    };

    const finalActual = actualAtCp[actualAtCp.length - 1];
    const finalVals = paths.map(p => p[p.length - 1]).sort((a, b) => a - b);
    const actualPercentile = (finalVals.filter(v => v <= finalActual).length / sims * 100).toFixed(0);

    return {
      sims, n, wr, checkpoints, cpIndices, percentiles, actualAtCp, finalActual, actualPercentile,
      W, H, padL, padR, toX, toY,
      area95: makeArea(percentiles.p95, percentiles.p5),
      area75: makeArea(percentiles.p75, percentiles.p25),
      pathP50: makePath(percentiles.p50),
      pathP5: makePath(percentiles.p5),
      pathP95: makePath(percentiles.p95),
      pathActual: makePath(actualAtCp),
    };
  }, [filtered, stats.winRate, stats.wins, stats.losses, mcSeed]);

  const filteredExpenses = useMemo(() => expenses.filter(e => {
    if (expenseFilter === "recurring") return e.recurrence !== "One-time";
    if (expenseFilter === "one-time") return e.recurrence === "One-time";
    if (expenseFilter === "active") return e.active;
    if (expenseFilter === "inactive") return !e.active;
    return true;
  }), [expenses, expenseFilter]);

  const calendarData = useMemo(() => {
    const firstDay = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dayBets = profileBets.filter(b => b.date === dateStr);
      cells.push({ day: d, date: dateStr, bets: dayBets, profit: dayBets.reduce((s, b) => s + b.profit, 0) });
    }
    return cells;
  }, [profileBets, calMonth, calYear]);

  const maxAbsProfit = useMemo(() => Math.max(1, ...calendarData.filter(Boolean).map(c => Math.abs(c.profit))), [calendarData]);

  // Monthly profit data for dashboard charts
  const monthlyData = useMemo(() => {
    const yearBets = dashYear === "all" ? profileBets : profileBets.filter(b => b.date.startsWith(dashYear));
    const byMonth = {};
    yearBets.forEach(b => {
      const key = b.date.slice(0, 7); // YYYY-MM
      if (!byMonth[key]) byMonth[key] = { profit: 0, bets: 0, wins: 0, pushes: 0, stake: 0 };
      byMonth[key].profit += b.profit; byMonth[key].bets++; byMonth[key].stake += b.stake;
      if (b.result === "won") byMonth[key].wins++;
      if (b.result === "push") byMonth[key].pushes++;
    });
    const sorted = Object.keys(byMonth).sort();
    let cum = 0;
    const months = sorted.map(key => {
      const d = byMonth[key];
      cum += d.profit;
      const [y, m] = key.split("-");
      const graded = d.bets - d.pushes;
      return { key, label: `${MONTHS[parseInt(m) - 1]} ${y.slice(2)}`, profit: Math.round(d.profit * 100) / 100, cumulative: Math.round(cum * 100) / 100, bets: d.bets, wins: d.wins, pushes: d.pushes, stake: d.stake, winRate: graded ? (d.wins / graded * 100) : 0, roi: d.stake ? (d.profit / d.stake * 100) : 0 };
    });
    return months;
  }, [profileBets, dashYear]);

  // Current month profit for dashboard card
  const currentMonthProfit = useMemo(() => {
    const now = "2026-02"; // current month
    return profileBets.filter(b => b.date.startsWith(now)).reduce((s, b) => s + b.profit, 0);
  }, [profileBets]);

  // Available years for switcher
  const availableYears = useMemo(() => {
    const years = new Set(bets.map(b => b.date.slice(0, 4)));
    years.add(String(new Date().getFullYear()));
    return [...years].sort();
  }, [bets]);

  const resetExpenseForm = () => { setExpenseForm({ name: "", category: "software", amount: "", recurrence: "Monthly", startDate: new Date().toISOString().slice(0, 10), notes: "", active: true }); setEditingExpense(null); setShowAddExpense(false); setFormReceipts([]); };

  // ─── PROFIT GOAL PROJECTION ───
  const goalProjection = useMemo(() => {
    const year = String(new Date().getFullYear());
    const goal = profitGoals[year];
    if (!goal || !goal.goal) return null;

    const targetAmount = goal.goal;
    const targetMonth = goal.targetMonth || 12; // 1-12
    const now = new Date();

    // Year boundaries
    const yearStart = new Date(parseInt(year), 0, 1);
    const targetEnd = new Date(parseInt(year), targetMonth, 0); // last day of target month
    const totalDays = Math.ceil((targetEnd - yearStart) / 86400000);
    const elapsedDays = Math.max(1, Math.ceil((now - yearStart) / 86400000));
    const remainingDays = Math.max(0, Math.ceil((targetEnd - now) / 86400000));

    // Current year bets (using free bet mode)
    const yearBets = profileBets.filter(b => b.date.startsWith(year));
    const currentProfit = freeBetMode === "exclude"
      ? yearBets.reduce((s, b) => s + (b.freeBet && b.result === "lost" ? 0 : b.profit), 0)
      : yearBets.reduce((s, b) => s + b.profit, 0);

    // Daily rate
    const dailyRate = currentProfit / elapsedDays;
    const projectedTotal = dailyRate * totalDays;
    const neededRemaining = targetAmount - currentProfit;
    const neededDailyRate = remainingDays > 0 ? neededRemaining / remainingDays : Infinity;
    const pctComplete = Math.min(100, (currentProfit / targetAmount) * 100);
    const pctTimeElapsed = (elapsedDays / totalDays) * 100;
    const onPace = currentProfit >= (dailyRate > 0 ? targetAmount * (elapsedDays / totalDays) : 0);
    const goalPace = targetAmount * (elapsedDays / totalDays);

    // Forward Monte Carlo: simulate remaining betting period
    const realBets = yearBets.filter(b => b.result !== "push" && !(b.freeBet && b.result === "lost"));
    const wins = realBets.filter(b => b.result === "won");
    const losses = realBets.filter(b => b.result === "lost");
    if (realBets.length < 10 || remainingDays <= 0) {
      return {
        targetAmount, targetMonth, currentProfit, dailyRate, projectedTotal,
        neededRemaining, neededDailyRate, pctComplete, pctTimeElapsed, onPace, goalPace,
        elapsedDays, remainingDays, totalDays, yearBets: yearBets.length,
        mc: null,
      };
    }

    const wr = wins.length / realBets.length;
    const avgWin = wins.reduce((s, b) => s + b.profit, 0) / (wins.length || 1);
    const avgLoss = losses.reduce((s, b) => s + b.profit, 0) / (losses.length || 1);
    const betsPerDay = realBets.length / elapsedDays;
    const remainingBets = Math.round(betsPerDay * remainingDays);
    // Variance of single bet
    const singleBetVar = realBets.reduce((s, b) => s + Math.pow(b.profit - (wr * avgWin + (1 - wr) * avgLoss), 2), 0) / realBets.length;
    const singleBetStd = Math.sqrt(singleBetVar);

    const sims = 3000;
    const finals = [];
    let s = 7919; // seed
    const rand = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

    for (let sim = 0; sim < sims; sim++) {
      let total = currentProfit;
      for (let j = 0; j < remainingBets; j++) {
        total += rand() < wr ? avgWin : avgLoss;
      }
      finals.push(total);
    }
    finals.sort((a, b) => a - b);
    const p5 = finals[Math.floor(sims * 0.05)];
    const p25 = finals[Math.floor(sims * 0.25)];
    const p50 = finals[Math.floor(sims * 0.50)];
    const p75 = finals[Math.floor(sims * 0.75)];
    const p95 = finals[Math.floor(sims * 0.95)];
    const hitGoalPct = (finals.filter(v => v >= targetAmount).length / sims * 100);

    // New projected annual if beating goal
    const newProjected = p50;

    return {
      targetAmount, targetMonth, currentProfit, dailyRate, projectedTotal,
      neededRemaining, neededDailyRate, pctComplete, pctTimeElapsed, onPace, goalPace,
      elapsedDays, remainingDays, totalDays, yearBets: yearBets.length,
      mc: { p5, p25, p50, p75, p95, hitGoalPct, remainingBets, sims, wr, avgWin, avgLoss, singleBetStd, newProjected, finals },
    };
  }, [profileBets, profitGoals, freeBetMode]);
  const [formReceipts, setFormReceipts] = useState([]); // temp receipts for current form
  const handleFormReceiptUpload = (e) => {
    Array.from(e.target.files || []).forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => { setFormReceipts(prev => [...prev, { id: Date.now() + Math.random(), name: file.name, data: ev.target.result, type: file.type, size: file.size }]); };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };
  const saveExpense = () => {
    if (!expenseForm.name || !expenseForm.amount) return;
    const eid = editingExpense || Date.now();
    if (editingExpense) {
      setExpenses(prev => prev.map(e => e.id === editingExpense ? { ...expenseForm, id: editingExpense, amount: parseFloat(expenseForm.amount) } : e));
      // Append any new receipts
      if (formReceipts.length > 0) setExpenseReceipts(prev => ({ ...prev, [editingExpense]: [...(prev[editingExpense] || []), ...formReceipts] }));
    } else {
      setExpenses(prev => [...prev, { ...expenseForm, id: eid, amount: parseFloat(expenseForm.amount) }]);
      if (formReceipts.length > 0) setExpenseReceipts(prev => ({ ...prev, [eid]: formReceipts }));
    }
    resetExpenseForm();
  };

  // Decimal odds to American conversion
  const decToAmerican = (dec) => {
    if (!dec || dec <= 1) return 0;
    return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
  };

  const parseCSV = (text) => {
    try {
      const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return null;
      const splitRow = (line) => {
        const result = [];
        let current = "", inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') { inQuotes = !inQuotes; }
          else if ((ch === "," || ch === "\t") && !inQuotes) { result.push(current.trim()); current = ""; }
          else { current += ch; }
        }
        result.push(current.trim());
        return result;
      };
      const headers = splitRow(lines[0]).map(h => h.toLowerCase().replace(/['"]/g, "").trim());
      const rows = lines.slice(1).map(line => {
        const vals = splitRow(line);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (vals[i] || "").replace(/['"]/g, "").trim(); });
        return obj;
      }).filter(row => Object.values(row).some(v => v !== ""));
      return rows.length > 0 ? { headers, rows } : null;
    } catch (e) { return null; }
  };

  // Detect if CSV matches the user's transaction format
  const isTransactionCSV = (headers) => headers.includes("bet_id") && headers.includes("status") && headers.includes("bet_info");

  // Detect Polymarket CSV format
  const isPolymarketCSV = (headers) => headers.includes("marketname") && headers.includes("action") && headers.includes("usdcamount") && headers.includes("tokenamount");

  // Polymarket import — aggregates Buy/Sell/Redeem into settled positions
  const autoImportPolymarket = (parsed) => {
    const ts = Date.now();
    // Sort rows chronologically
    const rows = [...parsed.rows].sort((a, b) => parseInt(a.timestamp || 0) - parseInt(b.timestamp || 0));
    const positions = {}; // (market|token) → { stake, tokens, first_ts, sell_proceeds }
    const settled = [];

    for (const row of rows) {
      const action = (row.action || "").trim();
      const market = (row.marketname || "").trim();
      const token = (row.tokenname || "").trim();
      const usdc = Math.abs(parseFloat(row.usdcamount) || 0);
      const tkns = parseFloat(row.tokenamount) || 0;
      const rowTs = parseInt(row.timestamp) || 0;
      if (action === "Deposit" || !market) continue;

      const key = `${market}|${token}`;

      if (action === "Buy") {
        if (!positions[key]) positions[key] = { stake: 0, tokens: 0, first_ts: rowTs, sell_proceeds: 0, market, token };
        positions[key].stake += usdc;
        positions[key].tokens += tkns;
      } else if (action === "Sell") {
        if (positions[key]) {
          const pos = positions[key];
          pos.tokens -= tkns;
          pos.sell_proceeds += usdc;
          if (pos.tokens < 0.01) {
            const profit = pos.sell_proceeds - pos.stake;
            settled.push({ market, token, stake: pos.stake, payout: pos.sell_proceeds, profit, result: "push", ts: rowTs, open_ts: pos.first_ts, avgPrice: pos.stake / (pos.stake + profit) || 0 });
            delete positions[key];
          }
        }
      } else if (action === "Redeem") {
        // Redeems have no token name — match by market
        const matching = Object.entries(positions).filter(([k]) => k.startsWith(market + "|"));
        if (matching.length > 0) {
          const [mKey, pos] = matching[0];
          if (usdc > 0) {
            settled.push({ market, token: pos.token, stake: pos.stake, payout: usdc, profit: usdc - pos.stake, result: "won", ts: rowTs, open_ts: pos.first_ts, avgPrice: pos.stake / pos.tokens || 0 });
          } else {
            settled.push({ market, token: pos.token, stake: pos.stake, payout: 0, profit: -pos.stake, result: "lost", ts: rowTs, open_ts: pos.first_ts, avgPrice: pos.stake / pos.tokens || 0 });
          }
          delete positions[mKey];
        }
      }
    }

    // Convert settled positions to bet objects (always profile: "cameron")
    let imported = 0;
    const existingBids = new Set(bets.filter(b => b.bid).map(b => b.bid));
    const newBets = settled.map((s, i) => {
      const bid = `poly_${s.open_ts}_${i}`;
      if (existingBids.has(bid)) return null;
      existingBids.add(bid);
      // Parse bet type from market name
      let betType = "Moneyline", event = s.market, pick = s.token;
      if (/O\/U\s+[\d.]+/i.test(s.market)) betType = "Over/Under";
      else if (/Spread/i.test(s.market)) betType = "Spread";
      else if (/1H\s+O\/U/i.test(s.market)) betType = "Over/Under";
      // Detect sport from market name
      const marketLower = s.market.toLowerCase();
      let sport = "Other", league = "Other";
      if (/nba|celtics|knicks|cavaliers|pacers|warriors|timberwolves|thunder|spurs|trail blazers|kings|bulls|lakers|nets|heat|hawks|rockets|grizzlies|suns|nuggets|bucks|clippers|76ers|pistons|magic|raptors|wizards|hornets|jazz|pelicans/i.test(marketLower)) { sport = "Basketball"; league = "NBA"; }
      else if (/nfl|patriots|bills|seahawks|rams|bears|ravens|steelers|panthers|buccaneers|falcons|eagles|chiefs|49ers|cowboys|packers|dolphins|jets|broncos|raiders|chargers|bengals|browns|texans|colts|jaguars|titans|lions|vikings|saints|cardinals|commanders/i.test(marketLower)) { sport = "Football"; league = "NFL"; }
      else if (/nhl|devils|rangers|bruins|maple leafs|canadiens|senators|penguins|flyers|capitals|hurricanes|blue jackets|islanders|panthers|lightning|red wings|sabres|jets|wild|predators|blackhawks|avalanche|blues|stars|kraken|flames|oilers|canucks|sharks|knights|coyotes|ducks|kings/i.test(marketLower)) { sport = "Hockey"; league = "NHL"; }
      else if (/ncaa|volunteers|crimson|hawkeyes|buckeyes|trojans|texans.*thunderbirds|ohio state|usc|iowa|alabama|tennessee/i.test(marketLower)) { sport = marketLower.includes("basket") || /O\/U\s+[12]\d{2}/i.test(s.market) ? "Basketball" : "Football"; league = sport === "Basketball" ? "NCAAB" : "NCAAF"; }
      // Decimal odds from avg price (price = cost per token, odds = 1/price)
      const decOdds = s.avgPrice > 0 && s.avgPrice < 1 ? 1 / s.avgPrice : 0;
      const americanOdds = decOdds > 1 ? decToAmerican(decOdds) : 0;
      // EST date from unix timestamp
      const estDate = new Date((s.open_ts - 5 * 3600) * 1000).toISOString().slice(0, 10);
      imported++;
      return {
        bid, id: ts + i, date: estDate, sport, league, type: betType,
        event, pick, odds: americanOdds, closingOdds: 0, stake: Math.round(s.stake * 100) / 100,
        result: s.result, payout: s.result === "won" ? Math.round(s.payout * 100) / 100 : 0,
        profit: Math.round(s.profit * 100) / 100,
        sportsbook: "Polymarket", profile: "cameron",
        noClosingLine: true,
        ...(s.result === "push" && { cashOut: true }),
      };
    }).filter(Boolean);

    const openCount = Object.keys(positions).length;
    const openExposure = Object.values(positions).reduce((s, p) => s + p.stake, 0);

    if (newBets.length > 0) {
      setBets(prev => [...prev, ...newBets].sort((a, b) => a.date.localeCompare(b.date)));
      const parts = [`Imported ${imported} Polymarket positions`];
      parts.push(`${settled.filter(s => s.result === "won").length}W ${settled.filter(s => s.result === "lost").length}L ${settled.filter(s => s.result === "push").length} cash-outs`);
      if (openCount > 0) parts.push(`${openCount} open ($${openExposure.toFixed(0)} exposure) skipped`);
      setImportStatus({ type: "success", message: parts.join(" · ") });
    } else {
      setImportStatus({ type: "error", message: openCount > 0 ? `No settled positions found (${openCount} still open)` : "No positions found in CSV" });
    }
    setCsvText(""); setCsvPreview(null);
    setTimeout(() => setImportStatus(null), 6000);
  };

  // Comprehensive live detection — multiple heuristics
  const detectLive = (row) => {
    const info = row.bet_info || "";
    // Rule 1: Explicit "Live" keyword in bet_info
    if (/\bLive\b/i.test(info)) return { live: true, reason: "keyword" };
    // Rule 2: Bet105 settles instantly (exchange/live book)
    if ((row.sportsbook || "") === "Bet105") return { live: true, reason: "bet105" };
    // Rule 3: Mid-game period markers (2nd half, 3rd quarter, etc.)
    if (/2nd Half|3rd Quarter|4th Quarter|2nd Quarter|2nd Period|3rd Period|4th Period|2nd Set|3rd Set/i.test(info)) return { live: true, reason: "period" };
    // Rule 4: Time gap heuristic — if placed-to-settled < 90 min, likely live
    try {
      const placed = new Date(row.time_placed_iso || row.time_placed);
      const settled = new Date(row.time_settled_iso || row.time_settled);
      const gapMin = (settled - placed) / 60000;
      if (gapMin > 0 && gapMin < 90) return { live: true, reason: "time_gap" };
    } catch {}
    return { live: false, reason: "pregame" };
  };

  // Parse bet_info string into event, pick, betType
  const parseBetInfo = (info) => {
    if (!info) return { event: "Unknown", pick: "—", betType: "Moneyline" };
    let betType = "Moneyline";
    if (/Spread|Handicap|Point spread/i.test(info)) betType = "Spread";
    else if (/Total|Over|Under|O\/U/i.test(info)) betType = "Over/Under";
    else if (/TD Scorer|Touchdown|Points|Rebounds|Assists|Fantasy|Receptions|Rushing|Receiving|Pass.*Yards|Tackles|Hits|Strikeout|Home Run/i.test(info)) betType = "Prop";
    else if (/Coin Toss|Novelty|MVP|Anthem|Winner \(2 way\)/i.test(info)) betType = "Prop";
    else if (/Moneyline|Winner|Money Line/i.test(info)) betType = "Moneyline";
    const vsMatch = info.match(/([A-Z][a-zA-Z\s.']+?)\s+(?:@|vs\.?|at|v)\s+([A-Z][a-zA-Z\s.']+?)(?:\s*$|,,)/);
    const event = vsMatch ? `${vsMatch[1].trim()} vs ${vsMatch[2].trim()}` : info.slice(0, 60);
    const pick = info.split(/\s+(?:@|vs\.?|at)\s+/)[0]?.slice(0, 50) || info.slice(0, 40);
    return { event, pick, betType };
  };

  // Map sport/league strings from CSV to our taxonomy → { sport, league }
  const mapSportLeague = (sportStr, leagueStr) => {
    const s = (sportStr || "").toLowerCase().trim();
    const l = (leagueStr || "").toLowerCase().trim();
    // Check BOTH fields — CSVs often put league names in the sport column
    const both = l + " " + s;
    // Basketball
    if (/\bncaaw\b/.test(both) || /\bncaa\s*w\b/.test(both)) return { sport: "Basketball", league: "NCAAW" };
    if (/\bncaam?\b/.test(both) || /\bncaab\b/.test(both) || /\bcollege basketball\b/.test(both)) return { sport: "Basketball", league: "NCAAB" };
    if (/\bwnba\b/.test(both)) return { sport: "Basketball", league: "WNBA" };
    if (/\beuro\s*league\b/.test(both)) return { sport: "Basketball", league: "EuroLeague" };
    if (/\bnba\b/.test(both)) return { sport: "Basketball", league: "NBA" };
    // Football
    if (/\bncaaf\b/.test(both) || /\bncaafb\b/.test(both) || /\bcfb\b/.test(both) || /\bcollege football\b/.test(both)) return { sport: "Football", league: "NCAAF" };
    if (/\bcfl\b/.test(both)) return { sport: "Football", league: "CFL" };
    if (/\bxfl\b/.test(both)) return { sport: "Football", league: "XFL" };
    if (/\busfl\b/.test(both)) return { sport: "Football", league: "USFL" };
    if (/\bnfl\b/.test(both)) return { sport: "Football", league: "NFL" };
    // Baseball
    if (/\bmlb\b/.test(both)) return { sport: "Baseball", league: "MLB" };
    if (/\bkbo\b/.test(both)) return { sport: "Baseball", league: "KBO" };
    if (/\bnpb\b/.test(both)) return { sport: "Baseball", league: "NPB" };
    // Hockey
    if (/\bnhl\b/.test(both)) return { sport: "Hockey", league: "NHL" };
    // Soccer
    if (/\bepl\b/.test(both) || /\bpremier league\b/.test(both)) return { sport: "Soccer", league: "EPL" };
    if (/\bmls\b/.test(both)) return { sport: "Soccer", league: "MLS" };
    if (/\bla\s*liga\b/.test(both)) return { sport: "Soccer", league: "La Liga" };
    if (/\bchampions league\b/.test(both) || /\bucl\b/.test(both)) return { sport: "Soccer", league: "Champions League" };
    if (/\bserie a\b/.test(both)) return { sport: "Soccer", league: "Serie A" };
    if (/\bbundesliga\b/.test(both)) return { sport: "Soccer", league: "Bundesliga" };
    if (/\bligue 1\b/.test(both)) return { sport: "Soccer", league: "Ligue 1" };
    if (/\bliga mx\b/.test(both)) return { sport: "Soccer", league: "Liga MX" };
    // MMA
    if (/\bufc\b/.test(both)) return { sport: "MMA", league: "UFC" };
    if (/\bbellator\b/.test(both)) return { sport: "MMA", league: "Bellator" };
    if (/\bpfl\b/.test(both)) return { sport: "MMA", league: "PFL" };
    // Golf
    if (/\bpga\b/.test(both)) return { sport: "Golf", league: "PGA" };
    if (/\bliv\b/.test(both)) return { sport: "Golf", league: "LIV" };
    if (/\blpga\b/.test(both)) return { sport: "Golf", league: "LPGA" };
    // Tennis
    if (/\batp\b/.test(both)) return { sport: "Tennis", league: "ATP" };
    if (/\bwta\b/.test(both)) return { sport: "Tennis", league: "WTA" };
    // Generic sport-word fallbacks
    if (/\bbasketball\b/.test(both)) return { sport: "Basketball", league: "NBA" };
    if (/\bamerican football\b/.test(both) || (s === "football" && !l)) return { sport: "Football", league: "NFL" };
    if (/\bbaseball\b/.test(both)) return { sport: "Baseball", league: "MLB" };
    if (/\bhockey\b/.test(both) || /\bice hockey\b/.test(both)) return { sport: "Hockey", league: "NHL" };
    if (/\bsoccer\b/.test(both) || /\bfutbol\b/.test(both) || /\bfootball\b/.test(both)) return { sport: "Soccer", league: "Soccer" };
    if (/\btennis\b/.test(both)) return { sport: "Tennis", league: "Tennis" };
    if (/\bmma\b/.test(both) || /\bmartial\b/.test(both) || /\bfighting\b/.test(both)) return { sport: "MMA", league: "UFC" };
    if (/\bgolf\b/.test(both)) return { sport: "Golf", league: "PGA" };
    return { sport: "Other", league: sportStr || leagueStr || "Other" };
  };

  const handleFileUpload = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => {
      const text = ev.target.result;
      const parsed = parseCSV(text);
      if (!parsed) { setImportStatus({ type: "error", message: "Could not parse file" }); setTimeout(() => setImportStatus(null), 5000); return; }
      if (isTransactionCSV(parsed.headers)) {
        autoImportTransactions(parsed);
      } else if (isPolymarketCSV(parsed.headers)) {
        autoImportPolymarket(parsed);
      } else {
        setCsvText(text); setCsvPreview(parsed);
      }
    };
    r.readAsText(f);
    e.target.value = "";
  };

  // Convert ISO timestamp to EST date string (YYYY-MM-DD)
  const isoToEstDate = (iso) => {
    if (!iso) return "";
    try {
      const dt = new Date(iso);
      // Format in America/New_York timezone
      const parts = dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // en-CA gives YYYY-MM-DD
      return parts;
    } catch { return iso.slice(0, 10); }
  };

  // Get initial date from placed timestamp (EST). For individual bets without clustering context.
  const getGameDate = (placedIso, settledIso) => {
    const baseDate = isoToEstDate(placedIso);
    if (!baseDate || !placedIso) return baseDate;
    try {
      const placed = new Date(placedIso);
      const estHour = parseInt(placed.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
      if (estHour >= 5) return baseDate;
      if (settledIso) {
        const settled = new Date(settledIso);
        const hoursToSettle = (settled - placed) / (1000 * 60 * 60);
        if (hoursToSettle < 4) {
          const prevDay = new Date(placed.getTime() - 24 * 60 * 60 * 1000);
          return prevDay.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        }
      }
      return baseDate;
    } catch { return baseDate; }
  };

  // Game-date clustering: groups bets by the actual game they belong to,
  // then assigns all bets in each game to the earliest placed date (game date).
  // This handles live bets placed after midnight on games that started the previous evening.
  const clusterGameDates = (betsArr) => {
    // Only cluster non-parlay bets that have settled timestamps
    const clusterable = [];
    const passthrough = [];
    betsArr.forEach((b, i) => {
      if (b.parlay || !b.settledAt) { passthrough.push(b); return; }
      clusterable.push({ ...b, _idx: i });
    });
    if (clusterable.length === 0) return { bets: betsArr, reassigned: 0 };

    // Sort by settled time
    clusterable.sort((a, b) => (a.settledAt || "").localeCompare(b.settledAt || ""));

    // Group bets that settled within 15 minutes of each other into game clusters
    const clusters = [];
    let current = [clusterable[0]];
    for (let i = 1; i < clusterable.length; i++) {
      const prev = new Date(current[current.length - 1].settledAt).getTime();
      const curr = new Date(clusterable[i].settledAt).getTime();
      const diffMin = Math.abs(curr - prev) / 60000;
      if (diffMin <= 15) {
        current.push(clusterable[i]);
      } else {
        clusters.push(current);
        current = [clusterable[i]];
      }
    }
    clusters.push(current);

    // For each cluster, assign all bets to the earliest placed date (EST)
    let reassigned = 0;
    clusters.forEach(group => {
      if (group.length < 2) return; // single bet, nothing to cluster
      // Find earliest placed date in the group
      const dates = group.map(b => b.date).filter(Boolean);
      if (dates.length === 0) return;
      const earliestDate = dates.sort()[0];
      group.forEach(b => {
        if (b.date !== earliestDate) { reassigned++; }
        b.date = earliestDate;
      });
    });

    // Merge back and return
    const result = [...passthrough, ...clusterable.map(({ _idx, ...b }) => b)];
    return { bets: result, reassigned };
  };

  // Seamless auto-import for the user's transaction CSV format
  const autoImportTransactions = (parsed) => {
    const ts = Date.now();
    let imported = 0, skipped = 0, dupes = 0;
    // Build set of existing bids for dedup
    const existingBids = new Set(bets.filter(b => b.bid).map(b => b.bid));
    let cashOuts = 0, pushes = 0;
    const newBets = parsed.rows.map((row, i) => {
      try {
        const status = (row.status || "").toUpperCase();
        const isCashOut = status.includes("CASH_OUT") || status.includes("CASHOUT");
        const isPush = status.includes("PUSH");
        // Allow SETTLED, CASH_OUT, and PUSH; skip only VOID and non-settled
        if (!(status.includes("SETTLED") || isCashOut) || status.includes("VOID")) { skipped++; return null; }
        const rowType = (row.type || "").toLowerCase();
        const isParlay = rowType.includes("parlay");
        const isRoundRobin = rowType.includes("round_robin");
        // Parse leg count from bet_info (legs separated by |)
        const betInfoStr = row.bet_info || "";
        const legCount = betInfoStr.split("|").filter(s => s.trim()).length || 1;
        // Parse round robin ways from type field (e.g. "round_robin_6" → 6)
        const rrMatch = rowType.match(/round_robin_(\d+)/);
        const rrWays = rrMatch ? parseInt(rrMatch[1]) : (isRoundRobin ? legCount : 0);
        const bid = (row.bet_id || "").trim();
        if (bid && existingBids.has(bid)) { dupes++; return null; }
        if (bid) existingBids.add(bid); // prevent dupes within same import
        const stake = Math.abs(parseFloat(row.amount) || 0);
        const profit = parseFloat(row.profit) || 0;
        // Grading: cash-outs → push, SETTLED_PUSH → push, $0-profit SETTLED_WIN → push
        let result;
        if (isCashOut) { result = "push"; cashOuts++; }
        else if (isPush) { result = "push"; pushes++; }
        else if (status.includes("WIN") && profit === 0) { result = "push"; pushes++; }
        else { result = status.includes("WIN") ? "won" : "lost"; }
        const decOdds = parseFloat(row.odds) || 0;
        // For partial payouts (odds < 1.0) or missing odds, set American odds to 0 (N/A) and use profit directly
        const americanOdds = decOdds > 1 ? decToAmerican(decOdds) : 0;
        const closingDec = parseFloat(row.closing_line) || 0;
        const hasRealClosing = closingDec > 1;
        const closingOdds = hasRealClosing ? decToAmerican(closingDec) : (americanOdds !== 0 ? americanOdds + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 15) : 0);
        // Convert placed time to game date (handles cross-midnight live bets)
        const isoTime = (row.time_placed_iso || row.time_placed || "").trim();
        const settledTime = (row.time_settled_iso || row.time_settled || "").trim();
        const date = getGameDate(isoTime, settledTime) || isoToEstDate(isoTime) || isoTime.slice(0, 10);
        if (!date || date.length < 8) { skipped++; return null; }
        const placedAt = isoTime;
        const { live } = detectLive(row);
        const { event, pick, betType } = parseBetInfo(row.bet_info);
        const { sport, league } = mapSportLeague(row.sports, row.leagues);
        const sportsbook = (row.sportsbook || "Unknown").replace(" Sportsbook", "").trim();
        // Detect free/promo bets from tags column
        const tags = (row.tags || "").toLowerCase();
        const rawTags = (row.tags || "").trim();
        const isFreeBet = /free.?bet|promo|bonus|boost|token|reward|risk.?free|on.?the.?house/i.test(tags) || stake < 0.01;
        // Determine bet type: round robin → "Round Robin", parlay → "Parlay", live → "Live", else detected
        const finalType = isRoundRobin ? "Round Robin" : (isParlay ? "Parlay" : (live ? "Live" : betType));
        imported++;
        return {
          bid, id: ts + i, date, placedAt, settledAt: settledTime || undefined, sport, league, type: finalType,
          event, pick, odds: americanOdds, closingOdds, stake,
          result, payout: result === "won" ? stake + profit : 0,
          profit: Math.round(profit * 100) / 100,
          sportsbook, profile: importProfile,
          ...(isCashOut && { cashOut: true }),
          ...((isParlay || isRoundRobin) && { parlay: true }),
          ...(legCount > 1 && { legs: legCount }),
          ...(rrWays > 0 && { rrWays }),
          ...(!hasRealClosing && { noClosingLine: true }),
          ...(isFreeBet && { freeBet: true }),
          ...(rawTags && { tags: rawTags }),
        };
      } catch { skipped++; return null; }
    }).filter(Boolean);
    // Apply game-date clustering: group bets by same game, assign all to earliest placed date
    let gameReassigned = 0;
    let finalBets = newBets;
    if (newBets.length > 1) {
      const clustered = clusterGameDates(newBets);
      finalBets = clustered.bets || newBets;
      gameReassigned = clustered.reassigned || 0;
    }
    if (finalBets.length > 0) {
      setBets(prev => [...prev, ...finalBets].sort((a, b) => a.date.localeCompare(b.date)));
      const parts = [`Imported ${imported} bets`];
      if (dupes > 0) parts.push(`${dupes} duplicates skipped`);
      if (pushes > 0) parts.push(`${pushes} pushes`);
      if (cashOuts > 0) parts.push(`${cashOuts} cash-outs → push`);
      if (gameReassigned > 0) parts.push(`${gameReassigned} bets re-dated to game day`);
      if (skipped > 0) parts.push(`${skipped} void/invalid skipped`);
      setImportStatus({ type: "success", message: parts.join(" · ") });
    } else {
      setImportStatus({ type: "error", message: dupes > 0 ? `All ${dupes} bets already imported (duplicates)` : "No valid settled bets found" });
    }
    setCsvText(""); setCsvPreview(null);
    setTimeout(() => setImportStatus(null), 6000);
  };

  const triggerCSVParse = (textOverride) => {
    const raw = textOverride || csvText;
    const p = parseCSV(raw);
    if (p && isTransactionCSV(p.headers)) { autoImportTransactions(p); return; }
    if (p && isPolymarketCSV(p.headers)) { autoImportPolymarket(p); return; }
    setCsvPreview(p);
    if (!p && raw.trim()) setImportStatus({ type: "error", message: "Could not parse CSV — make sure there is a header row and at least one data row" });
  };

  const importCSVBets = () => {
    if (!csvPreview) return;
    try {
      const mapping = { date: ["date", "bet_date", "placed", "day", "time_placed_iso"], sport: ["sport", "sports"], league: ["league", "leagues"], event: ["event", "game", "match", "matchup", "bet_info"], pick: ["pick", "selection", "bet", "team"], type: ["type", "bet_type", "market"], odds: ["odds", "open_odds", "price", "line"], closingodds: ["closing_odds", "closingodds", "close_odds", "clv_odds", "closing", "closing_line"], stake: ["stake", "wager", "risk", "amount", "bet_amount"], result: ["result", "outcome", "status", "win_loss", "w/l"], profit: ["profit", "pl", "p&l", "net", "pnl", "return"], sportsbook: ["sportsbook", "book", "operator", "site", "bookie"] };
      const findH = (d) => { const alts = mapping[d] || [d]; return csvPreview.headers.find(h => alts.includes(h)) || undefined; };
      let imported = 0, errors = 0;
      const ts = Date.now();
      const newBets = csvPreview.rows.map((row, i) => {
        try {
          const dH = findH("date"); if (!dH || !row[dH]) { errors++; return null; }
          // Convert to game date if ISO timestamp (handles cross-midnight live bets)
          const rawDate = row[dH];
          const settledH = csvPreview.headers.find(h => ["time_settled_iso", "time_settled", "settled"].includes(h));
          const settledRaw = settledH ? row[settledH] : "";
          const date = rawDate.includes("T") ? (getGameDate(rawDate, settledRaw) || isoToEstDate(rawDate) || rawDate.slice(0, 10)) : rawDate.slice(0, 10);
          const oddsH = findH("odds"); const odds = oddsH ? parseFloat(row[oddsH]) || 0 : 0;
          const cH = findH("closingodds");
          const hasRealClosing = cH && row[cH] && parseFloat(row[cH]);
          const closingOdds = hasRealClosing ? parseFloat(row[cH]) : (odds !== 0 ? odds + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 20) : 0);
          const stakeH = findH("stake"); const stake = stakeH ? parseFloat(row[stakeH]) || 100 : 100;
          // Result grading with push support
          const rH = findH("result"); const rawResult = rH && row[rH] ? row[rH].toLowerCase() : "";
          const pH = findH("profit"); const profit = pH && row[pH] ? parseFloat(row[pH]) || 0 : 0;
          let result;
          if (rawResult.includes("push") || rawResult.includes("void") || rawResult.includes("cash")) { result = "push"; }
          else if (profit === 0 && rawResult.includes("w") && !rawResult.includes("lost")) { result = "push"; }
          else if (rawResult.includes("w") && !rawResult.includes("lost")) { result = "won"; }
          else { result = "lost"; }
          const computedProfit = pH && row[pH] ? parseFloat(row[pH]) || 0 : (result === "won" ? (odds > 0 ? stake * odds / 100 : odds !== 0 ? stake * 100 / Math.abs(odds) : 0) : result === "push" ? 0 : -stake);
          const rawSport = row[findH("sport")] || "";
          const rawLeague = row[findH("league")] || "";
          const mapped = mapSportLeague(rawSport, rawLeague);
          const league = ALL_LEAGUES.includes(rawSport) ? rawSport : ALL_LEAGUES.includes(rawLeague) ? rawLeague : mapped.league;
          const sport = LEAGUE_TO_SPORT[league] || mapped.sport;
          const rawType = row[findH("type")] || "Moneyline";
          const isRR = rawType.toLowerCase().includes("round_robin");
          const isPar = rawType.toLowerCase().includes("parlay");
          const type = isRR ? "Round Robin" : isPar ? "Parlay" : rawType;
          imported++;
          return { id: ts + i, date, settledAt: settledRaw || undefined, sport, league, event: row[findH("event")] || "Imported Event", pick: row[findH("pick")] || "—", type, odds, closingOdds, stake, result, payout: result === "won" ? stake + computedProfit : 0, profit: Math.round(computedProfit * 100) / 100, sportsbook: row[findH("sportsbook")] || "Unknown", profile: importProfile, ...(!hasRealClosing && { noClosingLine: true }), ...((isPar || isRR) && { parlay: true }) };
        } catch { errors++; return null; }
      }).filter(Boolean);
      // Apply game-date clustering
      let finalBets = newBets;
      let gameReassigned = 0;
      if (newBets.length > 1) {
        const clustered = clusterGameDates(newBets);
        finalBets = clustered.bets || newBets;
        gameReassigned = clustered.reassigned || 0;
      }
      if (finalBets.length > 0) {
        setBets(prev => [...prev, ...finalBets].sort((a, b) => a.date.localeCompare(b.date)));
        const parts = [`Imported ${imported} bets`];
        if (gameReassigned > 0) parts.push(`${gameReassigned} re-dated to game day`);
        if (errors > 0) parts.push(`${errors} rows skipped`);
        setImportStatus({ type: "success", message: parts.join(" · ") });
        setCsvText(""); setCsvPreview(null);
      } else {
        setImportStatus({ type: "error", message: "No valid bets found — check that your CSV has a 'date' column" });
      }
      setTimeout(() => setImportStatus(null), 5000);
    } catch (e) {
      setImportStatus({ type: "error", message: "Import failed — check your CSV format" });
      setTimeout(() => setImportStatus(null), 5000);
    }
  };

  // ─── BACKUP / RESTORE ───
  const exportBackup = useCallback(() => {
    const backup = { _meta: { version: APP_VERSION, exportedAt: new Date().toISOString(), keys: PERSISTED_KEYS.length } };
    PERSISTED_KEYS.forEach(key => {
      try {
        const raw = localStorage.getItem(`et_${key}`);
        if (raw !== null) backup[key] = JSON.parse(raw);
      } catch {}
    });
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `edgetracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setImportStatus({ type: "success", message: `Backup exported — ${PERSISTED_KEYS.length} data keys saved` });
    setTimeout(() => setImportStatus(null), 4000);
  }, []);

  const importBackup = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const backup = JSON.parse(ev.target.result);
        if (!backup._meta) throw new Error("Not a valid EdgeTracker backup file");
        let restored = 0;
        for (const key of PERSISTED_KEYS) {
          if (backup[key] !== undefined) {
            const json = JSON.stringify(backup[key]);
            localStorage.setItem(`et_${key}`, json);
            if (window.storage) {
              try { await window.storage.set(`et_${key}`, json); } catch {}
            }
            restored++;
          }
        }
        setImportStatus({ type: "success", message: `Backup restored — ${restored} keys loaded. Reloading…` });
        setTimeout(() => window.location.reload(), 1500);
      } catch (err) {
        setImportStatus({ type: "error", message: `Restore failed: ${err.message}` });
        setTimeout(() => setImportStatus(null), 5000);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, []);

  const saveApiEndpoint = () => { if (!apiForm.name || !apiForm.url) return; setApiEndpoints(prev => [...prev, { ...apiForm, id: Date.now(), lastSync: null, status: "disconnected" }]); setApiForm({ name: "", url: "", key: "", sport: "All", active: true }); setShowAddApi(false); };

  // ─── REAL API SYNC ───
  // League key mapping for The Odds API
  const SPORT_KEY_MAP = {
    "NFL": ["americanfootball_nfl"],
    "NCAAF": ["americanfootball_ncaaf"],
    "NBA": ["basketball_nba"],
    "NCAAB": ["basketball_ncaab"],
    "NCAAW": ["basketball_ncaaw"],
    "WNBA": ["basketball_wnba"],
    "MLB": ["baseball_mlb"],
    "NHL": ["icehockey_nhl"],
    "EPL": ["soccer_epl"],
    "MLS": ["soccer_usa_mls"],
    "La Liga": ["soccer_spain_la_liga"],
    "Champions League": ["soccer_uefa_champs_league"],
    "Serie A": ["soccer_italy_serie_a"],
    "Bundesliga": ["soccer_germany_bundesliga"],
    "Ligue 1": ["soccer_france_ligue_one"],
    "Liga MX": ["soccer_mexico_ligamx"],
    "UFC": ["mma_mixed_martial_arts"],
    "PGA": ["golf_pga_championship"],
    "ATP": ["tennis_atp_french_open", "tennis_atp_us_open", "tennis_atp_wimbledon"],
    "WTA": ["tennis_wta_french_open", "tennis_wta_us_open"],
    // Parent sport fallbacks
    "Football": ["americanfootball_nfl", "americanfootball_ncaaf"],
    "Basketball": ["basketball_nba", "basketball_ncaab"],
    "Baseball": ["baseball_mlb"],
    "Hockey": ["icehockey_nhl"],
    "Soccer": ["soccer_epl", "soccer_usa_mls", "soccer_spain_la_liga"],
    "Tennis": ["tennis_atp_french_open"],
    "MMA": ["mma_mixed_martial_arts"],
    "Golf": ["golf_pga_championship"],
  };
  const TEAM_ALIASES = {
    "LAL": "Los Angeles Lakers", "LAC": "LA Clippers", "NY": "New York", "NYK": "New York Knicks", "NYM": "New York Mets", "NYY": "New York Yankees",
    "GS": "Golden State", "GSW": "Golden State Warriors", "TB": "Tampa Bay", "NO": "New Orleans", "SA": "San Antonio", "OKC": "Oklahoma City",
  };

  // Normalize team/event names for matching
  const normalizeTeam = (str) => {
    if (!str) return "";
    let s = str.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    // Remove common prefixes/suffixes
    s = s.replace(/\b(point spread|moneyline|total|handicap|incl overtime|over|under|live)\b/gi, "").trim();
    return s;
  };

  // Fuzzy match: do any significant words from the bet event appear in the API event?
  const fuzzyMatch = (betEvent, betPick, apiHome, apiAway) => {
    const betNorm = normalizeTeam(betEvent + " " + betPick);
    const apiNorm = normalizeTeam(apiHome + " " + apiAway);
    // Extract meaningful words (>3 chars)
    const betWords = betNorm.split(/\s+/).filter(w => w.length > 3);
    const apiWords = new Set(apiNorm.split(/\s+/).filter(w => w.length > 3));
    // Count matches
    const matches = betWords.filter(w => apiWords.has(w) || [...apiWords].some(aw => aw.includes(w) || w.includes(aw))).length;
    return matches >= 2 ? matches : 0; // Need at least 2 word matches
  };

  const syncEndpoint = useCallback(async (id) => {
    const ep = apiEndpoints.find(e => e.id === id);
    if (!ep || !ep.active) return;

    setApiEndpoints(prev => prev.map(e => e.id === id ? { ...e, status: "syncing" } : e));

    try {
      // Build URL — detect The Odds API vs generic
      const isOddsApi = ep.url.includes("odds-api") || ep.url.includes("the-odds-api") || ep.url.includes("api.the-odds-api.com");
      const isOpticOdds = ep.url.includes("opticodds");

      // Determine which sports/dates to fetch for
      const betsToMatch = bets.filter(b => {
        if (ep.sport !== "All" && b.sport !== ep.sport && b.league !== ep.sport) return false;
        // Only match bets from last 30 days that might need closing line updates
        const betDate = new Date(b.date);
        const daysAgo = (Date.now() - betDate.getTime()) / (1000 * 60 * 60 * 24);
        return daysAgo <= 30;
      });

      if (betsToMatch.length === 0) {
        setApiEndpoints(prev => prev.map(e => e.id === id ? { ...e, status: "connected", lastSync: new Date().toISOString() } : e));
        setImportStatus({ type: "success", message: `${ep.name}: No recent bets to match (${ep.sport === "All" ? "all sports" : ep.sport}, last 30 days)` });
        setTimeout(() => setImportStatus(null), 4000);
        return;
      }

      // Determine unique sports to fetch
      const sportsToFetch = ep.sport === "All" ? [...new Set(betsToMatch.map(b => b.league || b.sport))] : [ep.sport];

      let allApiEvents = [];

      for (const sport of sportsToFetch) {
        const sportKeys = SPORT_KEY_MAP[sport] || [sport.toLowerCase()];
        const primaryKey = sportKeys[0];

        let url = ep.url;
        let headers = {};

        if (isOddsApi) {
          // The Odds API format
          url = `https://api.the-odds-api.com/v4/sports/${primaryKey}/odds/?apiKey=${ep.key}&regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american`;
        } else if (isOpticOdds) {
          url = `${ep.url}?sport=${primaryKey}`;
          headers = { "x-api-key": ep.key };
        } else {
          // Generic — append API key as query param or header
          const sep = ep.url.includes("?") ? "&" : "?";
          url = `${ep.url}${sep}sport=${primaryKey}`;
          if (ep.key) headers = { "Authorization": `Bearer ${ep.key}`, "x-api-key": ep.key };
        }

        try {
          const resp = await fetch(url, { headers, mode: "cors" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();

          // Parse response — handle The Odds API format and generic
          const events = Array.isArray(data) ? data : (data.data || data.events || data.results || data.odds || []);

          events.forEach(ev => {
            const homeTeam = ev.home_team || ev.homeTeam || ev.home || "";
            const awayTeam = ev.away_team || ev.awayTeam || ev.away || "";
            const commence = ev.commence_time || ev.commenceTime || ev.start_time || ev.startTime || "";
            const bookmakers = ev.bookmakers || ev.books || [];

            // Extract odds from all bookmakers
            const allOdds = {};
            bookmakers.forEach(bk => {
              const markets = bk.markets || bk.odds || [];
              markets.forEach(mkt => {
                const key = mkt.key || mkt.market || mkt.type || "h2h";
                if (!allOdds[key]) allOdds[key] = [];
                const outcomes = mkt.outcomes || mkt.prices || [];
                outcomes.forEach(oc => {
                  allOdds[key].push({
                    name: oc.name || oc.team || "",
                    price: oc.price || oc.odds || oc.american || 0,
                    point: oc.point || oc.spread || oc.line || null,
                    book: bk.key || bk.name || ep.name,
                  });
                });
              });
            });

            allApiEvents.push({ homeTeam, awayTeam, commence, sport, allOdds });
          });
        } catch (fetchErr) {
          console.warn(`Sync ${ep.name} / ${sport}: ${fetchErr.message}`);
          // Continue with other sports even if one fails
        }
      }

      // Match API events to bets and update closing odds
      let matched = 0;
      let updated = 0;

      const updatedBets = bets.map(b => {
        if (ep.sport !== "All" && b.sport !== ep.sport && b.league !== ep.sport) return b;

        // Try to find a matching API event
        let bestMatch = null;
        let bestScore = 0;

        for (const ev of allApiEvents) {
          if (ev.sport !== b.league && ev.sport !== b.sport) continue;
          // Check date match (within 1 day)
          if (ev.commence) {
            const evDate = new Date(ev.commence).toISOString().slice(0, 10);
            if (evDate !== b.date) {
              const dayDiff = Math.abs(new Date(evDate) - new Date(b.date)) / (1000 * 60 * 60 * 24);
              if (dayDiff > 1) continue;
            }
          }

          const score = fuzzyMatch(b.event, b.pick, ev.homeTeam, ev.awayTeam);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = ev;
          }
        }

        if (!bestMatch) return b;
        matched++;

        // Find the best closing odds from the matched event
        // Try h2h (moneyline) first, then spreads, then totals
        const marketPriority = b.type === "Spread" ? ["spreads", "h2h"] :
                                b.type === "Over/Under" ? ["totals", "h2h"] :
                                ["h2h", "spreads", "totals"];

        let newClosingOdds = null;

        for (const mktKey of marketPriority) {
          const outcomes = bestMatch.allOdds[mktKey];
          if (!outcomes || outcomes.length === 0) continue;

          // Find outcomes matching the bet's pick (team name)
          const pickNorm = normalizeTeam(b.pick);
          const matchingOutcomes = outcomes.filter(oc => {
            const ocNorm = normalizeTeam(oc.name);
            return pickNorm.includes(ocNorm) || ocNorm.includes(pickNorm) ||
              pickNorm.split(/\s+/).some(w => w.length > 3 && ocNorm.includes(w));
          });

          if (matchingOutcomes.length > 0) {
            // Average the odds across books for this outcome
            const prices = matchingOutcomes.map(oc => {
              let p = oc.price;
              // Convert decimal to American if needed
              if (p > 0 && p < 50) p = p >= 2 ? Math.round((p - 1) * 100) : Math.round(-100 / (p - 1));
              return p;
            }).filter(p => Math.abs(p) >= 100 || (p > -100 && p < 0) || p > 0);

            if (prices.length > 0) {
              newClosingOdds = Math.round(prices.reduce((s, p) => s + p, 0) / prices.length);
              break;
            }
          }
        }

        if (newClosingOdds !== null && newClosingOdds !== b.closingOdds) {
          updated++;
          return { ...b, closingOdds: newClosingOdds };
        }
        return b;
      });

      if (updated > 0) setBets(updatedBets);

      setApiEndpoints(prev => prev.map(e => e.id === id ? { ...e, status: "connected", lastSync: new Date().toISOString() } : e));

      const msg = updated > 0
        ? `${ep.name}: Updated closing odds on ${updated} bet${updated !== 1 ? "s" : ""} (${matched} events matched from ${allApiEvents.length} returned)`
        : allApiEvents.length > 0
          ? `${ep.name}: ${matched} events matched but no odds changes needed (${allApiEvents.length} events returned)`
          : `${ep.name}: Connected OK but no events returned — check API key and sport filter`;

      setImportStatus({ type: updated > 0 || allApiEvents.length > 0 ? "success" : "error", message: msg });
      setTimeout(() => setImportStatus(null), 6000);

    } catch (err) {
      console.error("Sync error:", err);
      setApiEndpoints(prev => prev.map(e => e.id === id ? { ...e, status: "error" } : e));
      setImportStatus({ type: "error", message: `${ep.name}: ${err.message === "Failed to fetch" ? "Network error — API may not support browser requests (CORS). Try The Odds API or OpticOdds which support browser access." : err.message}` });
      setTimeout(() => setImportStatus(null), 8000);
    }
  }, [apiEndpoints, bets, setBets]);

  const syncAllEndpoints = useCallback(async () => {
    const active = apiEndpoints.filter(ep => ep.active);
    if (active.length === 0) { setImportStatus({ type: "error", message: "No active endpoints to sync" }); setTimeout(() => setImportStatus(null), 3000); return; }
    for (const ep of active) {
      await syncEndpoint(ep.id);
      await new Promise(r => setTimeout(r, 500)); // small delay between calls
    }
  }, [apiEndpoints, syncEndpoint]);

  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: "◈" },
    { id: "calendar", label: "Calendar", icon: "▦" },
    { id: "strategy", label: "Strategies", icon: "◎" },
    { id: "bankroll", label: "Bankroll", icon: "◉" },
    { id: "tax", label: "Tax Planning", icon: "⬡" },
    { id: "accounting", label: "Accounting", icon: "§" },
    { id: "import", label: "Import & API", icon: "⇄" },
    { id: "bets", label: "All Bets", icon: "☰" },
  ];

  // ─── W-2G HANDLERS ───
  const handleW2gFileUpload = (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setW2gFiles(prev => [...prev, { id: Date.now() + Math.random(), name: file.name, data: ev.target.result, type: file.type, size: file.size }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };
  const saveW2g = () => {
    if (!w2gForm.sportsbook || !w2gForm.amount) return;
    setW2gDocuments(prev => [...prev, { id: Date.now(), ...w2gForm, amount: parseFloat(w2gForm.amount) || 0, taxWithheld: parseFloat(w2gForm.taxWithheld) || 0, files: [...w2gFiles] }]);
    setW2gForm({ sportsbook: "", amount: "", date: new Date().toISOString().slice(0, 10), taxWithheld: "", notes: "" });
    setW2gFiles([]);
    setShowAddW2g(false);
  };

  // ─── RECEIPT HANDLERS ───
  const handleReceiptUpload = (e) => {
    const expId = receiptExpenseIdRef.current;
    if (!expId) return;
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setExpenseReceipts(prev => ({
          ...prev,
          [expId]: [...(prev[expId] || []), { id: Date.now() + Math.random(), name: file.name, data: ev.target.result, type: file.type, size: file.size }]
        }));
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };
  const removeReceipt = (expId, receiptId) => {
    setExpenseReceipts(prev => ({ ...prev, [expId]: (prev[expId] || []).filter(r => r.id !== receiptId) }));
  };

  // ─── ACCOUNTANT EXPORT ───
  const generateAccountantExport = useCallback((year) => {
    const yr = year || accountingExportYear;
    const yrBets = yr === "all" ? bets : bets.filter(b => b.date.startsWith(yr));

    // --- Summary CSV ---
    const grossWin = yrBets.filter(b => b.result === "won").reduce((s, b) => s + b.payout, 0);
    const grossLoss = yrBets.filter(b => b.result === "lost").reduce((s, b) => s + b.stake, 0);
    const netProfit = yrBets.reduce((s, b) => s + b.profit, 0);
    const totalStaked = yrBets.reduce((s, b) => s + b.stake, 0);
    const w2gTotal = w2gDocuments.filter(d => yr === "all" || d.date.startsWith(yr)).reduce((s, d) => s + d.amount, 0);
    const w2gWithheld = w2gDocuments.filter(d => yr === "all" || d.date.startsWith(yr)).reduce((s, d) => s + d.taxWithheld, 0);

    let csv = "";
    // Header
    csv += `EdgeTracker Accountant Export — ${yr === "all" ? "All Time" : yr}\n`;
    csv += `Generated: ${new Date().toISOString().slice(0, 10)}\n\n`;

    // P&L Summary
    csv += "═══ PROFIT & LOSS SUMMARY ═══\n";
    csv += "Category,Amount\n";
    csv += `Total Bets Placed,${yrBets.length}\n`;
    csv += `Total Amount Wagered,"${totalStaked.toFixed(2)}"\n`;
    csv += `Gross Winnings (payouts),"${grossWin.toFixed(2)}"\n`;
    csv += `Gross Losses (stakes on lost bets),"${grossLoss.toFixed(2)}"\n`;
    csv += `Net Gambling Profit/Loss,"${netProfit.toFixed(2)}"\n`;
    csv += `Win Rate,${yrBets.filter(b => b.result !== "push").length ? ((yrBets.filter(b => b.result === "won").length / yrBets.filter(b => b.result !== "push").length) * 100).toFixed(1) + "%" : "N/A"}\n\n`;

    // By Sportsbook
    csv += "═══ PROFIT BY SPORTSBOOK ═══\n";
    csv += "Sportsbook,Bets,Wagered,Gross Wins,Gross Losses,Net P&L\n";
    const byBook = {};
    yrBets.forEach(b => {
      if (!byBook[b.sportsbook]) byBook[b.sportsbook] = { count: 0, stake: 0, wins: 0, losses: 0, profit: 0 };
      byBook[b.sportsbook].count++;
      byBook[b.sportsbook].stake += b.stake;
      byBook[b.sportsbook].profit += b.profit;
      if (b.result === "won") byBook[b.sportsbook].wins += b.payout;
      else if (b.result === "lost") byBook[b.sportsbook].losses += b.stake;
    });
    Object.entries(byBook).sort((a, b) => b[1].profit - a[1].profit).forEach(([book, d]) => {
      csv += `"${book}",${d.count},"${d.stake.toFixed(2)}","${d.wins.toFixed(2)}","${d.losses.toFixed(2)}","${d.profit.toFixed(2)}"\n`;
    });
    csv += "\n";

    // Monthly Breakdown
    csv += "═══ MONTHLY BREAKDOWN ═══\n";
    csv += "Month,Bets,Wagered,Gross Wins,Gross Losses,Net P&L\n";
    const byMonth = {};
    yrBets.forEach(b => {
      const m = b.date.slice(0, 7);
      if (!byMonth[m]) byMonth[m] = { count: 0, stake: 0, wins: 0, losses: 0, profit: 0 };
      byMonth[m].count++;
      byMonth[m].stake += b.stake;
      byMonth[m].profit += b.profit;
      if (b.result === "won") byMonth[m].wins += b.payout;
      else if (b.result === "lost") byMonth[m].losses += b.stake;
    });
    Object.keys(byMonth).sort().forEach(m => {
      const d = byMonth[m];
      csv += `"${m}",${d.count},"${d.stake.toFixed(2)}","${d.wins.toFixed(2)}","${d.losses.toFixed(2)}","${d.profit.toFixed(2)}"\n`;
    });
    csv += "\n";

    // W-2G Summary
    const yrW2g = yr === "all" ? w2gDocuments : w2gDocuments.filter(d => d.date.startsWith(yr));
    csv += "═══ W-2G FORMS RECEIVED ═══\n";
    csv += "Date,Sportsbook,Winnings Reported,Federal Tax Withheld,Notes,Attached Files\n";
    if (yrW2g.length === 0) csv += "(none)\n";
    yrW2g.forEach(d => {
      const fileNames = (d.files || []).map(f => f.name).join("; ") || "none";
      csv += `"${d.date}","${d.sportsbook}","${d.amount.toFixed(2)}","${d.taxWithheld.toFixed(2)}","${d.notes || ""}","${fileNames}"\n`;
    });
    csv += `\nTotal W-2G Winnings,"${w2gTotal.toFixed(2)}"\n`;
    csv += `Total Federal Tax Withheld,"${w2gWithheld.toFixed(2)}"\n\n`;

    // Business Expenses
    csv += "═══ BUSINESS EXPENSES ═══\n";
    csv += "Name,Category,Amount,Recurrence,Annual Cost,Start Date,Status,Notes,Receipts Attached\n";
    expenses.forEach(exp => {
      const cat = EXPENSE_CATEGORIES.find(ec => ec.id === exp.category) || { label: exp.category };
      const amt = parseFloat(exp.amount) || 0;
      let annual;
      switch (exp.recurrence) { case "Weekly": annual = amt * 52; break; case "Monthly": annual = amt * 12; break; case "Quarterly": annual = amt * 4; break; case "Annually": annual = amt; break; default: annual = amt; }
      const receipts = (expenseReceipts[exp.id] || []).map(r => r.name).join("; ") || "none";
      csv += `"${exp.name}","${cat.label}","${amt.toFixed(2)}","${exp.recurrence}","${annual.toFixed(2)}","${exp.startDate}","${exp.active ? "Active" : "Inactive"}","${exp.notes || ""}","${receipts}"\n`;
    });
    csv += `\nTotal Annualized Expenses,"${expenseStats.annualized.toFixed(2)}"\n`;
    csv += `Monthly Burn Rate,"${expenseStats.monthlyBurn.toFixed(2)}"\n`;
    csv += `One-Time Capital Expenses,"${expenseStats.oneTimeTotal.toFixed(2)}"\n\n`;

    // Bottom Line
    csv += "═══ BOTTOM LINE ═══\n";
    csv += "Category,Amount\n";
    csv += `Net Gambling P&L,"${netProfit.toFixed(2)}"\n`;
    csv += `Total Business Expenses,"${expenseStats.annualized.toFixed(2)}"\n`;
    csv += `Net After Expenses,"${(netProfit - expenseStats.annualized).toFixed(2)}"\n`;
    csv += `W-2G Tax Already Withheld,"${w2gWithheld.toFixed(2)}"\n`;
    csv += `Estimated Additional Tax Liability,"${Math.max(0, taxStats.gamblingTax - w2gWithheld).toFixed(2)}"\n`;

    // --- Full bet log CSV ---
    let betCsv = "Date,Sport,League,Event,Pick,Type,Odds,Closing Odds,Stake,Result,Payout,Profit,Sportsbook,Bet ID,Profile\n";
    yrBets.forEach(b => {
      betCsv += `"${b.date}","${b.sport}","${b.league || b.sport}","${(b.event || "").replace(/"/g, '""')}","${(b.pick || "").replace(/"/g, '""')}","${b.type}",${b.odds},${b.closingOdds},"${b.stake.toFixed(2)}","${b.result}","${(b.payout || 0).toFixed(2)}","${b.profit.toFixed(2)}","${b.sportsbook}","${b.bid || ""}","${b.profile || ""}"\n`;
    });

    return { summary: csv, bets: betCsv, year: yr };
  }, [bets, w2gDocuments, expenses, expenseReceipts, expenseStats, taxStats, accountingExportYear]);

  const downloadCSV = (content, filename) => {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportAll = () => {
    const exp = generateAccountantExport();
    downloadCSV(exp.summary, `EdgeTracker_AccountantSummary_${exp.year}.csv`);
    setTimeout(() => downloadCSV(exp.bets, `EdgeTracker_BetLog_${exp.year}.csv`), 500);
    // Also export W-2G attachments and receipts as a manifest
    const allAttachments = [];
    w2gDocuments.forEach(d => (d.files || []).forEach(f => allAttachments.push({ source: "W-2G", ref: `${d.sportsbook} ${d.date}`, ...f })));
    expenses.forEach(exp => (expenseReceipts[exp.id] || []).forEach(r => allAttachments.push({ source: "Receipt", ref: exp.name, ...r })));
    if (allAttachments.length > 0) {
      let manifest = "Source,Reference,File Name,File Type,File Size\n";
      allAttachments.forEach(a => { manifest += `"${a.source}","${a.ref}","${a.name}","${a.type}","${a.size}"\n`; });
      setTimeout(() => downloadCSV(manifest, `EdgeTracker_Attachments_Manifest_${exp.year}.csv`), 1000);
    }
  };

  const downloadAttachment = (fileObj) => {
    const a = document.createElement("a");
    a.href = fileObj.data; a.download = fileObj.name; a.click();
  };

  const downloadAllAttachments = () => {
    const all = [];
    w2gDocuments.forEach(d => (d.files || []).forEach(f => all.push(f)));
    expenses.forEach(exp => (expenseReceipts[exp.id] || []).forEach(r => all.push(r)));
    all.forEach((f, i) => setTimeout(() => downloadAttachment(f), i * 300));
  };

  /* ═══ DASHBOARD ═══ */
  const withdrawalReminder = useMemo(() => {
    const now = new Date();
    const day = now.getDate();
    const month = now.getMonth();
    const year = now.getFullYear();
    const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
    const daysLeft = 18 - day;
    const target = expenseStats.monthlyBurn;

    // Check manual override
    if (expensesPaidManual.has(monthKey)) {
      return { amount: target, daysLeft, deadline: `${MONTHS[month]} 18, ${year}`, monthKey, paid: true, paidAmount: target, paidSource: "manual", paidTxns: [] };
    }

    // Auto-detect: sum all withdrawals this month tagged with purpose "expenses"
    const expenseTxns = bankrollHistory.filter(t =>
      t.type === "withdrawal" &&
      t.purpose === "expenses" &&
      t.date.startsWith(monthKey) &&
      (activeProfile === "all" || (t.profile || profiles[0]?.id) === activeProfile)
    );
    const paidAmount = expenseTxns.reduce((s, t) => s + (t.amount || 0), 0);
    const paid = paidAmount >= target * 0.95; // 95% threshold to account for rounding

    // Show from the 1st through the 17th if unpaid, always show paid confirmation until 20th
    if (day >= 18 && !paid) return null;
    if (day >= 20 && paid) return null;

    return { amount: target, daysLeft: Math.max(0, daysLeft), deadline: `${MONTHS[month]} 18, ${year}`, monthKey, paid, paidAmount, paidSource: paid ? "auto" : null, paidTxns: expenseTxns, partial: paidAmount > 0 && !paid };
  }, [expenseStats.monthlyBurn, bankrollHistory, expensesPaidManual, activeProfile]);

  const markExpensesPaid = useCallback(() => {
    if (!withdrawalReminder) return;
    setExpensesPaidManual(prev => new Set([...prev, withdrawalReminder.monthKey]));
  }, [withdrawalReminder]);

  const unmarkExpensesPaid = useCallback(() => {
    if (!withdrawalReminder) return;
    setExpensesPaidManual(prev => {
      const next = new Set(prev);
      next.delete(withdrawalReminder.monthKey);
      return next;
    });
  }, [withdrawalReminder]);

  const renderDashboard = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

      {/* ─── Withdrawal Reminder ─── */}
      {withdrawalReminder && !withdrawalReminder.paid && (
        <div style={{ background: `linear-gradient(135deg, ${c.amberDim}, rgba(245,158,11,0.04))`, border: `1px solid ${c.amber}33`, borderRadius: 14, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, animation: "fadeIn 0.3s ease" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: c.amberDim, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>💸</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: c.amber }}>
                Withdraw for Monthly Expenses
              </div>
              <div style={{ fontSize: 12, color: c.textDim, marginTop: 2 }}>
                {withdrawalReminder.partial ? (
                  <>
                    <span style={{ color: c.text, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>${withdrawalReminder.paidAmount.toFixed(2)}</span>
                    {" of "}
                    <span style={{ color: c.text, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>${withdrawalReminder.amount.toFixed(2)}</span>
                    {" withdrawn — "}
                    <span style={{ color: c.amber, fontWeight: 600 }}>${(withdrawalReminder.amount - withdrawalReminder.paidAmount).toFixed(2)} remaining</span>
                    {" before "}<span style={{ color: c.text, fontWeight: 600 }}>{withdrawalReminder.deadline}</span>
                  </>
                ) : (
                  <>
                    Pull <span style={{ color: c.text, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>${withdrawalReminder.amount.toFixed(2)}</span> before <span style={{ color: c.text, fontWeight: 600 }}>{withdrawalReminder.deadline}</span>
                    {withdrawalReminder.daysLeft > 0 ? ` — ${withdrawalReminder.daysLeft === 1 ? "tomorrow!" : `${withdrawalReminder.daysLeft} days left`}` : " — today!"}
                  </>
                )}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {withdrawalReminder.daysLeft <= 3 && withdrawalReminder.daysLeft > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: c.red, textTransform: "uppercase", letterSpacing: 1, animation: "pulse 2s infinite" }}>Urgent</span>
            )}
            <button onClick={markExpensesPaid} style={{ background: c.greenDim, border: `1px solid ${c.green}44`, borderRadius: 8, padding: "6px 14px", color: c.green, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s", whiteSpace: "nowrap" }}>
              ✓ Mark Paid
            </button>
            <button onClick={() => {
              const remaining = withdrawalReminder.partial ? withdrawalReminder.amount - withdrawalReminder.paidAmount : withdrawalReminder.amount;
              setTxnForm({ date: new Date().toISOString().slice(0, 10), type: "withdrawal", book: "", amount: remaining.toFixed(2), note: "Monthly expenses", purpose: "expenses" });
              setShowAddTxn(true);
              setActiveTab("bankroll");
            }} style={{ background: c.amberDim, border: `1px solid ${c.amber}44`, borderRadius: 8, padding: "6px 14px", color: c.amber, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s", whiteSpace: "nowrap" }}>
              Withdraw →
            </button>
          </div>
        </div>
      )}
      {/* ─── Paid Confirmation ─── */}
      {withdrawalReminder && withdrawalReminder.paid && (
        <div style={{ background: `linear-gradient(135deg, ${c.greenDim}, rgba(0,230,138,0.04))`, border: `1px solid ${c.green}33`, borderRadius: 14, padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, animation: "fadeIn 0.3s ease" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: c.greenDim, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>✅</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: c.green }}>
                Monthly Expenses Covered
              </div>
              <div style={{ fontSize: 12, color: c.textDim, marginTop: 2 }}>
                <span style={{ color: c.text, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>${withdrawalReminder.paidAmount.toFixed(2)}</span>
                {" "}withdrawn for expenses this month
                {withdrawalReminder.paidSource === "manual" && <span style={{ color: c.textDim }}> · marked manually</span>}
                {withdrawalReminder.paidSource === "auto" && withdrawalReminder.paidTxns.length > 0 && (
                  <span style={{ color: c.textDim }}> · {withdrawalReminder.paidTxns.length} transaction{withdrawalReminder.paidTxns.length > 1 ? "s" : ""} detected</span>
                )}
              </div>
            </div>
          </div>
          {withdrawalReminder.paidSource === "manual" && (
            <button onClick={unmarkExpensesPaid} style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${c.border}`, borderRadius: 8, padding: "6px 14px", color: c.textDim, fontSize: 11, fontWeight: 500, cursor: "pointer", transition: "all 0.2s", whiteSpace: "nowrap" }}>
              Undo
            </button>
          )}
        </div>
      )}

      {/* ─── Global Controls ─── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", background: "rgba(255,255,255,0.03)", borderRadius: 10, border: `1px solid ${c.border}`, padding: 3 }}>
          {[
            { id: "month", label: "This Month" },
            { id: "ytd", label: "YTD" },
            { id: "all", label: "All Time" },
          ].map(p => (
            <button key={p.id} onClick={() => setDashPeriod(p.id)} style={{
              background: dashPeriod === p.id ? "rgba(255,255,255,0.08)" : "transparent",
              border: "none", borderRadius: 8, padding: "6px 16px",
              color: dashPeriod === p.id ? c.text : c.textDim,
              fontSize: 12, fontWeight: dashPeriod === p.id ? 600 : 400,
              cursor: "pointer", transition: "all 0.2s",
              boxShadow: dashPeriod === p.id ? `0 0 0 1px ${c.borderLight}` : "none",
            }}>{p.label}</button>
          ))}
        </div>
        <button onClick={() => setFreeBetMode(m => m === "exclude" ? "include" : "exclude")} style={{ ...btnSecondary, padding: "5px 12px", fontSize: 11, background: freeBetMode === "exclude" ? "rgba(0,230,138,0.08)" : "transparent", borderColor: freeBetMode === "exclude" ? c.green + "44" : c.border, color: freeBetMode === "exclude" ? c.green : c.textDim }} title="When on, losses from free/promo bets are excluded from P&L">🎁 Free Bet Filter {freeBetMode === "exclude" ? "ON" : "OFF"}</button>
      </div>

      {/* ─── Key Stats ─── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <StatCard label="Net Profit" value={formatMoney(freeBetMode === "exclude" ? dashStats.adjustedProfit : dashStats.totalProfit)} color={(freeBetMode === "exclude" ? dashStats.adjustedProfit : dashStats.totalProfit) >= 0 ? c.green : c.red} sub={`${dashStats.roi >= 0 ? "+" : ""}${dashStats.roi.toFixed(1)}% ROI${dashStats.freeBetCount > 0 && freeBetMode === "exclude" ? ` · ${dashStats.freeBetCount} free` : ""}`} spark={dashStats.cumulative} />
        <StatCard label="Win Rate" value={`${dashStats.winRate.toFixed(1)}%`} color={c.blue} sub={`${dashStats.wins}W — ${dashStats.losses}L${dashStats.pushes ? ` — ${dashStats.pushes}P` : ""}`} />
        <StatCard label="Avg CLV" value={`${dashStats.avgCLV >= 0 ? "+" : ""}${dashStats.avgCLV.toFixed(2)}%`} color={dashStats.avgCLV >= 0 ? c.green : c.red} sub="Closing Line Value" />
        <StatCard label="Volume" value={`$${dashStats.totalStake.toLocaleString()}`} color={c.purple} sub={`${dashStats.total} bets · $${dashStats.avgStake.toFixed(0)} avg`} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        {[{ l: "Best Day", v: formatMoney(dashStats.bestDay[1]), s: dashStats.bestDay[0], c2: c.green }, { l: "Worst Day", v: formatMoney(dashStats.worstDay[1]), s: dashStats.worstDay[0], c2: c.red }, { l: "Current Streak", v: `${dashStats.streak}${dashStats.streakType === "won" ? "W" : "L"}`, s: dashStats.streakType === "won" ? "winning" : "losing", c2: dashStats.streakType === "won" ? c.green : c.red }, { l: "Monthly Burn", v: formatMoney(expenseStats.monthlyBurn), s: `${expenseStats.activeCount} active expenses`, c2: c.amber }].map(it => (
          <div key={it.l} style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 14, padding: "16px 18px" }}>
            <div style={{ fontSize: 11, color: c.textDim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{it.l}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: it.c2, fontFamily: "'JetBrains Mono', monospace" }}>{it.v}</div>
            {it.s && <div style={{ fontSize: 11, color: c.textDim, marginTop: 2 }}>{it.s}</div>}
          </div>
        ))}
      </div>

      {/* ─── Profit Goal Tracker ─── */}
      <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: goalProjection ? 16 : 0 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Profit Goal {goalProjection ? goalProjection.targetMonth < 12 ? `(by ${MONTHS[goalProjection.targetMonth - 1]})` : "(Annual)" : ""}</h3>
          <button onClick={() => { setGoalForm({ year: String(new Date().getFullYear()), goal: goalProjection?.targetAmount || "", targetMonth: goalProjection?.targetMonth || "12" }); setShowGoalEditor(true); }} style={{ ...btnSecondary, padding: "4px 12px", fontSize: 11 }}>{goalProjection ? "Edit Goal" : "+ Set Goal"}</button>
        </div>

        {showGoalEditor && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 16, padding: 14, background: "rgba(255,255,255,0.02)", borderRadius: 12, border: `1px solid ${c.border}` }}>
            <div style={{ flex: 1 }}>
              <label style={fieldLabel}>Year</label>
              <select value={goalForm.year} onChange={e => setGoalForm(f => ({ ...f, year: e.target.value }))} style={{ ...fieldInput, width: "100%" }}>
                {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div style={{ flex: 2 }}>
              <label style={fieldLabel}>Profit Target ($)</label>
              <input type="number" value={goalForm.goal} onChange={e => setGoalForm(f => ({ ...f, goal: e.target.value }))} placeholder="e.g. 100000" style={{ ...fieldInput, width: "100%" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={fieldLabel}>By Month</label>
              <select value={goalForm.targetMonth} onChange={e => setGoalForm(f => ({ ...f, targetMonth: e.target.value }))} style={{ ...fieldInput, width: "100%" }}>
                {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
            </div>
            <button onClick={() => { if (goalForm.goal) { setProfitGoals(prev => ({ ...prev, [goalForm.year]: { goal: parseFloat(goalForm.goal), targetMonth: parseInt(goalForm.targetMonth) } })); setShowGoalEditor(false); } }} style={{ ...btnSecondary, padding: "8px 16px", background: c.greenDim, borderColor: c.green + "44", color: c.green, fontWeight: 600, whiteSpace: "nowrap" }}>Save</button>
            <button onClick={() => setShowGoalEditor(false)} style={{ ...btnSecondary, padding: "8px 12px", whiteSpace: "nowrap" }}>Cancel</button>
          </div>
        )}

        {goalProjection ? (() => {
          const gp = goalProjection;
          const mc = gp.mc;
          const profit = gp.currentProfit;
          const barPct = Math.max(0, Math.min(100, gp.pctComplete));
          const pacePct = Math.min(100, gp.pctTimeElapsed);
          const aheadOfPace = profit >= gp.goalPace;
          const paceColor = aheadOfPace ? c.green : c.amber;
          const profitDisplay = freeBetMode === "exclude" ? profit : gp.currentProfit;
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Progress bar */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 22, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: paceColor }}>{formatMoney(profitDisplay)}</span>
                  <span style={{ fontSize: 16, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", color: c.textDim }}>/ {formatMoney(gp.targetAmount)}</span>
                </div>
                <div style={{ position: "relative", height: 18, background: "rgba(255,255,255,0.04)", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${barPct}%`, background: `linear-gradient(90deg, ${paceColor}88, ${paceColor})`, borderRadius: 10, transition: "width 0.5s ease" }} />
                  {/* Pace marker */}
                  <div style={{ position: "absolute", top: 0, left: `${pacePct}%`, width: 2, height: "100%", background: c.text, opacity: 0.4 }} title={`Expected pace: ${formatMoney(gp.goalPace)}`} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span style={{ fontSize: 10, color: c.textDim }}>{barPct.toFixed(1)}% of goal</span>
                  <span style={{ fontSize: 10, color: c.textDim }}>Day {gp.elapsedDays} of {gp.totalDays} · {gp.remainingDays} remaining</span>
                </div>
              </div>
              {/* Stats row */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: c.textDim, textTransform: "uppercase", letterSpacing: 0.8 }}>Daily Pace</div>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: gp.dailyRate >= 0 ? c.green : c.red, marginTop: 2 }}>{formatMoney(gp.dailyRate)}/d</div>
                </div>
                <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: c.textDim, textTransform: "uppercase", letterSpacing: 0.8 }}>Need</div>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: gp.neededDailyRate > gp.dailyRate * 1.5 ? c.red : gp.neededDailyRate > gp.dailyRate ? c.amber : c.green, marginTop: 2 }}>{gp.remainingDays > 0 ? `${formatMoney(gp.neededDailyRate)}/d` : "—"}</div>
                </div>
                <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: c.textDim, textTransform: "uppercase", letterSpacing: 0.8 }}>Projected</div>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: gp.projectedTotal >= gp.targetAmount ? c.green : c.amber, marginTop: 2 }}>{formatMoney(gp.projectedTotal)}</div>
                </div>
                <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: c.textDim, textTransform: "uppercase", letterSpacing: 0.8 }}>Status</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: paceColor, marginTop: 2 }}>{aheadOfPace ? `+${formatMoney(profit - gp.goalPace)}` : formatMoney(profit - gp.goalPace)}</div>
                </div>
              </div>

              {/* MC simulation results */}
              {mc && (
                <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 12, padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: c.text }}>Variance Projection ({mc.sims.toLocaleString()} simulations)</span>
                    <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: mc.hitGoalPct >= 70 ? c.green : mc.hitGoalPct >= 40 ? c.amber : c.red }}>{mc.hitGoalPct.toFixed(0)}% chance to hit goal</span>
                  </div>
                  {/* Visual range bar */}
                  {(() => {
                    const allVals = [mc.p5, mc.p25, mc.p50, mc.p75, mc.p95, gp.targetAmount, 0];
                    const minV = Math.min(...allVals);
                    const maxV = Math.max(...allVals);
                    const range = maxV - minV || 1;
                    const toX = (v) => ((v - minV) / range) * 100;
                    return (
                      <div style={{ position: "relative", height: 40, margin: "8px 0 12px" }}>
                        {/* 5-95 band */}
                        <div style={{ position: "absolute", top: 10, left: `${toX(mc.p5)}%`, width: `${toX(mc.p95) - toX(mc.p5)}%`, height: 20, background: "rgba(99,102,241,0.1)", borderRadius: 4 }} />
                        {/* 25-75 band */}
                        <div style={{ position: "absolute", top: 10, left: `${toX(mc.p25)}%`, width: `${toX(mc.p75) - toX(mc.p25)}%`, height: 20, background: "rgba(99,102,241,0.2)", borderRadius: 4 }} />
                        {/* Median line */}
                        <div style={{ position: "absolute", top: 8, left: `${toX(mc.p50)}%`, width: 2, height: 24, background: c.purple, borderRadius: 1 }} />
                        {/* Goal line */}
                        <div style={{ position: "absolute", top: 4, left: `${toX(gp.targetAmount)}%`, width: 2, height: 32, background: c.amber, borderRadius: 1 }} />
                        <div style={{ position: "absolute", top: -2, left: `${toX(gp.targetAmount)}%`, transform: "translateX(-50%)", fontSize: 9, color: c.amber, fontWeight: 600, whiteSpace: "nowrap" }}>Goal</div>
                        {/* Labels */}
                        <div style={{ position: "absolute", top: 34, left: `${toX(mc.p5)}%`, transform: "translateX(-50%)", fontSize: 9, color: c.textDim }}>{formatMoney(mc.p5)}</div>
                        <div style={{ position: "absolute", top: 34, left: `${toX(mc.p50)}%`, transform: "translateX(-50%)", fontSize: 9, color: c.purple, fontWeight: 600 }}>{formatMoney(mc.p50)}</div>
                        <div style={{ position: "absolute", top: 34, left: `${toX(mc.p95)}%`, transform: "translateX(-50%)", fontSize: 9, color: c.textDim }}>{formatMoney(mc.p95)}</div>
                      </div>
                    );
                  })()}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginTop: 8 }}>
                    {[{ l: "Worst (5th)", v: mc.p5, cl: c.red }, { l: "Low (25th)", v: mc.p25, cl: c.amber }, { l: "Median", v: mc.p50, cl: c.purple }, { l: "High (75th)", v: mc.p75, cl: c.green }, { l: "Best (95th)", v: mc.p95, cl: c.green }].map(it => (
                      <div key={it.l} style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: c.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>{it.l}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: it.cl, marginTop: 2 }}>{formatMoney(it.v)}</div>
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: 11, color: c.textDim, lineHeight: 1.5, marginTop: 10, marginBottom: 0 }}>
                    {mc.hitGoalPct >= 70 ? `At your current win rate (${(mc.wr * 100).toFixed(1)}%) and volume (~${Math.round(mc.remainingBets / gp.remainingDays)} bets/day), you're on strong track. ` : mc.hitGoalPct >= 40 ? `You have a realistic shot but need consistency. ` : `You'll need to increase volume or edge to hit this target. `}
                    {gp.projectedTotal >= gp.targetAmount ? `Linear projection puts you at ${formatMoney(gp.projectedTotal)}, exceeding your goal by ${formatMoney(gp.projectedTotal - gp.targetAmount)}.` : `You need ${formatMoney(gp.neededDailyRate)}/day (vs current ${formatMoney(gp.dailyRate)}/day) to close the gap.`}
                    {mc.p50 > gp.targetAmount && ` Median simulation outcome: ${formatMoney(mc.p50)} — variance-adjusted projection beats your goal.`}
                  </p>
                </div>
              )}
            </div>
          );
        })() : (
          <div style={{ textAlign: "center", padding: "20px 0", color: c.textDim }}>
            <p style={{ fontSize: 13, margin: "0 0 8px" }}>Set a profit target to track your pace and see variance projections</p>
          </div>
        )}
      </div>

      {/* ─── Sport/League Breakdown ─── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: c.text, margin: 0, fontFamily: "'Space Grotesk', sans-serif" }}>Breakdown</h3>
          <select value={filterSport} onChange={e => { setFilterSport(e.target.value); setFilterLeague("All"); }} style={selectStyle}><option value="All">All Sports</option>{SPORTS.map(s => <option key={s} value={s}>{s}</option>)}</select>
          <select value={filterLeague} onChange={e => setFilterLeague(e.target.value)} style={selectStyle}><option value="All">All Leagues</option>{(filterSport === "All" ? ALL_LEAGUES : (LEAGUES[filterSport] || [])).map(l => <option key={l} value={l}>{l}</option>)}</select>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} style={selectStyle}><option value="All">All Types</option>{BET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
            <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 16px", fontFamily: "'JetBrains Mono', monospace" }}>Profit by League</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {Object.entries(dashStats.byLeague).sort((a, b) => b[1].profit - a[1].profit).map(([league, data]) => {
                const mx = Math.max(...Object.values(dashStats.byLeague).map(d => Math.abs(d.profit)));
                return (<div key={league} style={{ display: "flex", flexDirection: "column", gap: 4 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 13, color: c.text, fontWeight: 600 }}>{league}</span><span style={{ fontSize: 10, color: c.textDim }}>{data.sport}</span></div><div style={{ display: "flex", gap: 12, alignItems: "center" }}><span style={{ fontSize: 11, color: c.textDim }}>{data.count} bets · {(((data.count - (data.pushes || 0)) ? (data.wins / (data.count - (data.pushes || 0))) * 100 : 0)).toFixed(0)}%</span><span style={{ fontSize: 14, fontWeight: 600, color: data.profit >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace", minWidth: 70, textAlign: "right" }}>{formatMoney(data.profit)}</span></div></div><MiniBar value={data.profit} max={mx} color={data.profit >= 0 ? c.green : c.red} /></div>);
              })}
            </div>
          </div>
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
            <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 16px", fontFamily: "'JetBrains Mono', monospace" }}>Profit by Sport</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {Object.entries(dashStats.bySport).sort((a, b) => b[1].profit - a[1].profit).map(([sport, data]) => {
                const mx = Math.max(...Object.values(dashStats.bySport).map(d => Math.abs(d.profit)));
                const leaguesInSport = Object.entries(dashStats.byLeague).filter(([, v]) => v.sport === sport);
                const leagueList = leaguesInSport.map(([l]) => l).join(", ");
                return (<div key={sport} style={{ display: "flex", flexDirection: "column", gap: 4 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 13, color: c.text, fontWeight: 600 }}>{sport}</span>{leaguesInSport.length > 0 && <span style={{ fontSize: 10, color: c.textDim }}>{leagueList}</span>}</div><div style={{ display: "flex", gap: 12, alignItems: "center" }}><span style={{ fontSize: 11, color: c.textDim }}>{data.count} bets · {(((data.count - (data.pushes || 0)) ? (data.wins / (data.count - (data.pushes || 0))) * 100 : 0)).toFixed(0)}%</span><span style={{ fontSize: 14, fontWeight: 600, color: data.profit >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace", minWidth: 70, textAlign: "right" }}>{formatMoney(data.profit)}</span></div></div><MiniBar value={data.profit} max={mx} color={data.profit >= 0 ? c.green : c.red} /></div>);
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Year Switcher ─── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: c.text, margin: 0, fontFamily: "'Space Grotesk', sans-serif" }}>Monthly Performance</h3>
        <div style={{ display: "flex", gap: 4 }}>
          {[...availableYears, "all"].map(yr => (
            <button key={yr} onClick={() => setDashYear(yr)} style={{
              ...btnSecondary, padding: "6px 14px", fontSize: 12,
              background: dashYear === yr ? "rgba(255,255,255,0.08)" : "transparent",
              borderColor: dashYear === yr ? c.borderLight : c.border,
              color: dashYear === yr ? c.text : c.textDim,
              fontWeight: dashYear === yr ? 600 : 400,
            }}>{yr === "all" ? "All Time" : yr}</button>
          ))}
        </div>
      </div>

      {/* ─── Monthly Profit Bar Chart ─── */}
      {monthlyData.length > 0 && (() => {
        const maxAbs = Math.max(1, ...monthlyData.map(m => Math.abs(m.profit)));
        const chartH = 220;
        const topPad = 28;
        const botPad = 26;
        const midY = topPad + (chartH - topPad - botPad) / 2;
        const barArea = chartH - topPad - botPad;
        const n = monthlyData.length;
        // Always base layout on 12 slots minimum so partial years don't distort
        const slots = dashYear === "all" ? n : Math.max(12, n);
        const vbW = slots * 80;
        const gap = slots > 18 ? 3 : 8;
        const slotW = vbW / slots;
        const barW = slotW - gap;
        const needsScroll = slots > 16;
        return (
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: "22px 22px 14px" }}>
            <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 12px", fontFamily: "'JetBrains Mono', monospace" }}>Monthly Profit / Loss</h3>
            <div style={{ width: "100%", overflowX: needsScroll ? "auto" : "hidden" }}>
              <svg width={needsScroll ? vbW : "100%"} height={chartH} viewBox={`0 0 ${vbW} ${chartH}`} preserveAspectRatio={needsScroll ? "xMinYMid meet" : "xMidYMid meet"} style={{ display: "block" }}>
                <line x1="0" y1={midY} x2={vbW} y2={midY} stroke={c.border} strokeWidth="0.8" strokeDasharray="4,4" />
                {monthlyData.map((m, i) => {
                  const x = i * slotW + gap / 2;
                  const barH = (Math.abs(m.profit) / maxAbs) * (barArea / 2 - 4);
                  const y = m.profit >= 0 ? midY - barH : midY;
                  const col = m.profit >= 0 ? c.green : c.red;
                  const fs = slots > 18 ? 8 : slots > 14 ? 9 : 10;
                  return (
                    <g key={m.key}>
                      <rect x={x} y={y} width={barW} height={Math.max(barH, 2)} rx={4} fill={col} opacity={0.85} />
                      <text x={x + barW / 2} y={m.profit >= 0 ? y - 5 : y + barH + 13} fill={col} fontSize={fs} fontWeight="600" fontFamily="JetBrains Mono, monospace" textAnchor="middle">{formatMoney(m.profit)}</text>
                      <text x={x + barW / 2} y={chartH - 5} fill={c.textDim} fontSize={fs - 1} fontFamily="JetBrains Mono, monospace" textAnchor="middle">{m.label}</text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        );
      })()}

      {/* ─── Cumulative Profit Line Chart (interactive) ─── */}
      {monthlyData.length > 1 && (() => {
        const vals = monthlyData.map(m => m.cumulative);
        const minV = Math.min(0, ...vals);
        const maxV = Math.max(0, ...vals);
        const range = maxV - minV || 1;
        const chartH = 220;
        const padL = 16, padR = 16, padT = 20, padB = 32;
        const innerH = chartH - padT - padB;
        const zeroY = padT + (maxV / range) * innerH;
        const gridCount = 4;
        const gridLines = Array.from({ length: gridCount + 1 }, (_, i) => {
          const v = minV + (range / gridCount) * i;
          return { v, y: padT + ((maxV - v) / range) * innerH };
        });
        const lastVal = vals[vals.length - 1];
        const lineColor = lastVal >= 0 ? c.green : c.red;
        // We'll use viewBox-based coordinates for responsive width
        const vbW = 1000;
        const innerW = vbW - padL - padR;
        const points = monthlyData.map((m, i) => ({
          x: padL + (i / (monthlyData.length - 1)) * innerW,
          y: padT + ((maxV - m.cumulative) / range) * innerH,
        }));
        const lineD = points.length < 3
          ? points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")
          : (() => {
            // Catmull-Rom to cubic bezier for smooth curve
            let d = `M ${points[0].x} ${points[0].y}`;
            for (let i = 0; i < points.length - 1; i++) {
              const p0 = points[Math.max(0, i - 1)];
              const p1 = points[i];
              const p2 = points[i + 1];
              const p3 = points[Math.min(points.length - 1, i + 2)];
              const tension = 0.3;
              const cp1x = p1.x + (p2.x - p0.x) * tension;
              const cp1y = p1.y + (p2.y - p0.y) * tension;
              const cp2x = p2.x - (p3.x - p1.x) * tension;
              const cp2y = p2.y - (p3.y - p1.y) * tension;
              d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
            }
            return d;
          })();
        // Area path: smooth top + straight bottom back to zero
        const areaD = `${lineD} L ${points[points.length - 1].x} ${zeroY} L ${points[0].x} ${zeroY} Z`;
        const hIdx = hoveredCumIdx;
        return (
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: "22px 22px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Cumulative Profit</h3>
              {hIdx !== null && hIdx >= 0 && hIdx < monthlyData.length && (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, color: c.textDim }}>{monthlyData[hIdx].label}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: vals[hIdx] >= 0 ? c.green : c.red }}>{vals[hIdx] >= 0 ? "+" : ""}{formatMoney(vals[hIdx])}</span>
                </div>
              )}
            </div>
            <div style={{ width: "100%" }}>
              <svg width="100%" viewBox={`0 0 ${vbW} ${chartH}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}
                onMouseLeave={() => setHoveredCumIdx(null)}>
                {/* Grid lines (no labels) */}
                {gridLines.map((gl, i) => (
                  <line key={i} x1={padL} y1={gl.y} x2={vbW - padR} y2={gl.y} stroke={c.border} strokeWidth="0.5" strokeDasharray={Math.abs(gl.v) < 0.01 ? "none" : "3,3"} opacity={Math.abs(gl.v) < 0.01 ? 0.5 : 0.2} />
                ))}
                <defs>
                  <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity="0.18" />
                    <stop offset="100%" stopColor={lineColor} stopOpacity="0.01" />
                  </linearGradient>
                </defs>
                <path d={areaD} fill="url(#cumGrad)" />
                <path d={lineD} fill="none" stroke={lineColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                {/* Hover crosshair + dot */}
                {hIdx !== null && hIdx >= 0 && hIdx < points.length && (
                  <g>
                    <line x1={points[hIdx].x} y1={padT} x2={points[hIdx].x} y2={chartH - padB} stroke={c.textDim} strokeWidth="0.8" strokeDasharray="4,3" opacity="0.5" />
                    <circle cx={points[hIdx].x} cy={points[hIdx].y} r="5" fill={c.card} stroke={vals[hIdx] >= 0 ? c.green : c.red} strokeWidth="2.5" />
                    <text x={points[hIdx].x} y={points[hIdx].y - 12} fill={vals[hIdx] >= 0 ? c.green : c.red} fontSize="13" fontWeight="700" fontFamily="JetBrains Mono, monospace" textAnchor="middle">{vals[hIdx] >= 0 ? "+" : ""}{formatMoney(vals[hIdx])}</text>
                  </g>
                )}
                {/* X-axis labels */}
                {points.map((p, i) => {
                  const show = monthlyData.length <= 14 || i % Math.ceil(monthlyData.length / 12) === 0 || i === monthlyData.length - 1;
                  return show ? <text key={i} x={p.x} y={chartH - 8} fill={c.textDim} fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">{monthlyData[i].label}</text> : null;
                })}
                {/* Invisible hover zones */}
                {points.map((p, i) => {
                  const slotW = innerW / (monthlyData.length - 1 || 1);
                  const hx = i === 0 ? padL : p.x - slotW / 2;
                  const hw = i === 0 || i === points.length - 1 ? slotW / 2 + padL : slotW;
                  return (
                    <rect key={`h${i}`} x={i === 0 ? 0 : p.x - slotW / 2} y={0} width={i === 0 || i === points.length - 1 ? slotW / 2 + padL : slotW} height={chartH}
                      fill="transparent" style={{ cursor: "crosshair" }}
                      onMouseEnter={() => setHoveredCumIdx(i)}
                    />
                  );
                })}
              </svg>
            </div>
          </div>
        );
      })()}

      {/* ═══ EV vs Actual — Variance Analysis ═══ */}
      <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: "22px 22px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Expected Value vs Actual Profit</h3>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: c.textDim }}>CLV = avg(Pinnacle + Bookmaker + BetOnline)</span>
            <span style={{ width: 4, height: 4, borderRadius: "50%", background: c.textMuted }} />
            <span style={{ fontSize: 11, color: c.textDim }}>Live bets assume {evStats.live.edge}% edge</span>
          </div>
        </div>

        {/* Summary cards — clickable */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
          {[
            { id: "pregame", label: "Pre-Game Bets", sub: `${evStats.preGame.count} bets · Avg CLV ${evStats.preGame.avgClv >= 0 ? "+" : ""}${evStats.preGame.avgClv.toFixed(2)}%`, expected: evStats.preGame.expected, actual: evStats.preGame.actual, variance: evStats.preGame.variance, accent: c.blue, evColor: c.blue, actColor: "#6dd5ed" },
            { id: "live", label: "Live Bets", sub: `${evStats.live.count} bets · ${evStats.live.edge}% assumed edge`, expected: evStats.live.expected, actual: evStats.live.actual, variance: evStats.live.variance, accent: c.purple, evColor: c.purple, actColor: c.pink },
            { id: "combined", label: "Combined", sub: `${evStats.total.count} total bets`, expected: evStats.total.expected, actual: evStats.total.actual, variance: evStats.total.variance, accent: evStats.total.variance >= 0 ? c.green : c.red, evColor: c.cyan, actColor: c.green },
          ].map(card => {
            const isActive = evFocus === card.id;
            return (
              <div key={card.id} onClick={() => setEvFocus(card.id)} style={{
                background: isActive ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.015)",
                border: `1px solid ${isActive ? card.accent : c.border}`,
                borderRadius: 12, padding: 16, position: "relative", overflow: "hidden", cursor: "pointer",
                transition: "all 0.2s", boxShadow: isActive ? `0 0 0 1px ${card.accent}40, 0 4px 20px ${card.accent}10` : "none",
                opacity: isActive ? 1 : 0.7,
              }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: isActive ? 3 : 2, background: `linear-gradient(90deg, transparent, ${card.accent}, transparent)`, opacity: isActive ? 1 : 0.5 }} />
                <div style={{ fontSize: 12, fontWeight: 600, color: c.text, marginBottom: 2 }}>{card.label}</div>
                <div style={{ fontSize: 10, color: c.textDim, marginBottom: 12 }}>{card.sub}</div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: c.textDim }}>Expected EV</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: card.evColor, fontFamily: "'JetBrains Mono', monospace" }}>{card.expected >= 0 ? "+" : ""}{formatMoney(card.expected)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: c.textDim }}>Actual Profit</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: card.actual >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace" }}>{card.actual >= 0 ? "+" : ""}{formatMoney(card.actual)}</span>
                </div>
                <div style={{ borderTop: `1px solid ${c.border}`, paddingTop: 6, display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: c.textDim }}>Variance</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: card.variance >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace" }}>{card.variance >= 0 ? "+" : ""}{formatMoney(card.variance)}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Cumulative EV vs Actual — multi-line chart */}
        {evStats.cumCombined.length > 1 && (() => {
          const series = [
            { id: "pregame", data: evStats.cumPreGame, evColor: c.blue, actColor: "#6dd5ed", label: "Pre-Game" },
            { id: "live", data: evStats.cumLive, evColor: c.purple, actColor: c.pink, label: "Live" },
            { id: "combined", data: evStats.cumCombined, evColor: c.cyan, actColor: c.green, label: "Combined" },
          ];
          // Compute global min/max across all visible series
          const allVals = series.flatMap(s => s.data.flatMap(d => [d.cumExpected, d.cumActual]));
          const minV = Math.min(0, ...allVals);
          const maxV = Math.max(0, ...allVals);
          const range = maxV - minV || 1;
          const refData = evStats.cumCombined;
          const vbW = 1000, chartH = 200;
          const padL = 16, padR = 16, padT = 20, padB = 28;
          const innerW = vbW - padL - padR, innerH = chartH - padT - padB;
          const toX = (i) => padL + (i / (refData.length - 1)) * innerW;
          const toY = (v) => padT + ((maxV - v) / range) * innerH;
          const zeroY = toY(0);
          const makeLine = (data, field) => data.map((d, i) => `${i === 0 ? "M" : "L"} ${toX(i)} ${toY(d[field])}`).join(" ");

          return (
            <div>
              {/* Legend */}
              <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
                {series.map(s => {
                  const isFocused = evFocus === s.id;
                  return (
                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, opacity: isFocused ? 1 : 0.35, transition: "opacity 0.2s", cursor: "pointer" }} onClick={() => setEvFocus(s.id)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <div style={{ width: 14, height: 3, borderRadius: 2, background: s.evColor, opacity: 0.8 }} />
                        <div style={{ width: 14, height: 3, borderRadius: 2, background: s.actColor }} />
                      </div>
                      <span style={{ fontSize: 11, color: isFocused ? c.text : c.textDim, fontWeight: isFocused ? 600 : 400 }}>{s.label}</span>
                    </div>
                  );
                })}
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
                  <div style={{ width: 14, height: 2, borderRadius: 1, borderTop: `2px dashed ${c.textDim}` }} />
                  <span style={{ fontSize: 10, color: c.textDim }}>EV</span>
                  <div style={{ width: 14, height: 3, borderRadius: 2, background: c.textDim, marginLeft: 8 }} />
                  <span style={{ fontSize: 10, color: c.textDim }}>Actual</span>
                </div>
              </div>
              <svg width="100%" viewBox={`0 0 ${vbW} ${chartH}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
                <line x1={padL} y1={zeroY} x2={vbW - padR} y2={zeroY} stroke={c.border} strokeWidth="0.5" strokeDasharray="4,4" opacity="0.4" />
                {/* Draw all 3 series — dimmed ones first, focused last */}
                {[...series.filter(s => s.id !== evFocus), ...series.filter(s => s.id === evFocus)].map(s => {
                  const isFocused = evFocus === s.id;
                  const opacity = isFocused ? 1 : 0.15;
                  const evD = makeLine(s.data, "cumExpected");
                  const actD = makeLine(s.data, "cumActual");
                  const lastI = s.data.length - 1;
                  const lastExp = s.data[lastI].cumExpected;
                  const lastAct = s.data[lastI].cumActual;
                  const lastX = toX(lastI);
                  // Variance fill only for focused
                  const fillD = s.data.map((d, i) => `${i === 0 ? "M" : "L"} ${toX(i)} ${toY(d.cumActual)}`).join(" ") +
                    [...s.data].reverse().map((d, i) => `L ${toX(s.data.length - 1 - i)} ${toY(d.cumExpected)}`).join(" ") + " Z";
                  return (
                    <g key={s.id} style={{ transition: "opacity 0.3s" }} opacity={opacity}>
                      {isFocused && <path d={fillD} fill={lastAct >= lastExp ? c.green : c.red} opacity="0.06" />}
                      <path d={evD} fill="none" stroke={s.evColor} strokeWidth={isFocused ? 2 : 1.5} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="6,3" />
                      <path d={actD} fill="none" stroke={s.actColor} strokeWidth={isFocused ? 2.5 : 1.5} strokeLinecap="round" strokeLinejoin="round" />
                      {isFocused && (<>
                        <circle cx={lastX} cy={toY(lastExp)} r="4" fill={c.card} stroke={s.evColor} strokeWidth="2" />
                        <circle cx={lastX} cy={toY(lastAct)} r="4" fill={c.card} stroke={s.actColor} strokeWidth="2" />
                        <text x={lastX - 6} y={toY(lastExp) + (lastExp > lastAct ? 14 : -8)} fill={s.evColor} fontSize="11" fontWeight="700" fontFamily="JetBrains Mono, monospace" textAnchor="end">{formatMoney(lastExp)}</text>
                        <text x={lastX - 6} y={toY(lastAct) + (lastAct > lastExp ? -8 : 14)} fill={s.actColor} fontSize="11" fontWeight="700" fontFamily="JetBrains Mono, monospace" textAnchor="end">{formatMoney(lastAct)}</text>
                      </>)}
                    </g>
                  );
                })}
                {/* X labels */}
                {refData.map((d, i) => {
                  const show = refData.length <= 14 || i % Math.ceil(refData.length / 12) === 0 || i === refData.length - 1;
                  return show ? <text key={i} x={toX(i)} y={chartH - 6} fill={c.textDim} fontSize="9" fontFamily="JetBrains Mono, monospace" textAnchor="middle">{d.label}</text> : null;
                })}
              </svg>
            </div>
          );
        })()}
      </div>

      {/* Variance status bar — reflects focused view */}
      {(() => {
        const focusData = evFocus === "pregame" ? evStats.preGame : evFocus === "live" ? evStats.live : evStats.total;
        const focusLabel = evFocus === "pregame" ? "Pre-Game" : evFocus === "live" ? "Live" : "Combined";
        const v = focusData.variance;
        return (
          <div style={{ background: v >= 0 ? "rgba(0,230,138,0.06)" : "rgba(255,77,106,0.06)", border: `1px solid ${v >= 0 ? "rgba(0,230,138,0.15)" : "rgba(255,77,106,0.15)"}`, borderRadius: 14, padding: "16px 22px", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "all 0.3s" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: c.text }}>{focusLabel}: {v >= 0 ? "Running above expectation" : "Running below expectation"}</div>
              <div style={{ fontSize: 12, color: c.textDim, marginTop: 2 }}>
                {v >= 0 ? "Your actual results are outperforming your expected value — positive variance." : "Your actual results are below expected EV — this is normal short-term variance, stay the course if your edge is positive."}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: c.textDim, textTransform: "uppercase", letterSpacing: 1 }}>{focusLabel} Variance</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: v >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace" }}>{v >= 0 ? "+" : ""}{formatMoney(v)}</div>
            </div>
          </div>
        );
      })()}

      {/* ═══ Time-of-Day Scatter Plot ═══ */}
      {(() => {
        // Extract hour (EST) from each bet's placedAt timestamp
        const allScatterPoints = dashFiltered.map(b => {
          if (!b.placedAt || b.placedAt.length < 11) return null;
          const d = new Date(b.placedAt);
          if (isNaN(d.getTime())) return null;
          // Convert to EST (UTC-5)
          const utcH = d.getUTCHours() + d.getUTCMinutes() / 60;
          let estH = utcH - 5;
          if (estH < 0) estH += 24;
          return { hour: estH, profit: b.profit, result: b.result, stake: b.stake, type: b.type, sport: b.sport, league: b.league || b.sport, event: b.event };
        }).filter(Boolean);

        if (allScatterPoints.length < 5) return null;

        // Apply scatter filters
        const points = allScatterPoints.filter(p => {
          if (!scatterShowWins && p.result === "won") return false;
          if (!scatterShowLosses && p.result === "lost") return false;
          if (scatterSport !== "All" && p.league !== scatterSport && p.sport !== scatterSport) return false;
          if (scatterType === "Live" && p.type !== "Live") return false;
          if (scatterType === "Pre-game" && p.type === "Live") return false;
          return true;
        });

        // Get unique sports in this dataset for filter options
        const scatterSports = [...new Set(allScatterPoints.map(p => p.league))].sort();

        // Bin by hour for summary stats
        const hourBins = Array.from({ length: 24 }, () => ({ profit: 0, count: 0, wins: 0, stake: 0 }));
        points.forEach(p => { const h = Math.floor(p.hour) % 24; hourBins[h].profit += p.profit; hourBins[h].count++; hourBins[h].stake += p.stake; if (p.result === "won") hourBins[h].wins++; });

        // Chart dimensions
        const W = 740, H = 260, padL = 50, padR = 20, padT = 20, padB = 36;
        const chartW = W - padL - padR;
        const chartH = H - padT - padB;

        if (points.length === 0) return (
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Time-of-Day Performance (EST)</h3>
              <span style={{ fontSize: 11, color: c.textDim }}>0 of {allScatterPoints.length} bets</span>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1px solid ${c.border}` }}>
                <button onClick={() => setScatterShowWins(v => !v)} style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer", background: scatterShowWins ? "rgba(0,230,138,0.15)" : "rgba(255,255,255,0.02)", color: scatterShowWins ? c.green : c.textMuted }}>Wins</button>
                <button onClick={() => setScatterShowLosses(v => !v)} style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, border: "none", borderLeft: `1px solid ${c.border}`, cursor: "pointer", background: scatterShowLosses ? "rgba(255,77,106,0.15)" : "rgba(255,255,255,0.02)", color: scatterShowLosses ? c.red : c.textMuted }}>Losses</button>
              </div>
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1px solid ${c.border}` }}>
                {["All", "Pre-game", "Live"].map(t => (
                  <button key={t} onClick={() => setScatterType(t)} style={{ padding: "4px 12px", fontSize: 11, fontWeight: scatterType === t ? 600 : 400, border: "none", borderLeft: t !== "All" ? `1px solid ${c.border}` : "none", cursor: "pointer", background: scatterType === t ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.02)", color: scatterType === t ? c.text : c.textMuted }}>{t}</button>
                ))}
              </div>
              <select value={scatterSport} onChange={e => setScatterSport(e.target.value)} style={{ ...selectStyle, padding: "4px 10px", fontSize: 11 }}>
                <option value="All">All Leagues</option>
                {scatterSports.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ padding: "40px 0", textAlign: "center", color: c.textDim, fontSize: 13 }}>No bets match the current filters</div>
          </div>
        );

        const maxAbsProfit = Math.max(1, ...points.map(p => Math.abs(p.profit)));
        const toX = (h) => padL + (h / 24) * chartW;
        const toY = (profit) => padT + (1 - (profit + maxAbsProfit) / (2 * maxAbsProfit)) * chartH;
        const zeroY = toY(0);

        // Hourly P&L bars (background)
        const maxHourProfit = Math.max(1, ...hourBins.map(b => Math.abs(b.profit)));

        return (
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Time-of-Day Performance (EST)</h3>
              <span style={{ fontSize: 11, color: c.textDim }}>{points.length}{points.length !== allScatterPoints.length ? ` of ${allScatterPoints.length}` : ""} bets</span>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              {/* Win/Loss toggles */}
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1px solid ${c.border}` }}>
                <button onClick={() => setScatterShowWins(v => !v)} style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer", background: scatterShowWins ? "rgba(0,230,138,0.15)" : "rgba(255,255,255,0.02)", color: scatterShowWins ? c.green : c.textMuted, transition: "all 0.15s" }}>Wins</button>
                <button onClick={() => setScatterShowLosses(v => !v)} style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, border: "none", borderLeft: `1px solid ${c.border}`, cursor: "pointer", background: scatterShowLosses ? "rgba(255,77,106,0.15)" : "rgba(255,255,255,0.02)", color: scatterShowLosses ? c.red : c.textMuted, transition: "all 0.15s" }}>Losses</button>
              </div>
              {/* Type toggle */}
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1px solid ${c.border}` }}>
                {["All", "Pre-game", "Live"].map(t => (
                  <button key={t} onClick={() => setScatterType(t)} style={{ padding: "4px 12px", fontSize: 11, fontWeight: scatterType === t ? 600 : 400, border: "none", borderLeft: t !== "All" ? `1px solid ${c.border}` : "none", cursor: "pointer", background: scatterType === t ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.02)", color: scatterType === t ? c.text : c.textMuted, transition: "all 0.15s" }}>{t}</button>
                ))}
              </div>
              {/* Sport filter */}
              <select value={scatterSport} onChange={e => setScatterSport(e.target.value)} style={{ ...selectStyle, padding: "4px 10px", fontSize: 11 }}>
                <option value="All">All Leagues</option>
                {scatterSports.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 260 }}>
              {/* Hourly P&L bars behind scatter */}
              {hourBins.map((bin, h) => {
                if (bin.count === 0) return null;
                const barH = Math.abs(bin.profit) / maxHourProfit * (chartH / 2 - 4);
                const x = toX(h);
                const bw = chartW / 24 - 1;
                return <rect key={`bar${h}`} x={x} y={bin.profit >= 0 ? zeroY - barH : zeroY} width={bw} height={barH} fill={bin.profit >= 0 ? "rgba(0,230,138,0.06)" : "rgba(255,77,106,0.06)"} rx={2} />;
              })}
              {/* Grid lines */}
              {[6, 9, 12, 15, 18, 21].map(h => (
                <line key={h} x1={toX(h)} x2={toX(h)} y1={padT} y2={H - padB} stroke={c.border} strokeWidth={0.4} strokeDasharray="3,4" />
              ))}
              {/* Zero line */}
              <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} stroke={c.borderLight} strokeWidth={0.8} />
              {/* Y-axis labels */}
              {[-maxAbsProfit, -maxAbsProfit / 2, 0, maxAbsProfit / 2, maxAbsProfit].map((v, i) => (
                <text key={i} x={padL - 6} y={toY(v) + 3} fill={c.textDim} fontSize={8} textAnchor="end" fontFamily="JetBrains Mono">{v >= 0 ? "+" : ""}{v >= 1000 || v <= -1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`}</text>
              ))}
              {/* X-axis hour labels */}
              {[0, 3, 6, 9, 12, 15, 18, 21].map(h => (
                <text key={h} x={toX(h)} y={H - 8} fill={c.textDim} fontSize={9} textAnchor="middle" fontFamily="JetBrains Mono">{h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`}</text>
              ))}
              {/* Scatter dots — draws wins last so they're on top */}
              {[...points].sort((a, b) => (a.result === "won" ? 1 : 0) - (b.result === "won" ? 1 : 0)).map((p, i) => {
                const r = Math.max(2.5, Math.min(6, (p.stake / 200) * 4));
                return <circle key={i} cx={toX(p.hour)} cy={toY(p.profit)} r={r} fill={p.result === "won" ? c.green : p.result === "push" ? c.amber : c.red} opacity={0.55} />;
              })}
              {/* Axis labels */}
              <text x={padL + chartW / 2} y={H - 0} fill={c.textDim} fontSize={9} textAnchor="middle" fontFamily="JetBrains Mono">Time of Day (EST)</text>
              <text x={12} y={padT + chartH / 2} fill={c.textDim} fontSize={9} textAnchor="middle" fontFamily="JetBrains Mono" transform={`rotate(-90,12,${padT + chartH / 2})`}>Profit / Loss</text>
            </svg>
            {/* Legend + peak hours */}
            <div style={{ display: "flex", gap: 20, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}><circle style={{ width: 8, height: 8, borderRadius: "50%", background: c.green, display: "inline-block", opacity: 0.7 }} /><span style={{ fontSize: 11, color: c.textDim }}>Win</span></div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: c.red, display: "inline-block", opacity: 0.7 }} /><span style={{ fontSize: 11, color: c.textDim }}>Loss</span></div>
              <span style={{ fontSize: 11, color: c.textDim }}>Dot size = stake</span>
              <span style={{ fontSize: 11, color: c.textDim }}>Background bars = hourly P&L</span>
            </div>
            {/* Hourly summary strip */}
            <div style={{ display: "flex", gap: 2, marginTop: 14 }}>
              {hourBins.map((bin, h) => {
                if (bin.count === 0) return <div key={h} style={{ flex: 1, height: 28, background: "rgba(255,255,255,0.015)", borderRadius: 3 }} />;
                const roi = bin.stake > 0 ? (bin.profit / bin.stake) * 100 : 0;
                const intensity = Math.min(1, Math.abs(roi) / 20);
                return (
                  <div key={h} style={{ flex: 1, height: 28, background: roi >= 0 ? `rgba(0,230,138,${0.08 + intensity * 0.2})` : `rgba(255,77,106,${0.08 + intensity * 0.2})`, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", cursor: "default" }} title={`${h === 0 ? "12am" : h < 12 ? h + "am" : h === 12 ? "12pm" : (h - 12) + "pm"}: ${bin.count} bets · ${roi >= 0 ? "+" : ""}${roi.toFixed(0)}% ROI · ${bin.profit >= 0 ? "+" : ""}$${Math.round(bin.profit)}`}>
                    <span style={{ fontSize: 7, color: roi >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{roi >= 0 ? "+" : ""}{roi.toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 8, color: c.textDim, fontFamily: "'JetBrains Mono', monospace" }}>12am</span>
              <span style={{ fontSize: 8, color: c.textDim, fontFamily: "'JetBrains Mono', monospace" }}>12pm</span>
              <span style={{ fontSize: 8, color: c.textDim, fontFamily: "'JetBrains Mono', monospace" }}>11pm</span>
            </div>
          </div>
        );
      })()}

      {/* ═══ Monte Carlo Variance Bands ═══ */}
      {mcData && (
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Monte Carlo Simulation</h3>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: c.textDim }}>{mcData.sims.toLocaleString()} sims · {mcData.n} bets · {(mcData.wr * 100).toFixed(1)}% WR · seed {mcSeed}</span>
                <button onClick={() => setMcSeed(s => s + 1)} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ display: "inline-block", transition: "transform 0.3s" }}>⟳</span> Re-roll
                </button>
              </div>
            </div>
            <svg viewBox={`0 0 ${mcData.W} ${mcData.H}`} style={{ width: "100%", height: 220 }}>
              <path d={mcData.area95} fill="rgba(99,102,241,0.08)" />
              <path d={mcData.area75} fill="rgba(99,102,241,0.15)" />
              <line x1={mcData.padL} x2={mcData.W - mcData.padR} y1={mcData.toY(0)} y2={mcData.toY(0)} stroke={c.border} strokeWidth={0.5} strokeDasharray="4,4" />
              <path d={mcData.pathP50} stroke="rgba(99,102,241,0.5)" strokeWidth={1.2} fill="none" strokeDasharray="4,3" />
              <path d={mcData.pathP5} stroke="rgba(239,68,68,0.3)" strokeWidth={0.8} fill="none" strokeDasharray="2,3" />
              <path d={mcData.pathP95} stroke="rgba(16,185,129,0.3)" strokeWidth={0.8} fill="none" strokeDasharray="2,3" />
              <path d={mcData.pathActual} stroke={c.green} strokeWidth={2.5} fill="none" />
              <circle cx={mcData.toX(mcData.checkpoints - 1)} cy={mcData.toY(mcData.finalActual)} r={4} fill={c.green} />
              <text x={mcData.W - mcData.padR + 2} y={mcData.toY(mcData.percentiles.p95[mcData.checkpoints - 1]) + 3} fill="rgba(16,185,129,0.5)" fontSize={8} fontFamily="JetBrains Mono">95th</text>
              <text x={mcData.W - mcData.padR + 2} y={mcData.toY(mcData.percentiles.p50[mcData.checkpoints - 1]) + 3} fill="rgba(99,102,241,0.6)" fontSize={8} fontFamily="JetBrains Mono">50th</text>
              <text x={mcData.W - mcData.padR + 2} y={mcData.toY(mcData.percentiles.p5[mcData.checkpoints - 1]) + 3} fill="rgba(239,68,68,0.5)" fontSize={8} fontFamily="JetBrains Mono">5th</text>
              {mcData.cpIndices.filter((_, i) => i % 4 === 3 || i === 0).map((cp) => (
                <text key={cp} x={mcData.toX(mcData.cpIndices.indexOf(cp))} y={mcData.H - 2} fill={c.textDim} fontSize={8} textAnchor="middle" fontFamily="JetBrains Mono">{cp}</text>
              ))}
            </svg>
            <div style={{ display: "flex", gap: 20, marginTop: 14, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 20, height: 3, background: c.green, borderRadius: 2 }} /><span style={{ fontSize: 11, color: c.textDim }}>Your actual results</span></div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 20, height: 8, background: "rgba(99,102,241,0.15)", borderRadius: 2 }} /><span style={{ fontSize: 11, color: c.textDim }}>25th–75th percentile</span></div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 20, height: 8, background: "rgba(99,102,241,0.08)", borderRadius: 2 }} /><span style={{ fontSize: 11, color: c.textDim }}>5th–95th percentile</span></div>
              <div style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: parseInt(mcData.actualPercentile) >= 50 ? c.green : c.red }}>You're at the {mcData.actualPercentile}th percentile</div>
            </div>
            <p style={{ fontSize: 12, color: c.textDim, lineHeight: 1.6, marginTop: 12, marginBottom: 0 }}>
              Based on {mcData.sims.toLocaleString()} simulated bankroll paths using your actual win rate ({(mcData.wr * 100).toFixed(1)}%) and average win/loss amounts. The bands show where random outcomes land — if your green line is within the shaded area, your results are within normal variance.
            </p>
          </div>
      )}

    </div>
  );

  /* ═══ CALENDAR ═══ */
  const renderCalendar = () => {
    const mb = profileBets.filter(b => { const d = new Date(b.date); return d.getMonth() === calMonth && d.getFullYear() === calYear; });
    const isDay = selectedDay && selectedDay.bets.length > 0;
    const sb = isDay ? selectedDay.bets : mb;
    const sp = sb.reduce((s, b) => s + b.profit, 0);
    const sw = sb.filter(b => b.result === "won").length;
    const sl = sb.filter(b => b.result === "lost").length;
    const sp2 = sb.filter(b => b.result === "push").length;
    const sStake = sb.reduce((s, b) => s + b.stake, 0);
    const sRoi = sStake > 0 ? (sp / sStake) * 100 : 0;
    const label = isDay ? selectedDay.date : `${MONTHS[calMonth]} ${calYear}`;
    return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Stats bar — shows day stats when selected, month stats otherwise */}
      <div style={{ background: c.card, border: `1px solid ${isDay ? c.blue + "44" : c.border}`, borderRadius: 16, padding: 22, transition: "all 0.25s" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: isDay ? c.blue : c.textDim, textTransform: "uppercase", letterSpacing: 1, fontFamily: "'JetBrains Mono', monospace" }}>{label}</span>
            {isDay && <button onClick={() => setSelectedDay(null)} style={{ ...btnSecondary, padding: "3px 10px", fontSize: 10 }}>✕ Back to month</button>}
          </div>
          {isDay && <span style={{ fontSize: 11, color: c.textDim }}>{sb.length} bet{sb.length !== 1 ? "s" : ""}</span>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 20 }}>
          <div><div style={{ fontSize: 11, color: c.textDim, textTransform: "uppercase", letterSpacing: 1 }}>P&L</div><div style={{ fontSize: 24, fontWeight: 700, color: sp >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{sp >= 0 ? "+" : ""}{formatMoney(sp)}</div></div>
          <div><div style={{ fontSize: 11, color: c.textDim, textTransform: "uppercase", letterSpacing: 1 }}>Record</div><div style={{ fontSize: 24, fontWeight: 700, color: c.text, fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{sw}-{sl}{sp2 > 0 ? `-${sp2}` : ""}</div></div>
          <div><div style={{ fontSize: 11, color: c.textDim, textTransform: "uppercase", letterSpacing: 1 }}>ROI</div><div style={{ fontSize: 24, fontWeight: 700, color: sRoi >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{sRoi >= 0 ? "+" : ""}{sRoi.toFixed(1)}%</div></div>
          <div><div style={{ fontSize: 11, color: c.textDim, textTransform: "uppercase", letterSpacing: 1 }}>Volume</div><div style={{ fontSize: 24, fontWeight: 700, color: c.purple, fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>${sStake.toLocaleString()}</div></div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0, fontFamily: "'Space Grotesk', sans-serif" }}>{MONTHS[calMonth]} {calYear}</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); } else setCalMonth(m => m - 1); setSelectedDay(null); }} style={navBtnStyle}>‹</button>
          <button onClick={() => { const now = new Date(); setCalMonth(now.getMonth()); setCalYear(now.getFullYear()); setSelectedDay(null); }} style={{ ...navBtnStyle, fontSize: 11, padding: "6px 10px" }}>Today</button>
          <button onClick={() => { if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); } else setCalMonth(m => m + 1); setSelectedDay(null); }} style={navBtnStyle}>›</button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {DAYS_HEADER.map(d => <div key={d} style={{ padding: "8px 0", textAlign: "center", fontSize: 11, color: c.textDim, textTransform: "uppercase", letterSpacing: 1 }}>{d}</div>)}
        {calendarData.map((cell, i) => {
          if (!cell) return <div key={`e${i}`} style={{ minHeight: 90 }} />;
          const intensity = cell.profit !== 0 ? Math.min(1, Math.abs(cell.profit) / maxAbsProfit) : 0;
          const bgColor = cell.bets.length === 0 ? "transparent" : cell.profit >= 0 ? `rgba(0,230,138,${0.06 + intensity * 0.18})` : `rgba(255,77,106,${0.06 + intensity * 0.18})`;
          const isSel = selectedDay?.date === cell.date;
          return (
            <div key={cell.date} onClick={() => cell.bets.length > 0 ? setSelectedDay(isSel ? null : cell) : setSelectedDay(null)}
              style={{ minHeight: 90, background: bgColor, border: `1px solid ${isSel ? c.blue : cell.bets.length > 0 ? c.border : "transparent"}`, borderRadius: 10, padding: "8px 10px", cursor: cell.bets.length > 0 ? "pointer" : "default", transition: "all 0.2s", boxShadow: isSel ? `0 0 0 1px ${c.blue}, inset 0 0 12px rgba(77,148,255,0.08)` : "none" }}>
              <div style={{ fontSize: 13, color: isSel ? c.blue : c.textDim, fontWeight: isSel ? 700 : 500, marginBottom: 4 }}>{cell.day}</div>
              {cell.bets.length > 0 && (<><div style={{ fontSize: 16, fontWeight: 700, color: cell.profit >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace" }}>{cell.profit >= 0 ? "+" : ""}{formatMoney(cell.profit)}</div><div style={{ fontSize: 10, color: c.textDim, marginTop: 2 }}>{cell.bets.length} bet{cell.bets.length > 1 ? "s" : ""}</div></>)}
            </div>
          );
        })}
      </div>
      {selectedDay && selectedDay.bets.length > 0 && (
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22, animation: "fadeIn .25s ease" }}>
          <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}`}</style>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{["Event", "Pick", "Type", "Odds", "Stake", "Book", "Result", "P&L"].map(h => <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: c.textDim, fontWeight: 500, borderBottom: `1px solid ${c.border}`, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{h}</th>)}</tr></thead>
            <tbody>{selectedDay.bets.map(b => (
              <tr key={b.id} style={{ borderBottom: `1px solid ${c.border}08` }}>
                <td style={{ padding: "10px", color: c.text }}>{b.event}</td>
                <td style={{ padding: "10px", color: c.text, fontWeight: 500 }}>{b.pick}</td>
                <td style={{ padding: "10px" }}><span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, background: c.blueDim, color: c.blue }}>{b.type}</span></td>
                <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace" }}>{formatOdds(b.odds)}</td>
                <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace" }}>${b.stake}</td>
                <td style={{ padding: "10px", fontSize: 11, color: c.textDim }}>{b.sportsbook}</td>
                <td style={{ padding: "10px" }}><span style={{ padding: "2px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: b.result === "won" ? c.greenDim : b.result === "push" ? c.amberDim : c.redDim, color: b.result === "won" ? c.green : b.result === "push" ? c.amber : c.red }}>{b.result.toUpperCase()}</span>{b.freeBet && <span style={{ marginLeft: 4, padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "rgba(168,85,247,0.12)", color: "#a855f7" }}>FREE</span>}</td>
                <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: b.profit >= 0 ? c.green : c.red }}>{b.profit >= 0 ? "+" : ""}{formatMoney(b.profit)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );};

  /* ═══ CLV ═══ */
  /* ═══ STRATEGY ANALYSIS ═══ */
  const strategyPlays = useMemo(() => {
    // Group bets by game: date + normalized team matchup
    const gameGroups = {};
    const getBetDir = (info) => {
      if (/\bOver\b/i.test(info)) return "over";
      if (/\bUnder\b/i.test(info)) return "under";
      return null;
    };
    const getBetNum = (info) => {
      const m = info.match(/(?:Over|Under)\s+([\d.]+)/i);
      return m ? parseFloat(m[1]) : null;
    };
    const getSpreadNum = (info) => {
      const m = info.match(/([+-]?\d+\.?\d*)\s*(?:Spread|Handicap|Point|POINT)/i);
      return m ? parseFloat(m[1]) : null;
    };
    const getMLPick = (info) => {
      if (/Moneyline|Winner|Money Line/i.test(info)) {
        return info.split(/\s+(?:Moneyline|Winner|Money Line)/i)[0].trim().slice(-30);
      }
      return null;
    };
    const normalizeEvent = (ev) => {
      const m = ev.match(/([A-Z][A-Za-z\s.'\-]+?)\s+(?:@|vs\.?|at|v)\s+([A-Z][A-Za-z\s.'\-]+)/);
      if (m) { const ts = [m[1].trim().slice(0,22), m[2].trim().slice(0,22)].sort(); return `${ts[0]}|${ts[1]}`; }
      return ev.slice(-40);
    };
    filtered.forEach((b, idx) => {
      const key = `${b.date}|${normalizeEvent(b.event)}`;
      if (!gameGroups[key]) gameGroups[key] = [];
      gameGroups[key].push({ ...b, _idx: idx });
    });

    const plays = { middle: [], ladder: [], liveArb: [], standard: [] };
    const taggedIds = new Set();

    Object.entries(gameGroups).forEach(([key, gBets]) => {
      if (gBets.length < 2) return;

      // Extract line info for each bet
      const enriched = gBets.map(b => ({
        ...b, dir: getBetDir(b.pick || b.event), num: getBetNum(b.pick || b.event),
        spreadNum: getSpreadNum(b.pick || b.event), mlPick: getMLPick(b.pick || b.event),
      }));

      const overs = enriched.filter(e => e.dir === "over" && e.num != null);
      const unders = enriched.filter(e => e.dir === "under" && e.num != null);
      const spreads = enriched.filter(e => e.spreadNum != null);

      // ── MIDDLE DETECTION: Over X + Under Y, Y > X, gap > 0 and <= 20
      for (const o of overs) {
        for (const u of unders) {
          const gap = u.num - o.num;
          if (gap > 0 && gap <= 20) {
            const ids = [o.id, u.id];
            const both = [o, u];
            const totalPL = both.reduce((s, b) => s + b.profit, 0);
            const bothWon = both.every(b => b.result === "won");
            const oneWon = both.filter(b => b.result === "won").length === 1;
            plays.middle.push({ bets: both, ids, gap, over: o.num, under: u.num, totalPL, bothWon, oneWon, date: o.date, event: o.event, books: [...new Set(both.map(b => b.sportsbook))] });
            ids.forEach(id => taggedIds.add(id));
          }
        }
      }

      // ── LADDER DETECTION: 3+ same-direction at different lines
      const overVals = [...new Set(overs.map(o => o.num))].sort((a,b) => a-b);
      const underVals = [...new Set(unders.map(u => u.num))].sort((a,b) => b-a);
      if (overVals.length >= 3) {
        const lBets = overs.filter(o => overVals.includes(o.num)).sort((a,b) => a.num - b.num);
        const totalPL = lBets.reduce((s, b) => s + b.profit, 0);
        const hit = lBets.filter(b => b.result === "won").length;
        plays.ladder.push({ bets: lBets, dir: "Over", lines: overVals, rungs: lBets.length, hit, totalPL, date: lBets[0].date, event: lBets[0].event });
        lBets.forEach(b => taggedIds.add(b.id));
      }
      if (underVals.length >= 3) {
        const lBets = unders.filter(u => underVals.includes(u.num)).sort((a,b) => b.num - a.num);
        const totalPL = lBets.reduce((s, b) => s + b.profit, 0);
        const hit = lBets.filter(b => b.result === "won").length;
        plays.ladder.push({ bets: lBets, dir: "Under", lines: underVals, rungs: lBets.length, hit, totalPL, date: lBets[0].date, event: lBets[0].event });
        lBets.forEach(b => taggedIds.add(b.id));
      }
      // Spread ladders: 3+ different spread numbers
      const spreadVals = [...new Set(spreads.map(s => s.spreadNum))].sort((a,b) => a-b);
      if (spreadVals.length >= 3) {
        const lBets = spreads.sort((a,b) => a.spreadNum - b.spreadNum);
        const totalPL = lBets.reduce((s, b) => s + b.profit, 0);
        const hit = lBets.filter(b => b.result === "won").length;
        plays.ladder.push({ bets: lBets, dir: "Spread", lines: spreadVals, rungs: lBets.length, hit, totalPL, date: lBets[0].date, event: lBets[0].event });
        lBets.forEach(b => taggedIds.add(b.id));
      }

      // ── LIVE ARBITRAGE: Over X + Under X at SAME number (opposite sides, same line)
      for (const o of overs) {
        for (const u of unders) {
          if (o.num === u.num && (o.type === "Live" || u.type === "Live")) {
            const both = [o, u];
            const totalPL = both.reduce((s, b) => s + b.profit, 0);
            const bothWon = both.every(b => b.result === "won");
            const totalStaked = both.reduce((s, b) => s + b.stake, 0);
            // Calculate if arb was profitable regardless of outcome (juice diff)
            const oImplied = Math.abs(o.odds) >= 100 ? (o.odds > 0 ? 100 / (o.odds + 100) : Math.abs(o.odds) / (Math.abs(o.odds) + 100)) : 0.5;
            const uImplied = Math.abs(u.odds) >= 100 ? (u.odds > 0 ? 100 / (u.odds + 100) : Math.abs(u.odds) / (Math.abs(u.odds) + 100)) : 0.5;
            const combinedVig = oImplied + uImplied;
            const isTrueArb = combinedVig < 1;
            plays.liveArb.push({ bets: both, totalPL, line: o.num, bothWon, isTrueArb, combinedVig, totalStaked, date: o.date, event: o.event, books: [...new Set(both.map(b => b.sportsbook))], oOdds: o.odds, uOdds: u.odds });
            both.forEach(b => taggedIds.add(b.id));
          }
        }
      }
      // Also check near-same lines (within 0.5 pts) for live arb attempts
      for (const o of overs) {
        for (const u of unders) {
          const diff = Math.abs(o.num - u.num);
          if (diff > 0 && diff <= 0.5 && (o.type === "Live" || u.type === "Live")) {
            const both = [o, u];
            if (both.some(b => taggedIds.has(b.id))) continue; // skip if already tagged as exact arb
            const totalPL = both.reduce((s, b) => s + b.profit, 0);
            const oImplied = Math.abs(o.odds) >= 100 ? (o.odds > 0 ? 100 / (o.odds + 100) : Math.abs(o.odds) / (Math.abs(o.odds) + 100)) : 0.5;
            const uImplied = Math.abs(u.odds) >= 100 ? (u.odds > 0 ? 100 / (u.odds + 100) : Math.abs(u.odds) / (Math.abs(u.odds) + 100)) : 0.5;
            const combinedVig = oImplied + uImplied;
            plays.liveArb.push({ bets: both, totalPL, line: `${o.num}/${u.num}`, bothWon: false, isTrueArb: combinedVig < 1, combinedVig, totalStaked: both.reduce((s, b) => s + b.stake, 0), date: o.date, event: o.event, books: [...new Set(both.map(b => b.sportsbook))], oOdds: o.odds, uOdds: u.odds });
            both.forEach(b => taggedIds.add(b.id));
          }
        }
      }
    });

    // Standard: all non-tagged bets
    const standardBets = filtered.filter(b => !taggedIds.has(b.id));
    const stdPL = standardBets.reduce((s, b) => s + b.profit, 0);
    const stdWins = standardBets.filter(b => b.result === "won").length;
    const stdGraded = standardBets.filter(b => b.result !== "push").length;

    // Summary stats for each strategy
    const summarize = (items) => {
      const totalPL = items.reduce((s, p) => s + p.totalPL, 0);
      const betCount = items.reduce((s, p) => s + p.bets.length, 0);
      const totalStake = items.reduce((s, p) => s + p.bets.reduce((ss, b) => ss + b.stake, 0), 0);
      const wins = items.filter(p => p.totalPL > 0).length;
      return { plays: items.length, betCount, totalPL, totalStake, roi: totalStake > 0 ? (totalPL / totalStake) * 100 : 0, winRate: items.length > 0 ? (wins / items.length) * 100 : 0 };
    };

    return {
      middle: { items: plays.middle, ...summarize(plays.middle) },
      ladder: { items: plays.ladder, ...summarize(plays.ladder) },
      liveArb: { items: plays.liveArb, ...summarize(plays.liveArb) },
      standard: { plays: 0, betCount: standardBets.length, totalPL: stdPL, totalStake: standardBets.reduce((s, b) => s + b.stake, 0), roi: standardBets.length ? (stdPL / standardBets.reduce((s, b) => s + b.stake, 0)) * 100 : 0, winRate: stdGraded ? (stdWins / stdGraded) * 100 : 0 },
      taggedCount: taggedIds.size,
    };
  }, [filtered]);

  const [stratFocus, setStratFocus] = useState("overview");

  const renderStrategy = () => {
    const sp = strategyPlays;
    const strategies = [
      { id: "middle", label: "Middles", icon: "⇿", desc: "Over X + Under Y on same game — win both if score lands in the gap", color: c.green, accent: "rgba(16,185,129,0.12)", ...sp.middle },
      { id: "ladder", label: "Ladders", icon: "☷", desc: "3+ bets at progressively different lines on the same game, same direction", color: c.blue, accent: "rgba(99,102,241,0.12)", ...sp.ladder },
      { id: "liveArb", label: "Live Arbitrage", icon: "⚡", desc: "Over X + Under X at same number during live play — exploit juice differences across shifting lines", color: c.purple, accent: "rgba(168,85,247,0.12)", ...sp.liveArb },
    ];
    const allStratPL = strategies.reduce((s, st) => s + st.totalPL, 0);
    const allStratBets = strategies.reduce((s, st) => s + st.betCount, 0);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header */}
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 8px", fontFamily: "'JetBrains Mono', monospace" }}>Strategy Detection</h3>
          <p style={{ fontSize: 13, color: c.textDim, lineHeight: 1.7, margin: 0 }}>
            Bets are grouped by game (date + matchup) then scanned for patterns. Middles look for opposing over/under with a gap. Ladders detect 3+ same-direction bets at different lines. Live scalps find opposing live bets on the same game. A single bet can appear in multiple strategies (e.g. part of a middle AND a ladder).
          </p>
        </div>

        {/* Overview KPI row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          <StatCard label="Strategy Bets" value={allStratBets} color={c.blue} sub={`${filtered.length ? Math.round((allStratBets / filtered.length) * 100) : 0}% of all bets`} />
          <StatCard label="Strategy P&L" value={`$${allStratPL >= 0 ? "+" : ""}${allStratPL.toFixed(0)}`} color={allStratPL >= 0 ? c.green : c.red} sub="Combined multi-bet plays" />
          <StatCard label="Standard P&L" value={`$${sp.standard.totalPL >= 0 ? "+" : ""}${sp.standard.totalPL.toFixed(0)}`} color={sp.standard.totalPL >= 0 ? c.green : c.red} sub={`${sp.standard.betCount} standalone bets`} />
          <StatCard label="Avg CLV" value={`${stats.avgCLV >= 0 ? "+" : ""}${stats.avgCLV.toFixed(2)}%`} color={stats.avgCLV >= 0 ? c.green : c.red} sub="Closing Line Value" />
        </div>

        {/* Strategy cards grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
          {strategies.map(st => (
            <div key={st.id} onClick={() => setStratFocus(stratFocus === st.id ? "overview" : st.id)} style={{ background: stratFocus === st.id ? st.accent : c.card, border: `1px solid ${stratFocus === st.id ? st.color + "55" : c.border}`, borderRadius: 16, padding: 20, cursor: "pointer", transition: "all 0.2s" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{st.icon}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: st.color }}>{st.label}</span>
                </div>
                <span style={{ fontSize: 11, color: c.textDim, fontFamily: "'JetBrains Mono', monospace" }}>{st.plays} plays</span>
              </div>
              <p style={{ fontSize: 11, color: c.textDim, lineHeight: 1.5, margin: "0 0 14px", minHeight: 30 }}>{st.desc}</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <div><div style={{ fontSize: 10, color: c.textDim }}>P&L</div><div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: st.totalPL >= 0 ? c.green : c.red }}>{st.totalPL >= 0 ? "+" : ""}{st.totalPL.toFixed(0)}</div></div>
                <div><div style={{ fontSize: 10, color: c.textDim }}>ROI</div><div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: st.roi >= 0 ? c.green : c.red }}>{st.roi.toFixed(1)}%</div></div>
                <div><div style={{ fontSize: 10, color: c.textDim }}>Win Rate</div><div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: st.winRate >= 50 ? c.green : c.red }}>{st.winRate.toFixed(0)}%</div></div>
              </div>
              <div style={{ marginTop: 10, fontSize: 11, color: c.textDim }}>{st.betCount} bets across {st.plays} plays</div>
            </div>
          ))}
        </div>

        {/* Detail panel for focused strategy */}
        {stratFocus !== "overview" && (() => {
          const st = strategies.find(s => s.id === stratFocus);
          if (!st || st.plays === 0) return <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24, textAlign: "center", color: c.textDim }}>No {st?.label || ""} plays detected in current data.</div>;
          const sortedItems = [...st.items].sort((a, b) => b.totalPL - a.totalPL);

          return (
            <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ fontSize: 20 }}>{st.icon}</span><h3 style={{ fontSize: 15, fontWeight: 700, color: st.color, margin: 0 }}>{st.label} — {st.plays} Plays</h3></div>
                <button onClick={() => setStratFocus("overview")} style={{ ...btnSecondary, fontSize: 11, padding: "4px 12px" }}>✕ Close</button>
              </div>

              {/* Plays table */}
              <div style={{ maxHeight: 500, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ borderBottom: `1px solid ${c.border}` }}>
                    <th style={{ textAlign: "left", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Date</th>
                    <th style={{ textAlign: "left", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Game</th>
                    {stratFocus === "middle" && <th style={{ textAlign: "center", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Lines</th>}
                    {stratFocus === "middle" && <th style={{ textAlign: "center", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Gap</th>}
                    {stratFocus === "ladder" && <th style={{ textAlign: "center", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Rungs</th>}
                    {stratFocus === "ladder" && <th style={{ textAlign: "center", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Lines</th>}
                    {stratFocus === "ladder" && <th style={{ textAlign: "center", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Hit</th>}
                    {stratFocus === "liveArb" && <th style={{ textAlign: "center", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Line</th>}
                    {stratFocus === "liveArb" && <th style={{ textAlign: "center", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Odds</th>}
                    {stratFocus === "liveArb" && <th style={{ textAlign: "center", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Vig</th>}
                    <th style={{ textAlign: "center", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Bets</th>
                    <th style={{ textAlign: "right", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Staked</th>
                    <th style={{ textAlign: "right", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>P&L</th>
                    <th style={{ textAlign: "center", padding: "8px 6px", color: c.textDim, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Result</th>
                  </tr></thead>
                  <tbody>
                    {sortedItems.map((play, i) => {
                      const staked = play.bets.reduce((s, b) => s + b.stake, 0);
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid ${c.border}08` }}>
                          <td style={{ padding: "10px 6px", color: c.textDim, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>{play.date}</td>
                          <td style={{ padding: "10px 6px", color: c.text, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{play.event?.slice(0, 45)}</td>
                          {stratFocus === "middle" && <td style={{ textAlign: "center", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: c.cyan }}>O {play.over} / U {play.under}</td>}
                          {stratFocus === "middle" && <td style={{ textAlign: "center", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: c.green }}>{play.gap}</td>}
                          {stratFocus === "ladder" && <td style={{ textAlign: "center", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: st.color }}>{play.rungs}</td>}
                          {stratFocus === "ladder" && <td style={{ textAlign: "center", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: c.textDim }}>{play.dir} {play.lines?.map(l => l.toString()).join(", ")}</td>}
                          {stratFocus === "ladder" && <td style={{ textAlign: "center", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", color: play.hit === play.rungs ? c.green : play.hit > 0 ? c.amber : c.red }}>{play.hit}/{play.rungs}</td>}
                          {stratFocus === "liveArb" && <td style={{ textAlign: "center", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: c.cyan }}>{play.line}</td>}
                          {stratFocus === "liveArb" && <td style={{ textAlign: "center", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: c.text }}>O {formatOdds(play.oOdds)} / U {formatOdds(play.uOdds)}</td>}
                          {stratFocus === "liveArb" && <td style={{ textAlign: "center", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, color: play.isTrueArb ? c.green : c.amber }}>{play.isTrueArb ? "✓ Arb" : `${(play.combinedVig * 100).toFixed(1)}%`}</td>}
                          <td style={{ textAlign: "center", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", color: c.text }}>{play.bets.length}</td>
                          <td style={{ textAlign: "right", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", color: c.textDim }}>${staked.toFixed(0)}</td>
                          <td style={{ textAlign: "right", padding: "10px 6px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: play.totalPL >= 0 ? c.green : c.red }}>{play.totalPL >= 0 ? "+" : ""}{play.totalPL.toFixed(2)}</td>
                          <td style={{ textAlign: "center", padding: "10px 6px" }}>
                            {play.bothWon ? <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "rgba(16,185,129,0.15)", color: c.green, fontWeight: 600 }}>BOTH WIN</span>
                              : play.totalPL > 0 ? <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "rgba(16,185,129,0.1)", color: c.green }}>PROFIT</span>
                              : play.totalPL === 0 ? <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "rgba(245,158,11,0.1)", color: c.amber }}>PUSH</span>
                              : <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "rgba(239,68,68,0.1)", color: c.red }}>LOSS</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Strategy-specific insights */}
              {stratFocus === "middle" && st.plays > 0 && (() => {
                const bothWins = st.items.filter(p => p.bothWon).length;
                const avgGap = st.items.reduce((s, p) => s + p.gap, 0) / st.plays;
                const profitByGap = {};
                st.items.forEach(p => { const g = Math.floor(p.gap); if (!profitByGap[g]) profitByGap[g] = { count: 0, pl: 0 }; profitByGap[g].count++; profitByGap[g].pl += p.totalPL; });
                return (
                  <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
                    <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Both Won</div><div style={{ fontSize: 18, fontWeight: 700, color: c.green, fontFamily: "'JetBrains Mono', monospace" }}>{bothWins}</div><div style={{ fontSize: 10, color: c.textDim }}>{st.plays > 0 ? ((bothWins / st.plays) * 100).toFixed(0) : 0}% of middles</div></div>
                    <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Avg Gap</div><div style={{ fontSize: 18, fontWeight: 700, color: c.cyan, fontFamily: "'JetBrains Mono', monospace" }}>{avgGap.toFixed(1)}</div><div style={{ fontSize: 10, color: c.textDim }}>points between lines</div></div>
                    <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Best Gap</div><div style={{ fontSize: 18, fontWeight: 700, color: c.blue, fontFamily: "'JetBrains Mono', monospace" }}>{Object.entries(profitByGap).sort((a,b) => b[1].pl - a[1].pl)[0]?.[0] || "—"}</div><div style={{ fontSize: 10, color: c.textDim }}>most profitable gap size</div></div>
                    <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Avg P&L/Play</div><div style={{ fontSize: 18, fontWeight: 700, color: st.totalPL >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace" }}>${(st.totalPL / st.plays).toFixed(0)}</div></div>
                  </div>
                );
              })()}
              {stratFocus === "ladder" && st.plays > 0 && (() => {
                const fullSweep = st.items.filter(p => p.hit === p.rungs).length;
                const avgRungs = st.items.reduce((s, p) => s + p.rungs, 0) / st.plays;
                const byDir = {};
                st.items.forEach(p => { if (!byDir[p.dir]) byDir[p.dir] = { count: 0, pl: 0 }; byDir[p.dir].count++; byDir[p.dir].pl += p.totalPL; });
                return (
                  <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
                    <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Full Sweeps</div><div style={{ fontSize: 18, fontWeight: 700, color: c.green, fontFamily: "'JetBrains Mono', monospace" }}>{fullSweep}</div><div style={{ fontSize: 10, color: c.textDim }}>{st.plays > 0 ? ((fullSweep / st.plays) * 100).toFixed(0) : 0}% all rungs hit</div></div>
                    <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Avg Rungs</div><div style={{ fontSize: 18, fontWeight: 700, color: c.blue, fontFamily: "'JetBrains Mono', monospace" }}>{avgRungs.toFixed(1)}</div></div>
                    {Object.entries(byDir).map(([dir, d]) => (
                      <div key={dir} style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>{dir} Ladders</div><div style={{ fontSize: 18, fontWeight: 700, color: d.pl >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace" }}>{d.pl >= 0 ? "+" : ""}${d.pl.toFixed(0)}</div><div style={{ fontSize: 10, color: c.textDim }}>{d.count} plays</div></div>
                    ))}
                  </div>
                );
              })()}
              {stratFocus === "liveArb" && st.plays > 0 && (() => {
                const trueArbs = st.items.filter(p => p.isTrueArb).length;
                const avgVig = st.items.reduce((s, p) => s + p.combinedVig, 0) / st.plays;
                const avgPL = st.totalPL / st.plays;
                const profitable = st.items.filter(p => p.totalPL > 0).length;
                return (
                  <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
                    <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>True Arbs</div><div style={{ fontSize: 18, fontWeight: 700, color: c.green, fontFamily: "'JetBrains Mono', monospace" }}>{trueArbs}</div><div style={{ fontSize: 10, color: c.textDim }}>combined vig {"<"} 100%</div></div>
                    <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Avg Combined Vig</div><div style={{ fontSize: 18, fontWeight: 700, color: avgVig < 1 ? c.green : c.amber, fontFamily: "'JetBrains Mono', monospace" }}>{(avgVig * 100).toFixed(1)}%</div><div style={{ fontSize: 10, color: c.textDim }}>{"<"}100% = arb exists</div></div>
                    <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Profitable</div><div style={{ fontSize: 18, fontWeight: 700, color: c.purple, fontFamily: "'JetBrains Mono', monospace" }}>{profitable}/{st.plays}</div><div style={{ fontSize: 10, color: c.textDim }}>{st.plays > 0 ? ((profitable / st.plays) * 100).toFixed(0) : 0}% of plays</div></div>
                    <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}><div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Avg P&L/Play</div><div style={{ fontSize: 18, fontWeight: 700, color: avgPL >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace" }}>${avgPL.toFixed(0)}</div></div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* Profitability comparison bar chart */}
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 20px", fontFamily: "'JetBrains Mono', monospace" }}>Strategy P&L Comparison</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[...strategies, { id: "standard", label: "Standard (No Strategy)", icon: "●", color: c.textDim, ...sp.standard }].map(st => {
              const maxAbs = Math.max(1, ...[...strategies, sp.standard].map(s => Math.abs(s.totalPL)));
              const barPct = Math.abs(st.totalPL) / maxAbs * 100;
              const isPos = st.totalPL >= 0;
              return (
                <div key={st.id} style={{ display: "grid", gridTemplateColumns: "160px 1fr 90px", alignItems: "center", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span>{st.icon}</span><span style={{ fontSize: 12, color: c.text, fontWeight: 600 }}>{st.label}</span></div>
                  <div style={{ position: "relative", height: 22, display: "flex", alignItems: "center" }}>
                    <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: c.border }} />
                    <div style={{ position: "absolute", [isPos ? "left" : "right"]: "50%", width: `${barPct / 2}%`, height: 18, borderRadius: 4, background: isPos ? st.color || c.green : c.red, opacity: 0.7, transition: "width 0.4s" }} />
                  </div>
                  <div style={{ textAlign: "right", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 13, color: isPos ? c.green : c.red }}>{isPos ? "+" : ""}${st.totalPL.toFixed(0)}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 10, color: c.textDim, paddingLeft: 160, paddingRight: 90 }}>
            <span>← Loss</span><span>Profit →</span>
          </div>
        </div>

        {/* CLV by strategy type */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
            <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 16px", fontFamily: "'JetBrains Mono', monospace" }}>CLV by Bet Type</h3>
            {(() => {
              const clvByType = {};
              stats.clvBets.forEach(b => { if (!clvByType[b.type]) clvByType[b.type] = { total: 0, count: 0 }; clvByType[b.type].total += b.clv; clvByType[b.type].count++; });
              return Object.entries(clvByType).sort((a, b) => (b[1].total / b[1].count) - (a[1].total / a[1].count)).map(([type, data]) => (
                <div key={type} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${c.border}08` }}><span style={{ color: c.text }}>{type}</span><div style={{ display: "flex", gap: 16 }}><span style={{ fontSize: 12, color: c.textDim }}>{data.count} bets</span><span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: (data.total / data.count) >= 0 ? c.green : c.red, minWidth: 60, textAlign: "right" }}>{(data.total / data.count) >= 0 ? "+" : ""}{(data.total / data.count).toFixed(2)}%</span></div></div>
              ));
            })()}
          </div>
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
            <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 16px", fontFamily: "'JetBrains Mono', monospace" }}>Profit by Sportsbook</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {Object.entries(stats.byBook).sort((a, b) => b[1].profit - a[1].profit).map(([book, data]) => {
                const mx = Math.max(1, ...Object.values(stats.byBook).map(d => Math.abs(d.profit)));
                return (<div key={book} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 0", borderBottom: `1px solid ${c.border}08` }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 13, color: c.text }}>{book}</span><div style={{ display: "flex", gap: 12, alignItems: "center" }}><span style={{ fontSize: 11, color: c.textDim }}>{data.count} bets</span><span style={{ fontSize: 14, fontWeight: 600, color: data.profit >= 0 ? c.green : c.red, fontFamily: "'JetBrains Mono', monospace", minWidth: 70, textAlign: "right" }}>{formatMoney(data.profit)}</span></div></div><MiniBar value={data.profit} max={mx} color={data.profit >= 0 ? c.green : c.red} /></div>);
              })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  /* ═══ BANKROLL ═══ */
  const renderBankroll = () => {
    const profKey = activeProfile === "all" ? null : activeProfile;
    const pBooks = profKey ? bankrollEntries.filter(e => (e.profile || profiles[0]?.id) === profKey) : bankrollEntries;
    const pHistory = profKey ? bankrollHistory.filter(t => (t.profile || profiles[0]?.id) === profKey) : bankrollHistory;
    const sortedBooks = [...pBooks].sort((a, b) => b.balance - a.balance);
    const maxBal = Math.max(1, ...sortedBooks.map(e => e.balance));
    const booksTotal = pBooks.reduce((s, e) => s + e.balance, 0);
    const curBankBal = profKey ? (bankBalances[profKey] || 0) : Object.values(bankBalances).reduce((s, v) => s + v, 0);
    const totalBR = booksTotal + curBankBal;
    const jan1 = profKey ? (jan1Bankrolls[profKey] || 0) : Object.values(jan1Bankrolls).reduce((s, v) => s + v, 0);
    const growthDollar = totalBR - jan1;
    const growthPct = jan1 > 0 ? (growthDollar / jan1) * 100 : 0;
    const profName = profKey ? profiles.find(p => p.id === profKey)?.name || profKey : "All Profiles";

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Jan 1 BR + Bank Balance config row */}
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 20, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: c.textDim }}>Jan 1 Starting BR:</span>
            {editingJan1 ? (
              <input type="number" defaultValue={jan1} style={{ ...fieldInput, width: 120, fontSize: 14 }} autoFocus onBlur={e => { if (profKey) setJan1Bankrolls(prev => ({ ...prev, [profKey]: parseFloat(e.target.value) || 0 })); setEditingJan1(false); }} onKeyDown={e => { if (e.key === "Enter") { if (profKey) setJan1Bankrolls(prev => ({ ...prev, [profKey]: parseFloat(e.target.value) || 0 })); setEditingJan1(false); }}} />
            ) : (
              <button onClick={() => setEditingJan1(true)} style={{ background: "transparent", border: `1px solid ${c.border}`, borderRadius: 8, padding: "5px 14px", color: c.amber, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>${jan1.toLocaleString()}</button>
            )}
          </div>
          <div style={{ width: 1, height: 28, background: c.border }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: c.textDim }}>Bank Balance (cash on hand):</span>
            {editingBankBal ? (
              <input type="number" defaultValue={curBankBal} style={{ ...fieldInput, width: 120, fontSize: 14 }} autoFocus onBlur={e => { if (profKey) setBankBalances(prev => ({ ...prev, [profKey]: parseFloat(e.target.value) || 0 })); setEditingBankBal(false); }} onKeyDown={e => { if (e.key === "Enter") { if (profKey) setBankBalances(prev => ({ ...prev, [profKey]: parseFloat(e.target.value) || 0 })); setEditingBankBal(false); }}} />
            ) : (
              <button onClick={() => setEditingBankBal(true)} style={{ background: "transparent", border: `1px solid ${c.border}`, borderRadius: 8, padding: "5px 14px", color: c.cyan, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>${curBankBal.toLocaleString()}</button>
            )}
          </div>
          <div style={{ marginLeft: "auto", fontSize: 11, color: c.textDim }}>Profile: <strong style={{ color: c.green }}>{profName}</strong></div>
        </div>

        {/* KPI row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          <StatCard label="Total Bankroll" value={`$${totalBR.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} color={c.green} sub={`${pBooks.length} books + bank`} />
          <StatCard label="Bankroll Growth $" value={`${growthDollar >= 0 ? "+" : ""}$${growthDollar.toLocaleString(undefined, { minimumFractionDigits: 0 })}`} color={growthDollar >= 0 ? c.green : c.red} sub={`vs $${jan1.toLocaleString()} on Jan 1`} />
          <StatCard label="Bankroll Growth %" value={`${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(1)}%`} color={growthPct >= 0 ? c.green : c.red} sub="Return on starting bankroll" />
          <StatCard label="Bank Balance" value={`$${curBankBal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} color={c.cyan} sub="Liquidity not in books" />
        </div>

        {/* Sportsbook balances */}
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
            <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Sportsbook Balances</h3>
            <button onClick={() => setShowAddBook(true)} style={{ ...btnSecondary, padding: "6px 14px", fontSize: 11 }}>+ Add Book</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {sortedBooks.map(entry => (
              <div key={entry.id} style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 12, padding: 16, position: "relative" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: c.text }}>{entry.book}</span>
                  <button onClick={() => setEditingBook(entry.id === editingBook ? null : entry.id)} style={{ background: "transparent", border: "none", color: c.textDim, fontSize: 14, cursor: "pointer", padding: 0 }}>✎</button>
                </div>
                {editingBook === entry.id ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input type="number" defaultValue={entry.balance} style={{ ...fieldInput, width: "100%", fontSize: 14 }} onKeyDown={e => { if (e.key === "Enter") { setBankrollEntries(prev => prev.map(b => b.id === entry.id ? { ...b, balance: parseFloat(e.target.value) || 0, lastUpdated: new Date().toISOString().slice(0, 10) } : b)); setEditingBook(null); }}} />
                    <button onClick={() => { setBankrollEntries(prev => prev.filter(b => b.id !== entry.id)); setEditingBook(null); }} style={{ ...btnSecondary, padding: "4px 8px", fontSize: 10, color: c.red, borderColor: c.red + "44" }}>✕</button>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 22, fontWeight: 700, color: c.green, fontFamily: "'JetBrains Mono', monospace" }}>${entry.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                    <div style={{ height: 4, background: "rgba(255,255,255,0.04)", borderRadius: 2, marginTop: 10, overflow: "hidden" }}>
                      <div style={{ width: `${(entry.balance / maxBal) * 100}%`, height: "100%", background: `linear-gradient(90deg, ${c.green}, ${c.blue})`, borderRadius: 2, transition: "width 0.5s" }} />
                    </div>
                    <div style={{ fontSize: 10, color: c.textDim, marginTop: 6 }}>Updated {entry.lastUpdated}</div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Add book modal inline */}
        {showAddBook && (
          <div style={{ background: c.card, border: `1px solid ${c.borderLight}`, borderRadius: 16, padding: 22, animation: "fadeIn .2s ease" }}>
            <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: c.text }}>Add Sportsbook</h3>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
              <div><label style={fieldLabel}>Sportsbook</label><input value={bookForm.book} onChange={e => setBookForm(f => ({ ...f, book: e.target.value }))} placeholder="e.g. Pinnacle" style={{ ...fieldInput, width: 180 }} /></div>
              <div><label style={fieldLabel}>Balance</label><input type="number" value={bookForm.balance} onChange={e => setBookForm(f => ({ ...f, balance: e.target.value }))} placeholder="0.00" style={{ ...fieldInput, width: 120 }} /></div>
              <button onClick={() => { if (!bookForm.book) return; setBankrollEntries(prev => [...prev, { id: Date.now(), book: bookForm.book, balance: parseFloat(bookForm.balance) || 0, lastUpdated: new Date().toISOString().slice(0, 10), profile: activeProfile === "all" ? profiles[0]?.id || "cameron" : activeProfile }]); setBookForm({ book: "", balance: "" }); setShowAddBook(false); }} style={{ ...btnPrimary, padding: "10px 20px" }}>Add</button>
              <button onClick={() => setShowAddBook(false)} style={{ ...btnSecondary, padding: "10px 16px" }}>Cancel</button>
            </div>
          </div>
        )}

        {/* ═══ Sportsbook Limits ═══ */}
        {profKey && (
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Sportsbook Limits</h3>
                {(() => {
                  const lims = bookLimits[profKey] || [];
                  const bannedCount = lims.filter(l => l.status === "banned").length;
                  const severeCount = lims.filter(l => l.status === "severe").length;
                  const limitedCount = lims.filter(l => l.status === "limited").length;
                  const cleanCount = lims.filter(l => l.status === "clean").length;
                  return <span style={{ fontSize: 11, color: c.textDim }}>{cleanCount > 0 && <span style={{ color: c.green }}>{cleanCount} clean</span>}{cleanCount > 0 && limitedCount > 0 && " · "}{limitedCount > 0 && <span style={{ color: c.amber }}>{limitedCount} limited</span>}{(cleanCount > 0 || limitedCount > 0) && severeCount > 0 && " · "}{severeCount > 0 && <span style={{ color: c.red }}>{severeCount} severe</span>}{(cleanCount > 0 || limitedCount > 0 || severeCount > 0) && bannedCount > 0 && " · "}{bannedCount > 0 && <span style={{ color: "#ff2244" }}>{bannedCount} banned</span>}</span>;
                })()}
              </div>
              <button onClick={() => setShowAddLimit(true)} style={{ ...btnSecondary, padding: "6px 14px", fontSize: 11 }}>+ Add Limit</button>
            </div>
            {showAddLimit && (
              <div style={{ background: c.bg, border: `1px solid ${c.borderLight}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div><label style={fieldLabel}>Sportsbook</label><input value={limitForm.book} onChange={e => setLimitForm(f => ({ ...f, book: e.target.value }))} placeholder="e.g. DraftKings" style={{ ...fieldInput, width: 150 }} /></div>
                  <div><label style={fieldLabel}>Sport</label><select value={limitForm.sport} onChange={e => setLimitForm(f => ({ ...f, sport: e.target.value }))} style={{ ...selectStyle, width: 120, padding: "9px 12px" }}><option value="All">All (blanket)</option>{SPORTS.map(s => <option key={`s_${s}`} value={s}>{s}</option>)}{ALL_LEAGUES.map(l => <option key={`l_${l}`} value={l}>{l}</option>)}</select></div>
                  <div><label style={fieldLabel}>Limit Details</label><input value={limitForm.limit} onChange={e => setLimitForm(f => ({ ...f, limit: e.target.value }))} placeholder="e.g. Win $250, 10%, unlimited" style={{ ...fieldInput, width: 230 }} /></div>
                  <div><label style={fieldLabel}>Status</label><select value={limitForm.status} onChange={e => setLimitForm(f => ({ ...f, status: e.target.value }))} style={{ ...selectStyle, width: 120, padding: "9px 12px" }}><option value="clean">Clean</option><option value="limited">Limited</option><option value="severe">Severe</option><option value="banned">Banned</option></select></div>
                  <div><label style={fieldLabel}>Date</label><input type="date" value={limitForm.date} onChange={e => setLimitForm(f => ({ ...f, date: e.target.value }))} style={{ ...fieldInput, width: 140 }} /></div>
                  <button onClick={() => { if (!limitForm.book) return; const lims = bookLimits[profKey] || []; setBookLimits(prev => ({ ...prev, [profKey]: [...lims, { id: Date.now(), ...limitForm }] })); setLimitForm({ book: "", sport: "All", limit: "", status: "limited", date: new Date().toISOString().slice(0, 10) }); setShowAddLimit(false); }} style={{ ...btnPrimary, padding: "10px 20px" }}>Save</button>
                  <button onClick={() => setShowAddLimit(false)} style={{ ...btnSecondary, padding: "10px 16px" }}>Cancel</button>
                </div>
              </div>
            )}
            {(bookLimits[profKey] || []).length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[...(bookLimits[profKey] || [])].sort((a, b) => {
                  // Group by book first, then clean→limited→severe→banned within each book
                  const bookCmp = a.book.localeCompare(b.book);
                  if (bookCmp !== 0) return bookCmp;
                  const order = { clean: 0, limited: 1, severe: 2, banned: 3 };
                  return (order[a.status] ?? 4) - (order[b.status] ?? 4);
                }).map(lim => {
                  const statusColors = { clean: { bg: c.greenDim, color: c.green, label: "Clean" }, limited: { bg: "rgba(245,158,11,0.12)", color: c.amber, label: "Limited" }, severe: { bg: c.redDim, color: c.red, label: "Severe" }, banned: { bg: "rgba(255,77,106,0.2)", color: "#ff2244", label: "Banned" } };
                  const sc = statusColors[lim.status] || statusColors.limited;
                  const isEditing = editingLimit === lim.id;
                  const sportLabel = (lim.sport || "All") === "All" ? "All Sports" : lim.sport;
                  const sportColor = (lim.sport || "All") === "All" ? c.purple : c.blue;
                  return (
                    <div key={lim.id} style={{ display: "flex", alignItems: "center", gap: 10, background: c.bg, border: `1px solid ${lim.status === "banned" ? c.red + "33" : lim.status === "severe" ? c.red + "22" : c.border}`, borderRadius: 10, padding: "12px 16px" }}>
                      <span style={{ padding: "3px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: sc.bg, color: sc.color, minWidth: 55, textAlign: "center", textTransform: "uppercase", letterSpacing: 0.5 }}>{sc.label}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: c.text, minWidth: 100 }}>{lim.book}</span>
                      <span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: sportColor + "15", color: sportColor, minWidth: 50, textAlign: "center" }}>{sportLabel}</span>
                      {isEditing ? (
                        <div style={{ flex: 1, display: "flex", gap: 8, alignItems: "center" }}>
                          <input defaultValue={lim.limit} style={{ ...fieldInput, flex: 1, fontSize: 12 }} onKeyDown={e => { if (e.key === "Enter") { setBookLimits(prev => ({ ...prev, [profKey]: (prev[profKey] || []).map(l => l.id === lim.id ? { ...l, limit: e.target.value } : l) })); setEditingLimit(null); }}} />
                          <select defaultValue={lim.sport || "All"} onChange={e => { setBookLimits(prev => ({ ...prev, [profKey]: (prev[profKey] || []).map(l => l.id === lim.id ? { ...l, sport: e.target.value } : l) })); }} style={{ ...selectStyle, width: 90, padding: "6px 8px", fontSize: 11 }}><option value="All">All</option>{SPORTS.map(s => <option key={`s_${s}`} value={s}>{s}</option>)}{ALL_LEAGUES.map(l => <option key={`l_${l}`} value={l}>{l}</option>)}</select>
                          <select defaultValue={lim.status} onChange={e => { setBookLimits(prev => ({ ...prev, [profKey]: (prev[profKey] || []).map(l => l.id === lim.id ? { ...l, status: e.target.value } : l) })); }} style={{ ...selectStyle, width: 90, padding: "6px 8px", fontSize: 11 }}><option value="clean">Clean</option><option value="limited">Limited</option><option value="severe">Severe</option><option value="banned">Banned</option></select>
                          <button onClick={() => setEditingLimit(null)} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 10 }}>Done</button>
                        </div>
                      ) : (
                        <span style={{ flex: 1, fontSize: 12, color: c.textDim, fontFamily: "'JetBrains Mono', monospace" }}>{lim.limit}</span>
                      )}
                      <span style={{ fontSize: 10, color: c.textDim, minWidth: 70 }}>{lim.date}</span>
                      <button onClick={() => setEditingLimit(isEditing ? null : lim.id)} style={{ background: "transparent", border: "none", color: c.textDim, fontSize: 12, cursor: "pointer", padding: "2px 4px" }}>✎</button>
                      <button onClick={() => setBookLimits(prev => ({ ...prev, [profKey]: (prev[profKey] || []).filter(l => l.id !== lim.id) }))} style={{ background: "transparent", border: "none", color: c.textDim, cursor: "pointer", fontSize: 12, padding: "2px 4px" }}>✕</button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: 20, textAlign: "center", color: c.textDim, fontSize: 13 }}>No limits recorded for {profName}. Click "+ Add Limit" to track sportsbook restrictions.</div>
            )}
          </div>
        )}

        {/* Transaction history */}
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
            <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Deposits & Withdrawals</h3>
            <button onClick={() => setShowAddTxn(true)} style={{ ...btnSecondary, padding: "6px 14px", fontSize: 11 }}>+ Add Transaction</button>
          </div>
          {showAddTxn && (
            <div style={{ background: c.bg, border: `1px solid ${c.borderLight}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div><label style={fieldLabel}>Date</label><input type="date" value={txnForm.date} onChange={e => setTxnForm(f => ({ ...f, date: e.target.value }))} style={{ ...fieldInput, width: 140 }} /></div>
                <div><label style={fieldLabel}>Type</label><select value={txnForm.type} onChange={e => setTxnForm(f => ({ ...f, type: e.target.value, purpose: e.target.value === "deposit" ? "general" : f.purpose }))} style={{ ...selectStyle, width: 130, padding: "9px 12px" }}><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option></select></div>
                {txnForm.type === "withdrawal" && (
                  <div><label style={fieldLabel}>Purpose</label><select value={txnForm.purpose} onChange={e => setTxnForm(f => ({ ...f, purpose: e.target.value, note: e.target.value === "expenses" && !f.note ? "Monthly expenses" : f.note }))} style={{ ...selectStyle, width: 150, padding: "9px 12px", borderColor: txnForm.purpose === "expenses" ? c.amber + "66" : c.border }}><option value="general">General</option><option value="expenses">Pay Expenses</option></select></div>
                )}
                <div><label style={fieldLabel}>Sportsbook</label><select value={txnForm.book} onChange={e => setTxnForm(f => ({ ...f, book: e.target.value }))} style={{ ...selectStyle, width: 160, padding: "9px 12px" }}><option value="">Select...</option>{pBooks.map(b => <option key={b.id} value={b.book}>{b.book}</option>)}</select></div>
                <div><label style={fieldLabel}>Amount</label><input type="number" value={txnForm.amount} onChange={e => setTxnForm(f => ({ ...f, amount: e.target.value }))} placeholder="0.00" style={{ ...fieldInput, width: 120 }} /></div>
                <div><label style={fieldLabel}>Note</label><input value={txnForm.note} onChange={e => setTxnForm(f => ({ ...f, note: e.target.value }))} placeholder="Optional..." style={{ ...fieldInput, width: 160 }} /></div>
                <button onClick={() => { if (!txnForm.book || !txnForm.amount) return; setBankrollHistory(prev => [{ id: Date.now(), ...txnForm, amount: parseFloat(txnForm.amount) || 0, purpose: txnForm.type === "withdrawal" ? txnForm.purpose : "general", profile: activeProfile === "all" ? profiles[0]?.id || "cameron" : activeProfile }, ...prev]); setTxnForm({ date: new Date().toISOString().slice(0, 10), type: "deposit", book: "", amount: "", note: "", purpose: "general" }); setShowAddTxn(false); }} style={{ ...btnPrimary, padding: "10px 20px" }}>Save</button>
                <button onClick={() => setShowAddTxn(false)} style={{ ...btnSecondary, padding: "10px 16px" }}>Cancel</button>
              </div>
              {txnForm.type === "withdrawal" && txnForm.purpose === "expenses" && (
                <div style={{ marginTop: 10, padding: "8px 12px", background: c.amberDim, borderRadius: 8, border: `1px solid ${c.amber}22`, fontSize: 11, color: c.amber, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>💡</span> This withdrawal will count toward your monthly expense obligation ({formatMoney(expenseStats.monthlyBurn)}/mo)
                </div>
              )}
            </div>
          )}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{["Date", "Type", "Sportsbook", "Amount", "Note", ""].map(h => <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: c.textDim, fontWeight: 500, borderBottom: `1px solid ${c.border}`, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{h}</th>)}</tr></thead>
            <tbody>{[...pHistory].sort((a, b) => b.date.localeCompare(a.date)).map(txn => (
              <tr key={txn.id} style={{ borderBottom: `1px solid ${c.border}08` }}>
                <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: c.textDim }}>{txn.date}</td>
                <td style={{ padding: "10px" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ padding: "2px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: txn.type === "deposit" ? c.greenDim : c.purpleDim, color: txn.type === "deposit" ? c.green : c.purple }}>{txn.type === "deposit" ? "↓ Deposit" : "↑ Withdrawal"}</span>
                    {txn.purpose === "expenses" && <span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: c.amberDim, color: c.amber }}>Expenses</span>}
                  </div>
                </td>
                <td style={{ padding: "10px", color: c.text }}>{txn.book}</td>
                <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: txn.type === "deposit" ? c.green : c.purple }}>{txn.type === "deposit" ? "+" : "−"}${txn.amount.toLocaleString()}</td>
                <td style={{ padding: "10px", fontSize: 11, color: c.textDim }}>{txn.note || "—"}</td>
                <td style={{ padding: "10px" }}><button onClick={() => setBankrollHistory(prev => prev.filter(t => t.id !== txn.id))} style={{ background: "transparent", border: "none", color: c.textDim, cursor: "pointer", fontSize: 12 }}>✕</button></td>
              </tr>
            ))}</tbody>
          </table>
          {pHistory.length === 0 && <div style={{ padding: 20, textAlign: "center", color: c.textDim, fontSize: 13 }}>No transactions yet. Click "+ Add Transaction" to record deposits and withdrawals.</div>}
        </div>

        {/* ═══ Profile Notes — passwords, usernames, phones, etc. ═══ */}
        {profKey && (
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Profile Notes</h3>
                <span style={{ fontSize: 11, color: c.textDim }}>({profName} — logins, passwords, phone numbers, etc.)</span>
              </div>
              <button onClick={() => setShowAddNote(true)} style={{ ...btnSecondary, padding: "6px 14px", fontSize: 11 }}>+ Add Note</button>
            </div>
            {showAddNote && (
              <div style={{ background: c.bg, border: `1px solid ${c.borderLight}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div><label style={fieldLabel}>Label</label><input value={noteForm.label} onChange={e => setNoteForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. DraftKings Password" style={{ ...fieldInput, width: 200 }} /></div>
                  <div><label style={fieldLabel}>Value</label><input value={noteForm.value} onChange={e => setNoteForm(f => ({ ...f, value: e.target.value }))} placeholder="e.g. myP@ssw0rd" style={{ ...fieldInput, width: 240 }} /></div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 4 }}>
                    <input type="checkbox" checked={noteForm.sensitive} onChange={e => setNoteForm(f => ({ ...f, sensitive: e.target.checked }))} id="sensCheck" style={{ accentColor: c.amber }} />
                    <label htmlFor="sensCheck" style={{ fontSize: 11, color: c.textDim, cursor: "pointer" }}>Sensitive (hidden by default)</label>
                  </div>
                  <button onClick={() => { if (!noteForm.label) return; const notes = profileNotes[profKey] || []; setProfileNotes(prev => ({ ...prev, [profKey]: [...notes, { id: Date.now(), ...noteForm }] })); setNoteForm({ label: "", value: "", sensitive: false }); setShowAddNote(false); }} style={{ ...btnPrimary, padding: "10px 20px" }}>Save</button>
                  <button onClick={() => setShowAddNote(false)} style={{ ...btnSecondary, padding: "10px 16px" }}>Cancel</button>
                </div>
              </div>
            )}
            {(profileNotes[profKey] || []).length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(profileNotes[profKey] || []).map(note => (
                  <div key={note.id} style={{ display: "flex", alignItems: "center", gap: 12, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, padding: "12px 16px" }}>
                    <div style={{ flex: "0 0 180px" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: c.text }}>{note.label}</span>
                    </div>
                    <div style={{ flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
                      {note.sensitive && !revealedNotes.has(note.id) ? (
                        <span style={{ color: c.textDim, letterSpacing: 2 }}>••••••••••</span>
                      ) : (
                        <span style={{ color: c.text }}>{note.value}</span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {note.sensitive && (
                        <button onClick={() => setRevealedNotes(prev => { const next = new Set(prev); if (next.has(note.id)) next.delete(note.id); else next.add(note.id); return next; })} style={{ background: "transparent", border: `1px solid ${c.border}`, borderRadius: 6, padding: "3px 10px", fontSize: 10, color: c.textDim, cursor: "pointer" }}>
                          {revealedNotes.has(note.id) ? "Hide" : "Show"}
                        </button>
                      )}
                      <button onClick={() => { navigator.clipboard?.writeText(note.value); }} style={{ background: "transparent", border: `1px solid ${c.border}`, borderRadius: 6, padding: "3px 10px", fontSize: 10, color: c.blue, cursor: "pointer" }}>Copy</button>
                      <button onClick={() => setProfileNotes(prev => ({ ...prev, [profKey]: (prev[profKey] || []).filter(n => n.id !== note.id) }))} style={{ background: "transparent", border: "none", color: c.textDim, cursor: "pointer", fontSize: 12, padding: "3px 6px" }}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: 20, textAlign: "center", color: c.textDim, fontSize: 13 }}>No notes yet for {profName}. Add logins, passwords, phone numbers, or any important info.</div>
            )}
          </div>
        )}
      </div>
    );
  };

  /* ═══ TAX ═══ */
  const taxAvailableYears = useMemo(() => {
    const years = [...new Set(bets.map(b => b.date.slice(0, 4)))].sort().reverse();
    return years;
  }, [bets]);

  const renderTax = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ background: `linear-gradient(135deg, ${c.amberDim}, ${c.card})`, border: `1px solid rgba(245,158,11,0.2)`, borderRadius: 16, padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}><span style={{ fontSize: 20 }}>⚠</span><span style={{ fontSize: 14, fontWeight: 600, color: c.amber }}>Tax Estimate Disclaimer</span></div>
        <p style={{ fontSize: 13, color: c.textDim, lineHeight: 1.6, margin: 0 }}>Estimate based on 2025 US federal tax brackets (single filer). Consult a qualified tax professional. Gambling winnings are taxable income; losses may be deductible up to winnings if you itemize.</p>
      </div>
      {/* Year switcher */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[...taxAvailableYears, "all"].map(y => (
          <button key={y} onClick={() => setTaxYear(y)} style={{ ...btnSecondary, padding: "8px 16px", fontSize: 12, background: taxYear === y ? "rgba(245,158,11,0.12)" : "transparent", borderColor: taxYear === y ? "rgba(245,158,11,0.4)" : c.border, color: taxYear === y ? c.amber : c.textDim, fontWeight: taxYear === y ? 700 : 400 }}>{y === "all" ? "All Time" : y}</button>
        ))}
        <span style={{ fontSize: 12, color: c.textDim, alignSelf: "center", marginLeft: 8 }}>{taxStats.betCount} bets · Tax Year: {taxYear === "all" ? "All Time" : taxYear}</span>
      </div>
      <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
        <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 16px", fontFamily: "'JetBrains Mono', monospace" }}>Your Profile</h3>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          <div><label style={fieldLabel}>Other Annual Income</label><input type="number" value={taxOtherIncome} onChange={e => setTaxOtherIncome(Number(e.target.value))} style={{ ...fieldInput, width: 180 }} /></div>
          <div><label style={fieldLabel}>Filing Status</label><select value={taxFilingStatus} onChange={e => setTaxFilingStatus(e.target.value)} style={{ ...selectStyle, width: 180, padding: "9px 12px" }}><option value="single">Single</option><option value="married">Married Filing Jointly</option></select></div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
        <StatCard label="Gross Winnings" value={formatMoney(taxStats.grossWinnings)} color={c.green} sub="Total payouts from wins" />
        <StatCard label="Total Losses" value={formatMoney(taxStats.totalLosses)} color={c.red} sub="Deductible if itemizing" />
        <StatCard label="Net Gambling Income" value={formatMoney(taxStats.netGambling)} color={taxStats.netGambling >= 0 ? c.green : c.red} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 16px", fontFamily: "'JetBrains Mono', monospace" }}>Federal Tax Impact</h3>
          {[["Taxable Gambling Income", formatMoney(taxStats.taxableGambling), c.text], ["Combined Taxable Income", formatMoney(taxStats.totalIncome), c.text], ["Total Federal Tax", formatMoney(taxStats.taxWithGambling), c.amber], ["Tax on Gambling Only", formatMoney(taxStats.gamblingTax), c.red], ["Effective Rate", `${taxStats.effectiveRate.toFixed(1)}%`, c.amber], ["After-Tax Profit", formatMoney(taxStats.netGambling - taxStats.gamblingTax), (taxStats.netGambling - taxStats.gamblingTax) >= 0 ? c.green : c.red]].map(([l, v, cl]) => (
            <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${c.border}08` }}><span style={{ fontSize: 13, color: c.textDim }}>{l}</span><span style={{ fontSize: 14, fontWeight: 600, color: cl, fontFamily: "'JetBrains Mono', monospace" }}>{v}</span></div>
          ))}
        </div>
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 16px", fontFamily: "'JetBrains Mono', monospace" }}>Quarterly Estimated Payments</h3>
          <p style={{ fontSize: 12, color: c.textDim, lineHeight: 1.5, margin: "0 0 16px" }}>If you expect to owe $1,000+, the IRS requires quarterly estimated payments.</p>
          {["Q1 (Apr 15)", "Q2 (Jun 15)", "Q3 (Sep 15)", "Q4 (Jan 15)"].map(q => (
            <div key={q} style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${c.border}08` }}><span style={{ fontSize: 13, color: c.text }}>{q}</span><span style={{ fontSize: 16, fontWeight: 700, color: c.amber, fontFamily: "'JetBrains Mono', monospace" }}>{formatMoney(taxStats.quarterlyEstimate)}</span></div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "14px 0 0", fontWeight: 700 }}><span style={{ fontSize: 14, color: c.text }}>Annual Total</span><span style={{ fontSize: 18, color: c.amber, fontFamily: "'JetBrains Mono', monospace" }}>{formatMoney(taxStats.gamblingTax)}</span></div>
        </div>
      </div>
      <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
        <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 16px", fontFamily: "'JetBrains Mono', monospace" }}>Tax Bracket Breakdown</h3>
        {TAX_BRACKETS_2025.filter(b => b.min < taxStats.totalIncome).map((bracket, i) => {
          const inB = Math.min(taxStats.totalIncome, bracket.max) - bracket.min;
          const pct = (inB / taxStats.totalIncome) * 100;
          const colors = [c.green, c.cyan, c.blue, c.purple, c.amber, "#f97316", c.red];
          return (<div key={i} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}><span style={{ fontSize: 12, color: c.textDim, minWidth: 40, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{(bracket.rate * 100).toFixed(0)}%</span><div style={{ flex: 1, height: 20, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: colors[i], borderRadius: 4, transition: "width 0.8s ease" }} /></div><span style={{ fontSize: 11, color: c.textDim, minWidth: 70, fontFamily: "'JetBrains Mono', monospace" }}>{formatMoney(inB)}</span></div>);
        })}
      </div>
    </div>
  );

  /* ═══ ACCOUNTING ═══ */
  const renderAccounting = () => {
    const totalReceiptCount = expenses.reduce((s, e) => s + (expenseReceipts[e.id] || []).length, 0);
    const totalW2gFiles = w2gDocuments.reduce((s, d) => s + (d.files || []).length, 0);
    const w2gTotals = w2gDocuments.reduce((acc, d) => ({ amount: acc.amount + d.amount, withheld: acc.withheld + d.taxWithheld }), { amount: 0, withheld: 0 });

    return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ─── Export Banner ─── */}
      <div style={{ background: `linear-gradient(135deg, ${c.blueDim}, rgba(77,148,255,0.04))`, border: `1px solid ${c.blue}33`, borderRadius: 14, padding: "16px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: c.blueDim, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>📊</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: c.text }}>Export for Accountant</div>
            <div style={{ fontSize: 12, color: c.textDim, marginTop: 2 }}>
              P&L summary, bet log, expenses with receipts, W-2G forms — ready for tax prep
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <select value={accountingExportYear} onChange={e => setAccountingExportYear(e.target.value)} style={{ ...selectStyle, padding: "8px 12px" }}>
            {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
            <option value="all">All Time</option>
          </select>
          <button onClick={handleExportAll} style={{ ...btnPrimary, padding: "10px 20px", display: "flex", alignItems: "center", gap: 6 }}>
            <span>↓</span> Export CSVs
          </button>
          {(totalW2gFiles > 0 || totalReceiptCount > 0) && (
            <button onClick={downloadAllAttachments} style={{ ...btnSecondary, padding: "10px 16px", fontSize: 12 }}>
              ↓ All Files ({totalW2gFiles + totalReceiptCount})
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <StatCard label="Monthly Burn" value={formatMoney(expenseStats.monthlyBurn)} color={c.amber} sub={`${expenseStats.activeCount} active expenses`} />
        <StatCard label="Annualized Cost" value={formatMoney(expenseStats.annualized)} color={c.red} sub="Projected yearly total" />
        <StatCard label="One-Time Spend" value={formatMoney(expenseStats.oneTimeTotal)} color={c.purple} sub="Capital expenditures" />
        <StatCard label="Net After Expenses" value={formatMoney(expenseStats.netAfterExpenses)} color={expenseStats.netAfterExpenses >= 0 ? c.green : c.red} sub="Profit minus costs" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 16px", fontFamily: "'JetBrains Mono', monospace" }}>Cost by Category (Annualized)</h3>
          {Object.entries(expenseStats.byCategory).sort((a, b) => b[1].total - a[1].total).map(([key, cat]) => {
            const mx = Math.max(...Object.values(expenseStats.byCategory).map(c => c.total));
            return (<div key={key} style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 13, color: c.text }}><span style={{ marginRight: 8, opacity: 0.6 }}>{cat.icon}</span>{cat.label}</span><div style={{ display: "flex", gap: 12, alignItems: "center" }}><span style={{ fontSize: 11, color: c.textDim }}>{cat.count} item{cat.count > 1 ? "s" : ""}</span><span style={{ fontSize: 14, fontWeight: 600, color: c.amber, fontFamily: "'JetBrains Mono', monospace", minWidth: 80, textAlign: "right" }}>{formatMoney(cat.total)}</span></div></div><MiniBar value={cat.total} max={mx} color={c.amber} /></div>);
          })}
        </div>
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 16px", fontFamily: "'JetBrains Mono', monospace" }}>Business P&L Summary</h3>
          {[["Gross Betting Profit", formatMoney(stats.totalProfit), stats.totalProfit >= 0 ? c.green : c.red],
            ["Recurring Costs (Annual)", `-${formatMoney(expenseStats.annualized - expenseStats.oneTimeTotal)}`, c.red],
            ["One-Time Expenses", `-${formatMoney(expenseStats.oneTimeTotal)}`, c.purple],
            ["Total Expenses", `-${formatMoney(expenseStats.annualized)}`, c.amber],
            ["_divider"],
            ["Net Operating Profit", formatMoney(expenseStats.netAfterExpenses), expenseStats.netAfterExpenses >= 0 ? c.green : c.red],
            ["W-2G Tax Withheld", w2gTotals.withheld > 0 ? `-${formatMoney(w2gTotals.withheld)}` : "$0.00", c.cyan],
            ["Est. Additional Tax", `-${formatMoney(Math.max(0, taxStats.gamblingTax - w2gTotals.withheld))}`, c.amber],
            ["_divider2"],
            ["Profit After Tax + Expenses", formatMoney(expenseStats.netAfterExpenses - taxStats.gamblingTax), (expenseStats.netAfterExpenses - taxStats.gamblingTax) >= 0 ? c.green : c.red],
          ].map((row, i) => {
            if (row[0].startsWith("_")) return <div key={i} style={{ borderTop: `1px solid ${c.borderLight}`, margin: "4px 0" }} />;
            const bold = row[0].includes("Net") || row[0].includes("Profit After");
            return (<div key={i} style={{ display: "flex", justifyContent: "space-between", padding: `${bold ? 10 : 6}px 0`, borderBottom: bold ? "none" : `1px solid ${c.border}08` }}><span style={{ fontSize: bold ? 14 : 13, color: bold ? c.text : c.textDim, fontWeight: bold ? 700 : 400 }}>{row[0]}</span><span style={{ fontSize: bold ? 18 : 14, fontWeight: bold ? 700 : 600, color: row[2], fontFamily: "'JetBrains Mono', monospace" }}>{row[1]}</span></div>);
          })}
        </div>
      </div>

      {/* ═══ W-2G SECTION ═══ */}
      <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div>
            <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 4px", fontFamily: "'JetBrains Mono', monospace" }}>W-2G Forms</h3>
            <p style={{ fontSize: 11, color: c.textMuted, margin: 0 }}>Track W-2G forms received from sportsbooks for winnings over $600</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {w2gDocuments.length > 0 && (
              <div style={{ padding: "6px 14px", borderRadius: 8, background: c.cyanDim, fontSize: 12, fontWeight: 600, color: c.cyan, display: "flex", alignItems: "center", gap: 6 }}>
                <span>{w2gDocuments.length} form{w2gDocuments.length !== 1 ? "s" : ""}</span>
                <span style={{ opacity: 0.5 }}>·</span>
                <span>${w2gTotals.amount.toLocaleString()} reported</span>
                {w2gTotals.withheld > 0 && <><span style={{ opacity: 0.5 }}>·</span><span>${w2gTotals.withheld.toLocaleString()} withheld</span></>}
              </div>
            )}
            <button onClick={() => setShowAddW2g(true)} style={{ ...btnSecondary, padding: "6px 14px", fontSize: 11 }}>+ Add W-2G</button>
          </div>
        </div>

        {showAddW2g && (
          <div style={{ background: c.bg, border: `1px solid ${c.borderLight}`, borderRadius: 12, padding: 18, marginBottom: 16, animation: "fadeIn .2s ease" }}>
            <h4 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: c.text }}>New W-2G Form</h4>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
              <div><label style={fieldLabel}>Sportsbook</label><input value={w2gForm.sportsbook} onChange={e => setW2gForm(f => ({ ...f, sportsbook: e.target.value }))} placeholder="e.g. DraftKings" style={fieldInput} /></div>
              <div><label style={fieldLabel}>Winnings Amount</label><input type="number" value={w2gForm.amount} onChange={e => setW2gForm(f => ({ ...f, amount: e.target.value }))} placeholder="0.00" style={fieldInput} /></div>
              <div><label style={fieldLabel}>Tax Withheld</label><input type="number" value={w2gForm.taxWithheld} onChange={e => setW2gForm(f => ({ ...f, taxWithheld: e.target.value }))} placeholder="0.00" style={fieldInput} /></div>
              <div><label style={fieldLabel}>Date Received</label><input type="date" value={w2gForm.date} onChange={e => setW2gForm(f => ({ ...f, date: e.target.value }))} style={fieldInput} /></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14, marginBottom: 14 }}>
              <div><label style={fieldLabel}>Notes</label><input value={w2gForm.notes} onChange={e => setW2gForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional — bet description, event, etc." style={fieldInput} /></div>
              <div>
                <label style={fieldLabel}>Attach W-2G Document</label>
                <input type="file" ref={w2gInputRef} accept="image/*,.pdf,.doc,.docx" multiple onChange={handleW2gFileUpload} style={{ display: "none" }} />
                <button onClick={() => w2gInputRef.current?.click()} style={{ ...btnSecondary, width: "100%", padding: "9px 12px", fontSize: 12 }}>
                  {w2gFiles.length > 0 ? `${w2gFiles.length} file${w2gFiles.length > 1 ? "s" : ""} attached` : "Choose File(s)"}
                </button>
              </div>
            </div>
            {w2gFiles.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                {w2gFiles.map(f => (
                  <div key={f.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", background: c.cyanDim, borderRadius: 6, marginRight: 6, marginBottom: 4, fontSize: 11, color: c.cyan }}>
                    <span>{f.type?.includes("pdf") ? "📄" : "🖼"}</span>
                    <span style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                    <button onClick={() => setW2gFiles(prev => prev.filter(x => x.id !== f.id))} style={{ background: "none", border: "none", color: c.red, cursor: "pointer", fontSize: 11, padding: 0 }}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={saveW2g} style={btnPrimary}>Save W-2G</button>
              <button onClick={() => { setShowAddW2g(false); setW2gForm({ sportsbook: "", amount: "", date: new Date().toISOString().slice(0, 10), taxWithheld: "", notes: "" }); setW2gFiles([]); }} style={btnSecondary}>Cancel</button>
            </div>
          </div>
        )}

        {w2gDocuments.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{["Date", "Sportsbook", "Winnings", "Tax Withheld", "Notes", "Files", ""].map(h => <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: c.textDim, fontWeight: 500, borderBottom: `1px solid ${c.border}`, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{h}</th>)}</tr></thead>
            <tbody>{w2gDocuments.sort((a, b) => b.date.localeCompare(a.date)).map(doc => (
              <tr key={doc.id} style={{ borderBottom: `1px solid ${c.border}08` }}>
                <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: c.textDim }}>{doc.date}</td>
                <td style={{ padding: "10px", color: c.text, fontWeight: 500 }}>{doc.sportsbook}</td>
                <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: c.cyan }}>${doc.amount.toLocaleString()}</td>
                <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: doc.taxWithheld > 0 ? c.amber : c.textDim }}>{doc.taxWithheld > 0 ? `$${doc.taxWithheld.toLocaleString()}` : "—"}</td>
                <td style={{ padding: "10px", fontSize: 11, color: c.textDim, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.notes || "—"}</td>
                <td style={{ padding: "10px" }}>
                  {(doc.files || []).length > 0 ? (
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {doc.files.map(f => (
                        <button key={f.id} onClick={() => downloadAttachment(f)} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: c.cyanDim, borderRadius: 5, border: "none", cursor: "pointer", fontSize: 10, color: c.cyan }}>
                          {f.type?.includes("pdf") ? "📄" : "🖼"} {f.name.length > 15 ? f.name.slice(0, 12) + "..." : f.name}
                        </button>
                      ))}
                    </div>
                  ) : <span style={{ fontSize: 11, color: c.textMuted }}>none</span>}
                </td>
                <td style={{ padding: "10px" }}><button onClick={() => setW2gDocuments(prev => prev.filter(d => d.id !== doc.id))} style={{ background: "transparent", border: "none", color: c.textDim, cursor: "pointer", fontSize: 12 }}>✕</button></td>
              </tr>
            ))}</tbody>
          </table>
        ) : (
          <div style={{ padding: 24, textAlign: "center", color: c.textDim, fontSize: 13, background: c.bg, borderRadius: 10 }}>
            <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>📋</div>
            No W-2G forms uploaded yet. Sportsbooks issue these for qualifying winnings — add them here to include in your accountant export.
          </div>
        )}
      </div>

      {/* ═══ Document Summary ═══ */}
      {(totalReceiptCount > 0 || totalW2gFiles > 0) && (
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 14px", fontFamily: "'JetBrains Mono', monospace" }}>Attached Documents</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
            <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>W-2G Files</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: c.cyan, fontFamily: "'JetBrains Mono', monospace" }}>{totalW2gFiles}</div>
            </div>
            <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Expense Receipts</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: c.green, fontFamily: "'JetBrains Mono', monospace" }}>{totalReceiptCount}</div>
            </div>
            <div style={{ background: c.bg, borderRadius: 10, padding: 14, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: c.textDim, marginBottom: 4 }}>Total Files</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: c.blue, fontFamily: "'JetBrains Mono', monospace" }}>{totalW2gFiles + totalReceiptCount}</div>
            </div>
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button onClick={downloadAllAttachments} style={{ ...btnSecondary, padding: "8px 16px", fontSize: 12 }}>↓ Download All Files</button>
            <span style={{ fontSize: 11, color: c.textMuted, alignSelf: "center" }}>Downloads each file individually — organize into a folder for your CPA</span>
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {[["all", "All"], ["recurring", "Recurring"], ["one-time", "One-Time"], ["active", "Active"], ["inactive", "Inactive"]].map(([v, l]) => (
            <button key={v} onClick={() => setExpenseFilter(v)} style={{ ...btnSecondary, padding: "6px 14px", fontSize: 12, background: expenseFilter === v ? "rgba(255,255,255,0.08)" : "transparent", borderColor: expenseFilter === v ? c.borderLight : c.border, color: expenseFilter === v ? c.text : c.textDim }}>{l}</button>
          ))}
        </div>
        <button onClick={() => { resetExpenseForm(); setShowAddExpense(true); }} style={btnPrimary}>+ Add Expense</button>
      </div>
      {showAddExpense && (
        <div style={{ background: c.card, border: `1px solid ${c.borderLight}`, borderRadius: 16, padding: 24, animation: "fadeIn .2s ease" }}>
          <h3 style={{ margin: "0 0 18px", fontSize: 15, fontWeight: 700, color: c.text }}>{editingExpense ? "Edit Expense" : "Add New Expense"}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div><label style={fieldLabel}>Name</label><input value={expenseForm.name} onChange={e => setExpenseForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. OddsJam Pro" style={fieldInput} /></div>
            <div><label style={fieldLabel}>Category</label><select value={expenseForm.category} onChange={e => setExpenseForm(f => ({ ...f, category: e.target.value }))} style={{ ...selectStyle, width: "100%", padding: "9px 12px" }}>{EXPENSE_CATEGORIES.map(cat => <option key={cat.id} value={cat.id}>{cat.icon} {cat.label}</option>)}</select></div>
            <div><label style={fieldLabel}>Amount ($)</label><input type="number" value={expenseForm.amount} onChange={e => setExpenseForm(f => ({ ...f, amount: e.target.value }))} placeholder="0.00" style={fieldInput} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 16, marginBottom: 20 }}>
            <div><label style={fieldLabel}>Recurrence</label><select value={expenseForm.recurrence} onChange={e => setExpenseForm(f => ({ ...f, recurrence: e.target.value }))} style={{ ...selectStyle, width: "100%", padding: "9px 12px" }}>{RECURRENCE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
            <div><label style={fieldLabel}>Start Date</label><input type="date" value={expenseForm.startDate} onChange={e => setExpenseForm(f => ({ ...f, startDate: e.target.value }))} style={fieldInput} /></div>
            <div><label style={fieldLabel}>Notes</label><input value={expenseForm.notes} onChange={e => setExpenseForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes..." style={fieldInput} /></div>
          </div>
          {/* Receipt Upload */}
          <div style={{ marginBottom: 20, padding: "14px 16px", background: c.bg, borderRadius: 10, border: `1px solid ${c.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: formReceipts.length > 0 || (editingExpense && (expenseReceipts[editingExpense] || []).length > 0) ? 10 : 0 }}>
              <label style={{ ...fieldLabel, margin: 0 }}>Receipts / Documentation</label>
              <div>
                <input type="file" ref={receiptInputRef} accept="image/*,.pdf,.doc,.docx,.png,.jpg,.jpeg" multiple onChange={handleFormReceiptUpload} style={{ display: "none" }} />
                <button onClick={() => receiptInputRef.current?.click()} style={{ ...btnSecondary, padding: "5px 12px", fontSize: 11 }}>+ Attach File</button>
              </div>
            </div>
            {/* Existing receipts when editing */}
            {editingExpense && (expenseReceipts[editingExpense] || []).map(r => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${c.border}08` }}>
                <span style={{ fontSize: 14 }}>{r.type?.includes("pdf") ? "📄" : r.type?.includes("image") ? "🖼" : "📎"}</span>
                <span style={{ fontSize: 12, color: c.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span style={{ fontSize: 10, color: c.textDim }}>{(r.size / 1024).toFixed(0)}KB</span>
                <button onClick={() => downloadAttachment(r)} style={{ background: "none", border: "none", color: c.blue, cursor: "pointer", fontSize: 11 }}>↓</button>
                <button onClick={() => removeReceipt(editingExpense, r.id)} style={{ background: "none", border: "none", color: c.red, cursor: "pointer", fontSize: 11 }}>✕</button>
              </div>
            ))}
            {/* Newly attached receipts */}
            {formReceipts.map(r => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${c.border}08` }}>
                <span style={{ fontSize: 14 }}>{r.type?.includes("pdf") ? "📄" : r.type?.includes("image") ? "🖼" : "📎"}</span>
                <span style={{ fontSize: 12, color: c.green, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span style={{ fontSize: 10, color: c.textDim }}>{(r.size / 1024).toFixed(0)}KB</span>
                <span style={{ fontSize: 10, color: c.green, fontStyle: "italic" }}>new</span>
                <button onClick={() => setFormReceipts(prev => prev.filter(f => f.id !== r.id))} style={{ background: "none", border: "none", color: c.red, cursor: "pointer", fontSize: 11 }}>✕</button>
              </div>
            ))}
            {!editingExpense && formReceipts.length === 0 && <div style={{ fontSize: 11, color: c.textMuted, marginTop: 4 }}>No receipts attached. Attach invoices, screenshots, or PDFs for your records.</div>}
          </div>
          <div style={{ display: "flex", gap: 10 }}><button onClick={saveExpense} style={btnPrimary}>{editingExpense ? "Save Changes" : "Add Expense"}</button><button onClick={resetExpenseForm} style={btnSecondary}>Cancel</button></div>
        </div>
      )}
      <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
        <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 14px", fontFamily: "'JetBrains Mono', monospace" }}>Expenses ({filteredExpenses.length})</h3>
        <input type="file" ref={quickReceiptRef} accept="image/*,.pdf,.doc,.docx,.png,.jpg,.jpeg" multiple onChange={handleReceiptUpload} style={{ display: "none" }} />
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{["", "Name", "Category", "Amount", "Recurrence", "Monthly", "Annual", "Date", "Receipts", "Notes", ""].map((h, i) => <th key={i} style={{ padding: "8px 10px", textAlign: "left", color: c.textDim, fontWeight: 500, borderBottom: `1px solid ${c.border}`, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{h}</th>)}</tr></thead>
            <tbody>{filteredExpenses.map(exp => {
              const amt = parseFloat(exp.amount) || 0;
              let monthly = 0, annual = 0;
              switch (exp.recurrence) { case "Weekly": monthly = amt * 4.33; annual = amt * 52; break; case "Monthly": monthly = amt; annual = amt * 12; break; case "Quarterly": monthly = amt / 3; annual = amt * 4; break; case "Annually": monthly = amt / 12; annual = amt; break; default: annual = amt; }
              const cat = EXPENSE_CATEGORIES.find(ec => ec.id === exp.category) || { label: exp.category, icon: "○" };
              return (
                <tr key={exp.id} style={{ borderBottom: `1px solid ${c.border}08`, opacity: exp.active ? 1 : 0.4 }}>
                  <td style={{ padding: "10px", width: 30 }}><button onClick={() => setExpenses(p => p.map(e => e.id === exp.id ? { ...e, active: !e.active } : e))} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, padding: 0 }}>{exp.active ? <span style={{ color: c.green }}>●</span> : <span style={{ color: c.textMuted }}>○</span>}</button></td>
                  <td style={{ padding: "10px", color: c.text, fontWeight: 500 }}>{exp.name}</td>
                  <td style={{ padding: "10px" }}><span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, background: c.purpleDim, color: c.purple }}>{cat.icon} {cat.label}</span></td>
                  <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>${amt.toFixed(2)}</td>
                  <td style={{ padding: "10px" }}><span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, background: exp.recurrence === "One-time" ? c.cyanDim : c.amberDim, color: exp.recurrence === "One-time" ? c.cyan : c.amber }}>{exp.recurrence}</span></td>
                  <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace", color: c.textDim }}>{exp.recurrence === "One-time" ? "—" : `$${monthly.toFixed(2)}`}</td>
                  <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace", color: c.amber }}>{exp.recurrence === "One-time" ? `$${amt.toFixed(2)}` : `$${annual.toFixed(2)}`}</td>
                  <td style={{ padding: "10px", fontSize: 12, color: c.textDim, fontFamily: "'JetBrains Mono', monospace" }}>{exp.startDate}</td>
                  <td style={{ padding: "10px" }}>
                    {(expenseReceipts[exp.id] || []).length > 0 ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: c.greenDim, color: c.green }}>📎 {(expenseReceipts[exp.id] || []).length}</span>
                        <button onClick={() => { receiptExpenseIdRef.current = exp.id; quickReceiptRef.current?.click(); }} style={{ background: "none", border: "none", color: c.blue, cursor: "pointer", fontSize: 11 }}>+</button>
                      </div>
                    ) : (
                      <button onClick={() => { receiptExpenseIdRef.current = exp.id; quickReceiptRef.current?.click(); }} style={{ background: "none", border: `1px solid ${c.border}`, borderRadius: 6, padding: "2px 8px", color: c.textDim, cursor: "pointer", fontSize: 10 }}>Attach</button>
                    )}
                  </td>
                  <td style={{ padding: "10px", fontSize: 12, color: c.textDim, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{exp.notes}</td>
                  <td style={{ padding: "10px" }}><div style={{ display: "flex", gap: 6 }}><button onClick={() => { setExpenseForm({ ...exp, amount: String(exp.amount) }); setEditingExpense(exp.id); setShowAddExpense(true); }} style={{ background: "none", border: `1px solid ${c.border}`, borderRadius: 6, padding: "3px 8px", color: c.textDim, cursor: "pointer", fontSize: 11 }}>Edit</button><button onClick={() => setExpenses(p => p.filter(e => e.id !== exp.id))} style={{ background: "none", border: `1px solid ${c.border}`, borderRadius: 6, padding: "3px 8px", color: c.red, cursor: "pointer", fontSize: 11 }}>Del</button></div></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
  };

  /* ═══ IMPORT & API ═══ */
  const renderImport = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {importStatus && (
        <div style={{ background: importStatus.type === "success" ? c.greenDim : c.redDim, border: `1px solid ${importStatus.type === "success" ? "rgba(0,230,138,0.3)" : "rgba(255,77,106,0.3)"}`, borderRadius: 12, padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, color: importStatus.type === "success" ? c.green : c.red, fontSize: 13, fontWeight: 500, animation: "fadeIn .2s ease" }}>
          <span style={{ fontSize: 16 }}>{importStatus.type === "success" ? "✓" : "✕"}</span>{importStatus.message}
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        {[["csv", "CSV Import"], ["api", "API Integrations"]].map(([id, label]) => (
          <button key={id} onClick={() => setImportTab(id)} style={{ ...btnSecondary, padding: "10px 20px", background: importTab === id ? "rgba(255,255,255,0.08)" : "transparent", borderColor: importTab === id ? c.borderLight : c.border, color: importTab === id ? c.text : c.textDim, fontWeight: importTab === id ? 600 : 400 }}>{label}</button>
        ))}
      </div>

      {importTab === "csv" && (<>
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: c.text, margin: "0 0 4px" }}>Import Bets from CSV</h3>
          <p style={{ fontSize: 13, color: c.textDim, lineHeight: 1.7, margin: "0 0 16px" }}>Upload your transaction export and bets import instantly. Supports Pikkit, Polymarket, and generic CSV formats. Imports straights, parlays, round robins & cash-outs. Partial parlay payouts handled automatically. Cash-outs and pushes graded as push. All dates converted to EST. Duplicates auto-filtered by bet ID.</p>
          <div style={{ background: "rgba(99,102,241,0.06)", border: `1px solid rgba(99,102,241,0.15)`, borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: c.blue, marginBottom: 6 }}>Your format (auto-detected)</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {["bet_id", "sportsbook", "type", "status", "odds", "closing_line", "amount", "profit", "time_placed_iso", "time_settled_iso", "bet_info", "sports", "leagues"].map(h => <span key={h} style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontFamily: "'JetBrains Mono', monospace", background: c.blueDim, color: c.blue }}>{h}</span>)}
            </div>
          </div>
          <div style={{ background: "rgba(168,85,247,0.06)", border: `1px solid rgba(168,85,247,0.15)`, borderRadius: 10, padding: "12px 16px", marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: c.purple, marginBottom: 6 }}>Live bet detection (4 rules)</div>
            <div style={{ fontSize: 11, color: c.textDim, lineHeight: 1.7 }}>
              <strong style={{ color: c.text }}>1.</strong> "Live" keyword in bet_info &nbsp;
              <strong style={{ color: c.text }}>2.</strong> Bet105 (exchange = always live) &nbsp;
              <strong style={{ color: c.text }}>3.</strong> Mid-game period markers (2nd Half, 3rd Qtr, etc.) &nbsp;
              <strong style={{ color: c.text }}>4.</strong> Place→settle gap {"<"} 90 min
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: c.textDim }}>Assign to profile:</span>
              <div style={{ display: "flex", gap: 3, background: "rgba(255,255,255,0.03)", border: `1px solid ${c.border}`, borderRadius: 8, padding: "2px 3px" }}>
                {profiles.map(p => (
                  <button key={p.id} onClick={() => setImportProfile(p.id)} style={{ background: importProfile === p.id ? c.greenDim : "transparent", border: importProfile === p.id ? `1px solid ${c.green}44` : "1px solid transparent", borderRadius: 6, padding: "4px 12px", color: importProfile === p.id ? c.green : c.textDim, fontSize: 11, cursor: "pointer", fontWeight: importProfile === p.id ? 700 : 400, transition: "all 0.15s" }}>{p.name}</button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
            <input type="file" ref={fileInputRef} accept=".csv,.tsv,.txt" onChange={handleFileUpload} style={{ display: "none" }} />
            <button onClick={() => fileInputRef.current?.click()} style={{ ...btnPrimary, padding: "12px 28px", fontSize: 14 }}>Upload CSV File</button>
            <span style={{ fontSize: 12, color: c.textDim }}>Drop your transactions.csv — imports to <strong style={{ color: c.green }}>{profiles.find(p => p.id === importProfile)?.name || importProfile}</strong></span>
          </div>
          <div style={{ borderTop: `1px solid ${c.border}`, paddingTop: 16, marginTop: 4 }}>
            <div style={{ fontSize: 12, color: c.textDim, marginBottom: 8 }}>Or paste CSV data manually:</div>
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)} onPaste={e => { setTimeout(() => { const text = e.target.value; setCsvText(text); triggerCSVParse(text); }, 50); }} placeholder={"bet_id,sportsbook,type,status,odds,closing_line,ev,amount,profit,time_placed,time_settled,time_placed_iso,...\n639061807...,Draftkings Sportsbook,straight,SETTLED_LOSS,1.909,...,287.49,-287.49,..."} style={{ ...fieldInput, width: "100%", minHeight: 100, resize: "vertical", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, lineHeight: 1.6, boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button onClick={triggerCSVParse} style={btnPrimary}>Parse & Import</button>
              {csvText && <button onClick={() => { setCsvText(""); setCsvPreview(null); }} style={{ ...btnSecondary, padding: "8px 16px", fontSize: 12 }}>Clear</button>}
            </div>
          </div>
        </div>
        {csvPreview && (
          <div style={{ background: c.card, border: `1px solid ${c.borderLight}`, borderRadius: 16, padding: 22, animation: "fadeIn .2s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div><h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: c.text }}>Preview (generic CSV)</h3><span style={{ fontSize: 12, color: c.textDim }}>{csvPreview.rows.length} rows · {csvPreview.headers.length} columns</span></div>
              <button onClick={importCSVBets} style={btnPrimary}>Import {csvPreview.rows.length} Bets</button>
            </div>
            <div style={{ overflowX: "auto", maxHeight: 300, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, background: c.card }}><tr>{csvPreview.headers.map(h => <th key={h} style={{ padding: "8px", textAlign: "left", color: c.blue, fontWeight: 600, borderBottom: `1px solid ${c.border}`, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>{h}</th>)}</tr></thead>
                <tbody>{csvPreview.rows.slice(0, 10).map((row, i) => <tr key={i} style={{ borderBottom: `1px solid ${c.border}08` }}>{csvPreview.headers.map(h => <td key={h} style={{ padding: "6px 8px", color: c.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>{row[h] || "—"}</td>)}</tr>)}</tbody>
              </table>
              {csvPreview.rows.length > 10 && <div style={{ padding: "10px 0", fontSize: 12, color: c.textDim, textAlign: "center" }}>…and {csvPreview.rows.length - 10} more rows</div>}
            </div>
          </div>
        )}

        {/* Backup & Restore */}
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 6px", fontFamily: "'JetBrains Mono', monospace" }}>Data Management</h3>
          <p style={{ fontSize: 12, color: c.textDim, lineHeight: 1.6, margin: "0 0 16px" }}>
            Your data syncs across devices via your Claude account automatically.
            Backups give you a downloadable JSON file as a safety net.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={exportBackup} style={{ ...btnPrimary, padding: "10px 20px", display: "flex", alignItems: "center", gap: 6 }}>
              ↓ Export Backup
            </button>
            <label style={{ ...btnSecondary, padding: "10px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
              ↑ Restore Backup
              <input type="file" accept=".json" onChange={importBackup} style={{ display: "none" }} />
            </label>
            <span style={{ fontSize: 11, color: c.textDim, marginLeft: 4 }}>
              {bets.length} bets · {expenses.length} expenses · {profiles.length} profile{profiles.length !== 1 ? "s" : ""} · {bankrollEntries.length} books
            </span>
          </div>
        </div>

        {/* Danger Zone */}
        <div style={{ background: "rgba(255,77,106,0.03)", border: `1px solid rgba(255,77,106,0.15)`, borderRadius: 14, padding: "16px 22px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: c.red }}>Clear All Bets</div>
            <div style={{ fontSize: 12, color: c.textDim, marginTop: 2 }}>Remove all {bets.length} imported bets. Profiles, expenses, bankroll data are kept.</div>
          </div>
          {!confirmClearBets ? (
            <button onClick={() => setConfirmClearBets(true)} disabled={bets.length === 0} style={{ ...btnSecondary, padding: "8px 16px", fontSize: 12, color: c.red, borderColor: "rgba(255,77,106,0.3)", opacity: bets.length === 0 ? 0.4 : 1 }}>Clear Bets</button>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: c.red, fontWeight: 600 }}>Are you sure?</span>
              <button onClick={() => { setBets([]); setConfirmClearBets(false); setImportStatus({ type: "success", message: "All bets cleared" }); setTimeout(() => setImportStatus(null), 3000); }} style={{ background: "rgba(255,77,106,0.15)", border: `1px solid ${c.red}`, borderRadius: 8, padding: "6px 14px", color: c.red, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Yes, delete all</button>
              <button onClick={() => setConfirmClearBets(false)} style={{ ...btnSecondary, padding: "6px 14px", fontSize: 12 }}>Cancel</button>
            </div>
          )}
        </div>
      </>)}

      {importTab === "api" && (<>
        <div style={{ background: `linear-gradient(135deg, ${c.cyanDim}, ${c.card})`, border: `1px solid rgba(6,182,212,0.2)`, borderRadius: 16, padding: 24 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: c.text }}>CLV API Integration — 3-Book Average</h3>
          <p style={{ fontSize: 13, color: c.textDim, lineHeight: 1.7, margin: 0 }}>Connect to sharp sportsbook APIs to automatically fetch closing line data. Your CLV is calculated as the average closing line across <strong style={{ color: c.text }}>Pinnacle + Bookmaker.eu + BetOnline.ag</strong> — the three sharpest books — for the most accurate true closing line. When synced, closing odds are matched to your existing bets for accurate CLV/EV tracking.</p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {apiEndpoints.map(ep => (
            <div key={ep.id} style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 14, padding: "18px 22px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, flex: 1, minWidth: 200 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0, background: ep.status === "connected" ? c.green : ep.status === "syncing" ? c.amber : ep.status === "error" ? c.red : c.textMuted, boxShadow: ep.status === "connected" ? `0 0 8px ${c.greenGlow}` : ep.status === "error" ? "0 0 8px rgba(255,77,106,0.4)" : "none", animation: ep.status === "syncing" ? "pulse 1s ease infinite" : "none" }} />
                <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
                <div><div style={{ fontSize: 14, fontWeight: 600, color: c.text }}>{ep.name}</div><div style={{ fontSize: 11, color: c.textDim, fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>{ep.url}</div></div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ textAlign: "right" }}>
                  <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: ep.sport === "All" ? c.purpleDim : c.blueDim, color: ep.sport === "All" ? c.purple : c.blue }}>{ep.sport}</span>
                  {ep.lastSync && <div style={{ fontSize: 10, color: c.textDim, marginTop: 4 }}>Last: {new Date(ep.lastSync).toLocaleString()}</div>}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => syncEndpoint(ep.id)} disabled={!ep.active || ep.status === "syncing"} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 11, opacity: ep.active ? 1 : 0.4 }}>{ep.status === "syncing" ? "Syncing…" : "Sync"}</button>
                  <button onClick={() => setApiEndpoints(p => p.map(e => e.id === ep.id ? { ...e, active: !e.active, status: e.active ? "disconnected" : "connecting" } : e))} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 11, color: ep.active ? c.green : c.textDim }}>{ep.active ? "On" : "Off"}</button>
                  <button onClick={() => setApiEndpoints(p => p.filter(e => e.id !== ep.id))} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 11, color: c.red, borderColor: "rgba(255,77,106,0.3)" }}>×</button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {!showAddApi ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button onClick={() => setShowAddApi(true)} style={{ ...btnSecondary, alignSelf: "flex-start" }}>+ Add API Endpoint</button>
            {apiEndpoints.filter(ep => ep.active).length > 0 && (
              <button onClick={syncAllEndpoints} disabled={apiEndpoints.some(ep => ep.status === "syncing")} style={{ ...btnPrimary, padding: "10px 20px", display: "flex", alignItems: "center", gap: 6, opacity: apiEndpoints.some(ep => ep.status === "syncing") ? 0.6 : 1 }}>
                {apiEndpoints.some(ep => ep.status === "syncing") ? "⟳ Syncing…" : "⟳ Sync All Active"}
              </button>
            )}
          </div>
        ) : (
          <div style={{ background: c.card, border: `1px solid ${c.borderLight}`, borderRadius: 16, padding: 24, animation: "fadeIn .2s ease" }}>
            <h3 style={{ margin: "0 0 18px", fontSize: 15, fontWeight: 700, color: c.text }}>New API Endpoint</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 16, marginBottom: 16 }}>
              <div><label style={fieldLabel}>Provider Name</label><input value={apiForm.name} onChange={e => setApiForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Pinnacle CLV" style={fieldInput} /></div>
              <div><label style={fieldLabel}>Endpoint URL</label><input value={apiForm.url} onChange={e => setApiForm(f => ({ ...f, url: e.target.value }))} placeholder="https://api.provider.com/v1/odds" style={fieldInput} /></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 20 }}>
              <div><label style={fieldLabel}>API Key</label><input type="password" value={apiForm.key} onChange={e => setApiForm(f => ({ ...f, key: e.target.value }))} placeholder="sk_live_xxxxxxxx" style={fieldInput} /></div>
              <div><label style={fieldLabel}>Sport/League Filter</label><select value={apiForm.sport} onChange={e => setApiForm(f => ({ ...f, sport: e.target.value }))} style={{ ...selectStyle, width: "100%", padding: "9px 12px" }}><option value="All">All</option>{SPORTS.map(s => <option key={`s_${s}`} value={s}>{s}</option>)}{ALL_LEAGUES.map(l => <option key={`l_${l}`} value={l}>{l}</option>)}</select></div>
            </div>
            <div style={{ display: "flex", gap: 10 }}><button onClick={saveApiEndpoint} style={btnPrimary}>Add Endpoint</button><button onClick={() => setShowAddApi(false)} style={btnSecondary}>Cancel</button></div>
          </div>
        )}
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
          <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 14px", fontFamily: "'JetBrains Mono', monospace" }}>How the API Integration Works</h3>
          <p style={{ fontSize: 12, color: c.textDim, lineHeight: 1.6, margin: "0 0 16px" }}>Add your odds provider endpoints above, then hit <strong style={{ color: c.text }}>Sync</strong> to pull closing line data and match it to your imported bets. CLV is calculated as the average across all connected sharp books.</p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 18 }}>
            {[
              { icon: "🔗", task: "Add Endpoints", desc: "Store connection details for sharp odds providers — Pinnacle, Bookmaker, BetOnline, OpticOdds, or any REST API that returns odds data. Each endpoint has its own API key and sport filter.", color: c.cyan },
              { icon: "🔄", task: "Sync Closing Lines", desc: "Hit Sync to fetch odds from connected endpoints. The system matches closing odds to your existing bets by event, market, and timing — then updates the closingOdds field on each matched bet.", color: c.blue },
              { icon: "📊", task: "CLV Calculation", desc: "Once closing odds are synced, CLV is auto-calculated across the whole app. Your CLV = the difference between the odds you got and the closing line, expressed as implied probability edge.", color: c.green },
            ].map(s => (
              <div key={s.task} style={{ padding: 16, background: "rgba(255,255,255,0.02)", borderRadius: 10, border: `1px solid ${c.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 16 }}>{s.icon}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>{s.task}</span>
                </div>
                <div style={{ fontSize: 11, color: c.textDim, lineHeight: 1.5 }}>{s.desc}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div style={{ padding: 16, background: "rgba(255,255,255,0.02)", borderRadius: 10, border: `1px solid ${c.border}` }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: c.text, marginBottom: 6 }}>Live/Pre-Game Classification</div>
              <p style={{ fontSize: 11, color: c.textDim, margin: 0, lineHeight: 1.6 }}>
                Bets are auto-classified during CSV import using 4 rules: "Live" keyword in bet info, Bet105 exchange detection, mid-game period markers (2nd Half, 3rd Qtr, etc.), and place→settle gap under 90 minutes. Pre-game bets get full CLV tracking. Live bets use a 5% assumed edge.
              </p>
            </div>
            <div style={{ padding: 16, background: "rgba(255,255,255,0.02)", borderRadius: 10, border: `1px solid ${c.border}` }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: c.text, marginBottom: 6 }}>Without API Endpoints</div>
              <p style={{ fontSize: 11, color: c.textDim, margin: 0, lineHeight: 1.6 }}>
                CLV still works without any API connections — it uses the <code style={{ background: "rgba(255,255,255,0.06)", padding: "1px 4px", borderRadius: 3 }}>closing_line</code> field from your CSV imports. API endpoints just provide a second, sharper source of closing data and can overwrite stale or missing closing odds.
              </p>
            </div>
          </div>
        </div>
      </>)}
    </div>
  );

  /* ═══ ALL BETS ═══ */
  const renderBets = () => (
    <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, color: c.textDim, textTransform: "uppercase", letterSpacing: 1.2, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>All Bets ({filtered.length})</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={filterSport} onChange={e => { setFilterSport(e.target.value); setFilterLeague("All"); }} style={selectStyle}><option value="All">All Sports</option>{SPORTS.map(s => <option key={s} value={s}>{s}</option>)}</select>
          <select value={filterLeague} onChange={e => setFilterLeague(e.target.value)} style={selectStyle}><option value="All">All Leagues</option>{(filterSport === "All" ? ALL_LEAGUES : (LEAGUES[filterSport] || [])).map(l => <option key={l} value={l}>{l}</option>)}</select>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} style={selectStyle}><option value="All">All Types</option>{BET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select>
        </div>
      </div>
      <div style={{ overflowX: "auto", maxHeight: "60vh", overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead style={{ position: "sticky", top: 0, background: c.card, zIndex: 2 }}><tr>{["Date", "League", "Event", "Pick", "Type", "Odds", "Close", "CLV", "Stake", "Book", "Result", "P&L"].map(h => <th key={h} style={{ padding: "10px 8px", textAlign: "left", color: c.textDim, fontWeight: 500, borderBottom: `1px solid ${c.borderLight}`, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{h}</th>)}</tr></thead>
          <tbody>{filtered.map(b => {
            const clv = ((impliedProb(b.closingOdds) - impliedProb(b.odds)) / impliedProb(b.odds)) * 100;
            return (
              <tr key={b.id} style={{ borderBottom: `1px solid ${c.border}08` }}>
                <td style={{ padding: "8px", color: c.textDim, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{b.date}</td>
                <td style={{ padding: "8px" }}><span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 10, background: c.purpleDim, color: c.purple }}>{b.league || b.sport}</span></td>
                <td style={{ padding: "8px", color: c.text, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.event}</td>
                <td style={{ padding: "8px", color: c.text, fontWeight: 500 }}>{b.pick}</td>
                <td style={{ padding: "8px", fontSize: 11, color: c.textDim }}>{b.type}</td>
                <td style={{ padding: "8px", fontFamily: "'JetBrains Mono', monospace", color: c.text }}>{formatOdds(b.odds)}</td>
                <td style={{ padding: "8px", fontFamily: "'JetBrains Mono', monospace", color: c.textDim }}>{formatOdds(b.closingOdds)}</td>
                <td style={{ padding: "8px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: clv >= 0 ? c.green : c.red }}>{clv >= 0 ? "+" : ""}{clv.toFixed(1)}%</td>
                <td style={{ padding: "8px", fontFamily: "'JetBrains Mono', monospace" }}>${b.stake}</td>
                <td style={{ padding: "8px", fontSize: 11, color: c.textDim }}>{b.sportsbook}</td>
                <td style={{ padding: "8px" }}><span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: b.result === "won" ? c.greenDim : c.redDim, color: b.result === "won" ? c.green : c.red }}>{b.result.toUpperCase()}</span></td>
                <td style={{ padding: "8px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: b.profit >= 0 ? c.green : c.red }}>{b.profit >= 0 ? "+" : ""}{formatMoney(b.profit)}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </div>
  );

  /* ═══ LAYOUT ═══ */
  return (
    <div style={{ minHeight: "100vh", background: c.bg, color: c.text, fontFamily: "'DM Sans', -apple-system, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`*{box-sizing:border-box}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${c.borderLight};border-radius:3px}input[type=number]::-webkit-inner-spin-button{opacity:.5}@keyframes fadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}@keyframes slideDown{from{opacity:0;transform:translateY(-100%)}to{opacity:1;transform:translateY(0)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}`}</style>

      {/* ─── Update Banner ─── */}
      {updateAvailable && !updateDismissed && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999, animation: "slideDown 0.4s ease", background: updateAvailable.forceUpdate ? `linear-gradient(135deg, ${c.red}, #cc2244)` : `linear-gradient(135deg, ${c.blue}, ${c.purple})`, padding: "10px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.5)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
              {updateAvailable.forceUpdate ? "⚠" : "✦"}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
                {updateAvailable.forceUpdate ? "Critical Update Required" : "Update Available"} — v{updateAvailable.version}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.75)", marginTop: 1 }}>
                {updateAvailable.notes || "Bug fixes and improvements"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
            <button onClick={() => setShowChangelog(true)} style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 8, padding: "6px 14px", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }}>
              What's New
            </button>
            <button onClick={applyUpdate} style={{ background: "rgba(255,255,255,0.95)", border: "none", borderRadius: 8, padding: "6px 18px", color: "#111", fontSize: 12, fontWeight: 700, cursor: "pointer", transition: "all 0.2s" }}>
              Update Now
            </button>
            {!updateAvailable.forceUpdate && (
              <button onClick={() => setUpdateDismissed(true)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.6)", fontSize: 16, cursor: "pointer", padding: "4px 8px", lineHeight: 1 }}>✕</button>
            )}
          </div>
        </div>
      )}

      {/* ─── Changelog Modal ─── */}
      {showChangelog && updateAvailable?.changelog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn 0.2s ease" }} onClick={() => setShowChangelog(false)}>
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 18, padding: 32, width: 460, maxHeight: "70vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: c.text, fontFamily: "'Space Grotesk', sans-serif" }}>Changelog</h2>
              <button onClick={() => setShowChangelog(false)} style={{ background: "none", border: "none", color: c.textDim, fontSize: 18, cursor: "pointer" }}>✕</button>
            </div>
            {updateAvailable.changelog.map((entry, i) => (
              <div key={i} style={{ marginBottom: 20, paddingBottom: 16, borderBottom: i < updateAvailable.changelog.length - 1 ? `1px solid ${c.border}` : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{ background: i === 0 ? c.greenDim : "rgba(255,255,255,0.04)", color: i === 0 ? c.green : c.textDim, padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>v{entry.version}</span>
                  <span style={{ fontSize: 12, color: c.textDim }}>{entry.date}</span>
                  {i === 0 && <span style={{ fontSize: 10, color: c.green, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Latest</span>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {entry.changes.map((change, j) => (
                    <div key={j} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: c.text, lineHeight: 1.5 }}>
                      <span style={{ color: c.green, marginTop: 2, flexShrink: 0 }}>•</span>
                      <span>{change}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <button onClick={() => { setShowChangelog(false); applyUpdate(); }} style={{ width: "100%", background: `linear-gradient(135deg, ${c.green}, ${c.blue})`, border: "none", borderRadius: 10, padding: "12px 0", color: "#000", fontSize: 14, fontWeight: 700, cursor: "pointer", marginTop: 8 }}>
              Update to v{updateAvailable.version}
            </button>
          </div>
        </div>
      )}
      <div style={{ borderBottom: `1px solid ${c.border}`, padding: "16px 28px", display: "flex", justifyContent: "space-between", alignItems: "center", background: `linear-gradient(180deg, rgba(10,11,15,0.98), ${c.bg})`, backdropFilter: "blur(12px)", position: "sticky", top: (updateAvailable && !updateDismissed) ? 48 : 0, zIndex: 50, transition: "top 0.3s ease" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: `linear-gradient(135deg, ${c.green}, ${c.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: "#000" }}>⚡</div>
          <div><h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif", letterSpacing: -0.5 }}>EdgeTracker</h1><span style={{ fontSize: 10, color: c.textDim, letterSpacing: 1.5, textTransform: "uppercase" }}>Sports Betting Analytics</span></div>
          <span style={{ fontSize: 10, fontWeight: 600, color: c.textDim, background: "rgba(255,255,255,0.04)", border: `1px solid ${c.border}`, borderRadius: 5, padding: "2px 7px", fontFamily: "'JetBrains Mono', monospace", cursor: "pointer" }} onClick={() => { if (updateAvailable) setShowChangelog(true); }} title={`Version ${APP_VERSION}`}>v{APP_VERSION}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Profile switcher — dropdown */}
          <div style={{ position: "relative" }}>
            <button onClick={() => setShowProfileMenu(p => !p)} style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.03)", border: `1px solid ${c.border}`, borderRadius: 10, padding: "7px 14px", cursor: "pointer", transition: "all 0.2s" }}>
              <div style={{ width: 22, height: 22, borderRadius: 7, background: `linear-gradient(135deg, ${c.green}44, ${c.blue}44)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: c.green }}>{(profiles.find(p => p.id === activeProfile)?.name || "All")[0].toUpperCase()}</div>
              <span style={{ fontSize: 12, fontWeight: 600, color: c.text }}>{activeProfile === "all" ? "All Profiles" : profiles.find(p => p.id === activeProfile)?.name || activeProfile}</span>
              <span style={{ fontSize: 10, color: c.textDim, transform: showProfileMenu ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
            </button>
            {showProfileMenu && (
              <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, background: c.card, border: `1px solid ${c.border}`, borderRadius: 12, padding: 6, minWidth: 220, zIndex: 60, boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
                {[...profiles, { id: "all", name: "All Profiles", _system: true }].map(p => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    {editingProfile === p.id ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, padding: "4px 8px" }}>
                        <input value={editProfileName} onChange={e => setEditProfileName(e.target.value)} autoFocus style={{ ...fieldInput, padding: "4px 8px", fontSize: 12, flex: 1 }} onKeyDown={e => {
                          if (e.key === "Enter" && editProfileName.trim()) { setProfiles(prev => prev.map(pr => pr.id === p.id ? { ...pr, name: editProfileName.trim() } : pr)); setEditingProfile(null); }
                          if (e.key === "Escape") setEditingProfile(null);
                        }} />
                        <button onClick={() => { if (editProfileName.trim()) { setProfiles(prev => prev.map(pr => pr.id === p.id ? { ...pr, name: editProfileName.trim() } : pr)); } setEditingProfile(null); }} style={{ background: "none", border: "none", color: c.green, cursor: "pointer", fontSize: 12, padding: 2 }}>✓</button>
                        <button onClick={() => setEditingProfile(null)} style={{ background: "none", border: "none", color: c.textDim, cursor: "pointer", fontSize: 12, padding: 2 }}>✕</button>
                      </div>
                    ) : (
                      <>
                        <button onClick={() => { setActiveProfile(p.id); setShowProfileMenu(false); setEditingProfile(null); setConfirmDeleteProfile(null); }} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, background: activeProfile === p.id ? "rgba(0,230,138,0.08)" : "transparent", border: "none", borderRadius: 8, padding: "8px 12px", cursor: "pointer", transition: "all 0.15s", textAlign: "left" }}>
                          <div style={{ width: 20, height: 20, borderRadius: 6, background: activeProfile === p.id ? `linear-gradient(135deg, ${c.green}44, ${c.blue}44)` : "rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: activeProfile === p.id ? c.green : c.textDim }}>{p.name[0].toUpperCase()}</div>
                          <span style={{ fontSize: 12, color: activeProfile === p.id ? c.green : c.text, fontWeight: activeProfile === p.id ? 600 : 400 }}>{p.name}</span>
                          {activeProfile === p.id && <span style={{ marginLeft: "auto", fontSize: 11, color: c.green }}>✓</span>}
                        </button>
                        {!p._system && (
                          <div style={{ display: "flex", gap: 2, paddingRight: 6 }}>
                            <button onClick={(e) => { e.stopPropagation(); setEditingProfile(p.id); setEditProfileName(p.name); setConfirmDeleteProfile(null); }} style={{ background: "none", border: "none", color: c.textDim, cursor: "pointer", fontSize: 10, padding: "4px", borderRadius: 4, opacity: 0.6, transition: "opacity 0.15s" }} onMouseEnter={e => e.target.style.opacity = 1} onMouseLeave={e => e.target.style.opacity = 0.6} title="Rename">✏️</button>
                            {profiles.length > 1 && (
                              <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteProfile(confirmDeleteProfile === p.id ? null : p.id); setEditingProfile(null); }} style={{ background: "none", border: "none", color: confirmDeleteProfile === p.id ? c.red : c.textDim, cursor: "pointer", fontSize: 10, padding: "4px", borderRadius: 4, opacity: confirmDeleteProfile === p.id ? 1 : 0.6, transition: "opacity 0.15s" }} onMouseEnter={e => e.target.style.opacity = 1} onMouseLeave={e => { if (confirmDeleteProfile !== p.id) e.target.style.opacity = 0.6; }} title="Delete">🗑</button>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}
                {confirmDeleteProfile && (
                  <div style={{ margin: "4px 6px", padding: "10px 12px", background: "rgba(255,77,106,0.08)", border: `1px solid ${c.red}33`, borderRadius: 8, animation: "fadeIn 0.2s ease" }}>
                    <div style={{ fontSize: 11, color: c.red, fontWeight: 600, marginBottom: 6 }}>Delete "{profiles.find(p => p.id === confirmDeleteProfile)?.name}"?</div>
                    <div style={{ fontSize: 10, color: c.textDim, marginBottom: 8, lineHeight: 1.4 }}>This removes the profile. Bets, transactions, and bankroll data tagged to this profile will remain but become unassigned.</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => {
                        const delId = confirmDeleteProfile;
                        setProfiles(prev => prev.filter(p => p.id !== delId));
                        if (activeProfile === delId) setActiveProfile(profiles.find(p => p.id !== delId)?.id || "all");
                        setConfirmDeleteProfile(null);
                      }} style={{ background: c.red, border: "none", borderRadius: 6, padding: "4px 12px", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Delete</button>
                      <button onClick={() => setConfirmDeleteProfile(null)} style={{ background: "none", border: `1px solid ${c.border}`, borderRadius: 6, padding: "4px 12px", color: c.textDim, fontSize: 11, cursor: "pointer" }}>Cancel</button>
                    </div>
                  </div>
                )}
                <div style={{ borderTop: `1px solid ${c.border}`, margin: "4px 0" }} />
                <button onClick={() => { setShowProfileMenu(false); setShowAddProfile(true); setEditingProfile(null); setConfirmDeleteProfile(null); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", background: "transparent", border: "none", borderRadius: 8, padding: "8px 12px", cursor: "pointer", textAlign: "left" }}>
                  <div style={{ width: 20, height: 20, borderRadius: 6, background: "rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: c.textDim }}>+</div>
                  <span style={{ fontSize: 12, color: c.textDim }}>Add Profile</span>
                </button>
              </div>
            )}
          </div>
          <nav style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ background: activeTab === tab.id ? "rgba(255,255,255,0.06)" : "transparent", border: activeTab === tab.id ? `1px solid ${c.border}` : "1px solid transparent", borderRadius: 10, padding: "8px 13px", color: activeTab === tab.id ? c.text : c.textDim, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, transition: "all 0.2s", fontWeight: activeTab === tab.id ? 600 : 400 }}>
                <span style={{ fontSize: 13 }}>{tab.icon}</span>{tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>
      {/* Add profile modal */}
      {showAddProfile && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setShowAddProfile(false)}>
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 28, width: 340 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: c.text }}>Add Profile</h3>
            <input value={newProfileName} onChange={e => setNewProfileName(e.target.value)} placeholder="Profile name..." style={{ ...fieldInput, width: "100%", marginBottom: 14 }} onKeyDown={e => { if (e.key === "Enter" && newProfileName.trim()) { const id = newProfileName.trim().toLowerCase().replace(/\s+/g, "_"); setProfiles(prev => [...prev, { id, name: newProfileName.trim() }]); setNewProfileName(""); setShowAddProfile(false); }}} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { if (!newProfileName.trim()) return; const id = newProfileName.trim().toLowerCase().replace(/\s+/g, "_"); setProfiles(prev => [...prev, { id, name: newProfileName.trim() }]); setNewProfileName(""); setShowAddProfile(false); }} style={{ ...btnSecondary, flex: 1, background: c.greenDim, borderColor: c.green + "44", color: c.green }}>Add</button>
              <button onClick={() => { setShowAddProfile(false); setNewProfileName(""); }} style={{ ...btnSecondary, flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <div style={{ padding: "24px 28px", maxWidth: 1240, margin: "0 auto" }}>
        {activeTab === "dashboard" && renderDashboard()}
        {activeTab === "calendar" && renderCalendar()}
        {activeTab === "strategy" && renderStrategy()}
        {activeTab === "bankroll" && renderBankroll()}
        {activeTab === "tax" && renderTax()}
        {activeTab === "accounting" && renderAccounting()}
        {activeTab === "import" && renderImport()}
        {activeTab === "bets" && renderBets()}
      </div>
    </div>
  );
}

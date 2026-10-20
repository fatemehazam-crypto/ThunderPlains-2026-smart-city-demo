import { useState, useEffect, useRef, useCallback, memo } from "react";
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { io } from "socket.io-client";

// Where the backend runs. Override with VITE_BACKEND_URL in frontend/.env if it is elsewhere.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

// ─── Constants ────────────────────────────────────────────────────────────────
const NODE_ICONS = {
  hub: "▣", environmental: "◈", medical: "♥", automation: "◉", traffic: "◐", security: "◆", gps: "◎"
};
const NODE_COLORS = {
  hub: "#378ADD", environmental: "#1D9E75", medical: "#E24B4A", automation: "#BA7517",
  traffic: "#7F77DD", security: "#D85A30", gps: "#0F6E56"
};
const SEVERITY_COLOR = { info: "#378ADD", warning: "#BA7517", critical: "#E24B4A", success: "#1D9E75" };
const SEVERITY_BG    = { info: "#E6F1FB", warning: "#FAEEDA", critical: "#FCEBEB", success: "#EAF3DE" };
const TRAFFIC_COLOR  = { green: "#1D9E75", yellow: "#BA7517", red: "#E24B4A", unknown: "#888780" };
const DISRUPTION_COLOR = { none: "#1D9E75", partial: "#BA7517", intermittent: "#D85A30", severe: "#E24B4A" };
const DISRUPTION_BG    = { none: "#EAF3DE", partial: "#FAEEDA", intermittent: "#FAECE7", severe: "#FCEBEB" };

const DEFAULT_CONFIG = {
  watchdogTimeout: 15, rssiThreshold: -85, signal433Threshold: -80,
  snrL1Threshold: 25, snrL5Threshold: 25, tempJumpThreshold: 5,
  rssiJumpThreshold: 15, satDropThreshold: 4, heartRateMin: 40,
  heartRateMax: 120, spo2Min: 94, packetLossWindow: 30,
};

// ─── Socket Hook ──────────────────────────────────────────────────────────────
function useSocket(url) {
  const [socket, setSocket] = useState(null);
  useEffect(() => {
    const s = io(url);
    setSocket(s);
    return () => s.disconnect();
  }, []);
  return socket;
}

// ─── Shared Sub-components ─────────────────────────────────────────────────────
function Sparkline({ data, color = "#378ADD", height = 36 }) {
  if (!data || data.length < 2) return <div style={{ height }} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`g${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
          fill={`url(#g${color.replace("#","")})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function StatusDot({ status }) {
  const colors = { online: "#1D9E75", offline: "#888780", degraded: "#E24B4A" };
  return <span style={{ display:"inline-block", width:8, height:8, borderRadius:"50%",
    background: colors[status] || "#888", marginRight:6, flexShrink:0 }} />;
}

function Badge({ text, severity = "info" }) {
  return <span style={{ fontSize:11, fontWeight:500, padding:"2px 8px", borderRadius:20,
    background: SEVERITY_BG[severity], color: SEVERITY_COLOR[severity],
    letterSpacing:"0.02em", whiteSpace:"nowrap" }}>{text}</span>;
}

function DisruptionBadge({ type }) {
  if (!type || type === "none") return null;
  const labels = { partial: "RF PARTIAL", intermittent: "RF INTERMITTENT", severe: "RF SEVERE" };
  return <span style={{ fontSize:10, fontWeight:500, padding:"2px 7px", borderRadius:20,
    background: DISRUPTION_BG[type], color: DISRUPTION_COLOR[type], letterSpacing:"0.03em" }}>
    {labels[type]}
  </span>;
}

function MetricRow({ label, value, unit, color, sparkData }) {
  const display = value === null || value === undefined ? "—" : `${value}`;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 0",
      borderBottom:"0.5px solid var(--color-border-tertiary)" }}>
      <span style={{ fontSize:12, color:"var(--color-text-secondary)", width:100, flexShrink:0 }}>{label}</span>
      <span style={{ fontSize:13, fontWeight:500, minWidth:52,
        color: value === null ? "var(--color-text-tertiary)" : "var(--color-text-primary)" }}>
        {display}<span style={{ fontSize:11, color:"var(--color-text-secondary)", marginLeft:2 }}>{unit}</span>
      </span>
      {sparkData && <div style={{ flex:1 }}><Sparkline data={sparkData} color={color} height={28} /></div>}
    </div>
  );
}

// The real controller sends one state for the whole intersection: north_south_green,
// east_west_yellow, all_red… Demo mode sends plain red / yellow / green.
function TrafficLight({ state }) {
  const s = String(state || "");
  const dir = /^(north_south|east_west)_(red|yellow|green)$/.exec(s);
  if (dir || s === "all_red") {
    const ns = s === "all_red" ? "red" : dir[1] === "north_south" ? dir[2] : "red";
    const ew = s === "all_red" ? "red" : dir[1] === "east_west"   ? dir[2] : "red";
    const lamps = (lit) => ["red","yellow","green"].map(c => (
      <div key={c} style={{ width:12, height:12, borderRadius:"50%",
        background: lit === c ? TRAFFIC_COLOR[c] : "var(--color-border-tertiary)", transition:"background 0.3s" }} />));
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {[["N–S", ns], ["E–W", ew]].map(([label, lit]) => (
          <div key={label} style={{ display:"flex", gap:6, alignItems:"center" }}>
            <span style={{ fontSize:11, width:30, color:"var(--color-text-tertiary)" }}>{label}</span>
            {lamps(lit)}
            <span style={{ fontSize:12, marginLeft:4, fontWeight:500, textTransform:"uppercase",
              letterSpacing:"0.05em", color: TRAFFIC_COLOR[lit] }}>{lit}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
      {["red","yellow","green"].map(c => (
        <div key={c} style={{ width:12, height:12, borderRadius:"50%",
          background: state === c ? TRAFFIC_COLOR[c] : "var(--color-border-tertiary)",
          transition:"background 0.3s" }} />
      ))}
      <span style={{ fontSize:12, marginLeft:4, fontWeight:500, textTransform:"uppercase",
        letterSpacing:"0.05em", color: TRAFFIC_COLOR[state] || "var(--color-text-tertiary)" }}>
        {state || "—"}
      </span>
    </div>
  );
}

function GPSPanel({ metrics }) {
  const lockOk = metrics?.lock_status === "locked";
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:8 }}>
      <div style={{ padding:"8px 12px", background: lockOk ? "#EAF3DE" : "#FCEBEB", borderRadius:8, textAlign:"center" }}>
        <div style={{ fontSize:11, color: lockOk ? "#3B6D11" : "#A32D2D", marginBottom:2 }}>Lock Status</div>
        <div style={{ fontSize:15, fontWeight:500, color: lockOk ? "#1D9E75" : "#E24B4A" }}>{metrics?.lock_status ?? "—"}</div>
      </div>
      <div style={{ padding:"8px 12px", background:"var(--color-background-secondary)", borderRadius:8, textAlign:"center" }}>
        <div style={{ fontSize:11, color:"var(--color-text-secondary)", marginBottom:2 }}>Satellites</div>
        <div style={{ fontSize:15, fontWeight:500 }}>{metrics?.satellites ?? 0}</div>
      </div>
      {[["SNR L1", metrics?.snr_l1, 25], ["SNR L5", metrics?.snr_l5, 25]].map(([lbl, val, thresh]) => (
        <div key={lbl} style={{ padding:"8px 12px", background:"var(--color-background-secondary)", borderRadius:8, textAlign:"center" }}>
          <div style={{ fontSize:11, color:"var(--color-text-secondary)", marginBottom:2 }}>{lbl}</div>
          <div style={{ fontSize:15, fontWeight:500, color: val < thresh ? "#E24B4A" : "var(--color-text-primary)" }}>
            {val ?? "—"}<span style={{ fontSize:11 }}> dB-Hz</span>
          </div>
        </div>
      ))}
    </div>
  );
}

const GENERIC_UNITS = { temperature:"°C", humidity:"%", wifi_rssi:"dBm", rssi:"dBm", signal_433:"dBm", heart_rate:"bpm", spo2:"%",
  snr_l1:"dB-Hz", snr_l5:"dB-Hz", video_fps:"fps", audio_db:"dB", pressure:"hPa", co2:"ppm", lux:"lx", battery:"V" };

function NodeCard({ id, def, state, histories, rfHealth, interference }) {
  const color  = NODE_COLORS[def.type] || "#888";
  const m      = state?.metrics || {};
  const status = state?.status  || "offline";
  const loss   = state?.packetLoss;
  const rf     = rfHealth || {};

  const renderMetrics = () => {
    switch (def.type) {
      case "hub":          return (<><MetricRow label="Video"      value={m.video_fps}  unit="fps" color={color} sparkData={histories?.video_fps} /><MetricRow label="Audio"      value={m.audio_db}   unit="dB"  color={color} sparkData={histories?.audio_db}  /><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi}  unit="dBm" color={color} sparkData={histories?.wifi_rssi} /></>);
      case "environmental":return (<><MetricRow label="Temperature" value={m.temperature} unit="°C" color={color} sparkData={histories?.temperature} /><MetricRow label="Humidity"    value={m.humidity}    unit="%" color={color} sparkData={histories?.humidity}    /><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi}  unit="dBm" color={color} sparkData={histories?.wifi_rssi} /><MetricRow label="433 Alerts"  value={m.alerts_433}  unit=""  color={color} /></>);
      case "medical": {
        // no_finger = nobody is touching the sensor: its heart rate (30) is a placeholder, not a reading
        const noContact = typeof m.sensor_status === "string" && /no[_ ]?(finger|contact)/i.test(m.sensor_status);
        return (<><MetricRow label="Heart Rate"  value={noContact ? "no contact" : m.heart_rate} unit={noContact ? "" : "bpm"} color={color} sparkData={noContact ? null : histories?.heart_rate}  /><MetricRow label="SpO2"       value={noContact ? "no contact" : m.spo2}        unit={noContact ? "" : "%"} color={color} sparkData={noContact ? null : histories?.spo2}        /><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi}  unit="dBm" color={color} sparkData={histories?.wifi_rssi} /></>);
      }
      case "automation":   return (<><div style={{ padding:"8px 0" }}><span style={{ fontSize:12, color:"var(--color-text-secondary)" }}>Smart Plug — </span><span style={{ fontSize:13, fontWeight:500, color: m.plug_state==="on"?"#1D9E75":m.plug_state==="off"?"#E24B4A":"#888" }}>{m.plug_state ?? "—"}</span></div><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} /></>);
      case "traffic":      return (<><div style={{ padding:"8px 0", borderBottom:"0.5px solid var(--color-border-tertiary)" }}><TrafficLight state={m.light_state} /></div><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} /></>);
      case "security":     return (<><MetricRow label="Motion"      value={m.motion_detected ? "DETECTED" : "clear"} unit="" color={color} /><MetricRow label="Door"        value={m.door_open       ? "OPEN"     : "closed"} unit="" color={color} /><MetricRow label="433 Signal"  value={m.signal_433}  unit="dBm" color={color} sparkData={histories?.signal_433} /></>);
      case "gps":          return <GPSPanel metrics={m} />;
      case "drone":        return null;
      default: {
        // A sensor the dashboard has no special layout for (e.g. one you just added): show every metric it sends.
        const keys = Object.keys(m).filter(k => !k.startsWith("_") && (typeof m[k] === "number" || typeof m[k] === "string"));
        if (!keys.length) return <div style={{ fontSize:12, color:"var(--color-text-tertiary)", padding:"8px 0" }}>Waiting for data…</div>;
        return (<>{keys.sort().map(k => (
          <MetricRow key={k} label={k.replace(/_/g, " ")} value={m[k]} unit={GENERIC_UNITS[k] || ""} color={color}
            sparkData={typeof m[k] === "number" ? histories?.[k] : null} />
        ))}</>);
      }
    }
  };

  // Offline: the whole card turns grey (colors, sparklines, icons), so a silent node is obvious from across a room.
  // It keeps its last values, dimmed, with when they were measured.
  const isOffline = status !== "online";
  const lastSeenText = isOffline && state?.lastSeen
    ? `last data ${new Date(state.lastSeen).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" })}` : null;
  return (
    <div className={interference && !isOffline ? "if-card" : undefined}
      style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
      borderRadius:12, padding:"14px 16px", display:"flex", flexDirection:"column", gap:4,
      borderTop:`2px solid ${isOffline ? "#888780" : interference ? INTERFERENCE_RED : color}`,
      filter: isOffline ? "grayscale(1)" : "none", opacity: isOffline ? 0.5 : 1,
      transition:"filter 0.4s ease, opacity 0.4s ease" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:16, color, lineHeight:1 }}>{NODE_ICONS[def.type]}</span>
          <span style={{ fontSize:13, fontWeight:500 }}>{def.label}</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <StatusDot status={status} />
          <span style={{ fontSize:11, color:"var(--color-text-secondary)", textTransform:"uppercase", letterSpacing:"0.05em" }}>{status}</span>
        </div>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4, flexWrap:"wrap", gap:4 }}>
        <span style={{ fontSize:11, color:"var(--color-text-tertiary)", textTransform:"uppercase", letterSpacing:"0.06em" }}>{def.type}</span>
        <div style={{ display:"flex", gap:4, alignItems:"center" }}>
          {lastSeenText && <span style={{ fontSize:10, color:"var(--color-text-tertiary)" }}>{lastSeenText}</span>}
          {interference && !isOffline &&
            <span style={{ fontSize:10, fontWeight:500, color:INTERFERENCE_RED, letterSpacing:"0.04em" }}>
              INTERFERENCE
            </span>}
          {loss !== undefined && loss > 0 &&
            <span style={{ fontSize:10, color: loss > 50 ? "#E24B4A" : "#BA7517", fontWeight:500 }}>
              PKT {loss}%
            </span>}
          {!interference && verdictOf(rf, state?.status) === "degraded" &&
            <span style={{ fontSize:10, fontWeight:500, color:VERDICT_COLOR.degraded, letterSpacing:"0.04em" }}>RF DEGRADED</span>}
        </div>
      </div>
      {renderMetrics()}
      {/* RF summary: the same verdict and recent window the RF Analysis tab shows */}
      {isRfProblem(verdictOf(rf, state?.status)) && (
        <div style={{ marginTop:6, paddingTop:6, borderTop:"0.5px dashed var(--color-border-tertiary)",
          display:"flex", gap:10, flexWrap:"wrap", fontSize:10, color:"var(--color-text-tertiary)" }}>
          {rf.signal && <span>Signal: <strong style={{ color: rf.signal.value < rf.signal.threshold ? "#E24B4A" : "var(--color-text-secondary)" }}>{rf.signal.value} {rf.signal.unit}</strong></span>}
          {(rf.recentGaps || 0) > 0 && <span>Gaps (last 20): <strong style={{ color:"var(--color-text-secondary)" }}>{rf.recentGaps}</strong></span>}
          {(rf.recentBulks || 0) > 0 && <span>Bursts (last 20): <strong style={{ color:"var(--color-text-secondary)" }}>{rf.recentBulks}</strong></span>}
        </div>
      )}
    </div>
  );
}

// ─── Interference + live-event highlighting ──────────────────────────────────
const isInterferenceEvent = e => e?.type === "interference" && e?.severity !== "info"; // "info" = resolved
const INTERFERENCE_RED = "#E24B4A";
const DASHBOARD_CSS = `
@keyframes ifPageGlow {
  0%, 100% { box-shadow: inset 0 0 0 3px rgba(226,75,74,0.85), inset 0 0 70px rgba(226,75,74,0.28); }
  50%      { box-shadow: inset 0 0 0 3px rgba(226,75,74,0.6), inset 0 0 40px rgba(226,75,74,0.16); }
}
@keyframes ifCardGlow {
  0%, 100% { box-shadow: 0 0 0 1.5px rgba(226,75,74,0.95), 0 0 22px rgba(226,75,74,0.40); }
  50%      { box-shadow: 0 0 0 1.5px rgba(226,75,74,0.45), 0 0 8px  rgba(226,75,74,0.15); }
}
@keyframes ifBadge { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
@keyframes evtNew     { from { background: rgba(55,138,221,0.22); } to { background: transparent; } }
@keyframes evtNewCrit { from { background: rgba(226,75,74,0.30); }  to { background: rgba(226,75,74,0.03); } }
.if-page  { position: fixed; inset: 0; pointer-events: none; z-index: 50; animation: ifPageGlow 1.6s ease-in-out infinite; }
.if-card  { animation: ifCardGlow 1.6s ease-in-out infinite; }
.if-badge { animation: ifBadge 1.6s ease-in-out infinite; }
.evt-new      { animation: evtNew 3.5s ease-out forwards; }
.evt-new-crit { animation: evtNewCrit 4s ease-out forwards; box-shadow: inset 3px 0 0 ${INTERFERENCE_RED}; }
@media (prefers-reduced-motion: reduce) {
  .if-page  { animation: none; box-shadow: inset 0 0 0 3px rgba(226,75,74,0.85); }
  .if-card  { animation: none; box-shadow: 0 0 0 1.5px rgba(226,75,74,0.95); }
  .if-badge, .evt-new, .evt-new-crit { animation: none; }
}`;

// ─── Audience nodes (ThunderPlains phones) ───────────────────────────────────
// Phones arrive as aud-<word>-<n> (relay) or phoneN (phone.html). The bridge's
// own status nodes are audience-*. None of them belong in the sensor grid.
const AUDIENCE_COLOR = "#D4537E";
const isAudiencePhoneNode = id => typeof id === "string" && (id.startsWith("aud-") || /^phone\d+$/.test(id));
const isAudienceInfraNode = id => typeof id === "string" && id.startsWith("audience-");
const isAudienceAny = (id, def) => isAudiencePhoneNode(id) || isAudienceInfraNode(id) || def?.type === "phone";
const NAMED_TILE_LIMIT = 24; // above this many phones, switch to a compact swarm grid

const AUDIENCE_CSS = `
@keyframes audPing {
  0%   { transform: scale(1.12); box-shadow: 0 0 0 0 rgba(212,83,126,0.75); }
  100% { transform: scale(1);    box-shadow: 0 0 0 12px rgba(212,83,126,0); }
}
.aud-ping { animation: audPing 700ms ease-out; }
@media (prefers-reduced-motion: reduce) {
  .aud-ping { animation: none; outline: 2px solid ${AUDIENCE_COLOR}; outline-offset: 2px; }
}`;

// Storm icons for audience phones (same drawings as the phone page, relay/public/storms.js).
// Static strings, never user input, so rendering them as markup is safe.
const STORM_ICONS = {
  supercell: "<path d=\"M8 24 Q10 12 22 13 Q30 4 42 11 Q55 11 56 24 Z\" fill=\"currentColor\"/><path d=\"M18 34 A14 5 0 1 0 46 34\" /><path d=\"M46 34 A14 5 0 0 0 26 30\"/><path d=\"M26 30 l5 -3 m-5 3 l4 4\"/><path d=\"M29 40 L32 54 L35 40\"/>",
  mesocyclone: "<path d=\"M34 32 a2.5 2.5 0 1 1 -3 -2.5 a6.5 6.5 0 1 1 -4.5 9.5 a11 11 0 1 1 15.5 -14 a17 17 0 1 1 -27 1\"/><path d=\"M15 24.5 l-1.5 -7 m1.5 7 l7 -1\"/>",
  derecho: "<path d=\"M8 18 H40 a5 5 0 1 0 -5 -5\"/><path d=\"M8 32 H50 a6 6 0 1 1 -6 6\"/><path d=\"M8 46 H34 a5 5 0 1 1 -5 5\"/>",
  dryline: "<circle cx=\"17\" cy=\"24\" r=\"6\"/><path d=\"M17 11 v3 M17 34 v3 M6 24 h-2 M30 24 h-2 M9 16 l-2 -2 M25 16 l2 -2 M9 32 l-2 2 M25 32 l2 2\"/><path d=\"M32 8 V56\" stroke-dasharray=\"4 5\"/><path d=\"M48 16 C44 23 41 27 41 31 a7 7 0 0 0 14 0 C55 27 52 23 48 16 Z\"/><path d=\"M45 45 h6 M43 51 h10\"/>",
  anvil: "<path d=\"M8 16 H56 L44 24 Q36 26 37 34 L40 50 H24 L27 34 Q28 26 20 24 Z\"/><path d=\"M14 56 H50\"/>",
  updraft: "<path d=\"M18 30 H47 A8.5 8.5 0 0 0 48.5 13.2 A12.5 12.5 0 0 0 25 10.5 A10 10 0 0 0 18 30 Z\"/><path d=\"M22 54 V38 m-5 5 l5 -5 l5 5\"/><path d=\"M42 54 V38 m-5 5 l5 -5 l5 5\"/>",
  downdraft: "<path d=\"M18 30 H47 A8.5 8.5 0 0 0 48.5 13.2 A12.5 12.5 0 0 0 25 10.5 A10 10 0 0 0 18 30 Z\"/><path d=\"M22 36 V52 m-5 -5 l5 5 l5 -5\"/><path d=\"M42 36 V52 m-5 -5 l5 5 l5 -5\"/>",
  wallcloud: "<path d=\"M8 26 Q12 14 24 15 Q32 6 42 13 Q54 12 56 26 Z\"/><path d=\"M24 26 V38 H40 V26\" fill=\"currentColor\"/><path d=\"M8 50 H56\"/>",
  shelfcloud: "<path d=\"M6 30 L50 14 Q58 16 58 24 L58 32 Q40 30 14 38 Z\" fill=\"currentColor\"/><path d=\"M14 38 L58 32\"/><path d=\"M6 50 H58\"/><path d=\"M12 44 h8 M28 44 h8\"/>",
  gustfront: "<path d=\"M8 22 H36 a6 6 0 1 0 -6 -6\"/><path d=\"M8 34 H48\"/><path d=\"M8 46 H40 a6 6 0 1 1 -6 6\"/><path d=\"M54 30 l4 4 l-4 4\"/>",
  outflow: "<path d=\"M18 30 H47 A8.5 8.5 0 0 0 48.5 13.2 A12.5 12.5 0 0 0 25 10.5 A10 10 0 0 0 18 30 Z\"/><path d=\"M32 34 V44\"/><path d=\"M8 50 H56\"/><path d=\"M29 44 H12 m5 -5 l-5 5 l5 5\"/><path d=\"M35 44 H52 m-5 -5 l5 5 l-5 5\"/>",
  mammatus: "<path d=\"M6 18 H58\"/><path d=\"M8 18 a6 7 0 0 0 12 0 a6 7 0 0 0 12 0 a6 7 0 0 0 12 0 a6 7 0 0 0 12 0\"/><path d=\"M14 32 a6 7 0 0 0 12 0 a6 7 0 0 0 12 0 a6 7 0 0 0 12 0\" /><path d=\"M14 32 H50\"/>",
  hailstone: "<path d=\"M18 30 H47 A8.5 8.5 0 0 0 48.5 13.2 A12.5 12.5 0 0 0 25 10.5 A10 10 0 0 0 18 30 Z\"/><circle cx=\"20\" cy=\"42\" r=\"4\" fill=\"currentColor\"/><circle cx=\"33\" cy=\"50\" r=\"5\" fill=\"currentColor\"/><circle cx=\"45\" cy=\"41\" r=\"3.5\" fill=\"currentColor\"/>",
  squall: "<path d=\"M18 30 H47 A8.5 8.5 0 0 0 48.5 13.2 A12.5 12.5 0 0 0 25 10.5 A10 10 0 0 0 18 30 Z\"/><path d=\"M22 36 l-6 12 M32 36 l-6 12 M42 36 l-6 12 M27 50 l-3 6 M37 50 l-3 6\"/>",
  cumulus: "<path d=\"M10 48 H52 A9 9 0 0 0 52 30 A13 13 0 0 0 30 22 A11 11 0 0 0 12 32 A8 8 0 0 0 10 48 Z\"/><path d=\"M24 36 a6 6 0 0 1 8 -4\"/>",
  bolt: "<path d=\"M36 6 L16 36 H30 L26 58 L48 26 H34 Z\" fill=\"currentColor\"/>",
  thunder: "<path d=\"M18 30 H47 A8.5 8.5 0 0 0 48.5 13.2 A12.5 12.5 0 0 0 25 10.5 A10 10 0 0 0 18 30 Z\"/><path d=\"M33 34 L26 46 H33 L29 56 L40 42 H33 L37 34 Z\" fill=\"currentColor\"/><path d=\"M48 40 a8 8 0 0 1 0 10 M53 36 a14 14 0 0 1 0 18 M16 40 a8 8 0 0 0 0 10 M11 36 a14 14 0 0 0 0 18\"/>",
  stormcell: "<path d=\"M18 30 H47 A8.5 8.5 0 0 0 48.5 13.2 A12.5 12.5 0 0 0 25 10.5 A10 10 0 0 0 18 30 Z\" fill=\"currentColor\"/><path d=\"M20 36 v6 M28 40 v6 M36 36 v6 M44 40 v6 M24 48 v6 M32 50 v6 M40 48 v6\"/>",
};

function StormIcon({ word, size = 22, color }) {
  const svg = STORM_ICONS[word];
  if (!svg) return null;
  return (
    <span aria-hidden="true" style={{ width:size, height:size, flexShrink:0, color, display:"inline-flex" }}
      dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>` }} />
  );
}

const PhoneTile = memo(function PhoneTile({ id, state, pings, compact }) {
  const m        = state?.metrics || {};
  const online   = state?.status === "online";
  const activity = typeof m.activity === "number" ? Math.max(0, Math.min(1, m.activity)) : 0;
  const label    = id.startsWith("aud-") ? id.slice(4) : id;
  const [flash, setFlash] = useState(false);

  // A tap on the phone arrives as metrics.pings > 0 on that second's update.
  useEffect(() => {
    if (!(m.pings > 0)) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 700);
    return () => clearTimeout(t);
  }, [state?.lastSeen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (compact) {
    return (
      <div title={`${label} · ${online ? "live" : "silent"} · ${pings} ping${pings === 1 ? "" : "s"}`}
        className={flash ? "aud-ping" : undefined}
        style={{ width:20, height:20, borderRadius:5,
          background: online ? AUDIENCE_COLOR : "var(--color-border-secondary)",
          opacity: online ? 0.3 + activity * 0.7 : 0.45, transition:"opacity 300ms ease-out" }} />
    );
  }

  return (
    <div className={flash ? "aud-ping" : undefined}
      style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
        borderLeft:`2px solid ${online ? AUDIENCE_COLOR : "var(--color-border-secondary)"}`,
        borderRadius:10, padding:"8px 10px", opacity: online ? 1 : 0.55, transition:"opacity 300ms ease-out" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:6, marginBottom:6 }}>
        <span style={{ display:"flex", alignItems:"center", gap:6, minWidth:0 }}>
          <StormIcon word={label.split("-")[0]} color={online ? AUDIENCE_COLOR : "var(--color-text-tertiary)"} />
          <span style={{ fontSize:12, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{label}</span>
        </span>
        <StatusDot status={online ? "online" : "offline"} />
      </div>
      <div style={{ height:6, borderRadius:3, background:"var(--color-background-secondary)", overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${Math.round(activity * 100)}%`, background:AUDIENCE_COLOR,
          transition:"width 300ms ease-out" }} />
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", marginTop:5, fontSize:10, color:"var(--color-text-tertiary)" }}>
        <span>activity {Math.round(activity * 100)}%</span>
        <span style={{ color: flash ? AUDIENCE_COLOR : undefined, fontWeight: flash ? 500 : 400 }}>
          {flash ? "ping!" : `${pings} ping${pings === 1 ? "" : "s"}`}
        </span>
      </div>
    </div>
  );
});

function AudiencePanel({ phoneIds, nodes, pingCounts, pingTotal }) {
  const live      = phoneIds.filter(id => nodes[id]?.status === "online").length;
  const bridgeUp  = nodes["audience-bridge"]?.status === "online";
  const rejected  = nodes["audience-rejected"]?.metrics?.count;
  const compact   = phoneIds.length > NAMED_TILE_LIMIT;
  const stat = (label, value, color) => (
    <div style={{ display:"flex", alignItems:"baseline", gap:5, padding:"4px 10px",
      background:"var(--color-background-secondary)", borderRadius:20, fontSize:11 }}>
      <span style={{ color:"var(--color-text-tertiary)" }}>{label}</span>
      <span style={{ fontWeight:500, color: color || "var(--color-text-primary)" }}>{value}</span>
    </div>
  );

  return (
    <div style={{ marginBottom:18 }}>
      <style>{AUDIENCE_CSS}</style>
      <SectionHeader title="Audience nodes"
        subtitle={`${live} live · ${phoneIds.length} joined`}
        right={
          <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
            {stat("Pings", pingTotal, AUDIENCE_COLOR)}
            {rejected != null && stat("Rejected", rejected, rejected > 0 ? "#BA7517" : undefined)}
            <div style={{ display:"flex", alignItems:"center", padding:"4px 10px",
              background:"var(--color-background-secondary)", borderRadius:20, fontSize:11 }}>
              <StatusDot status={bridgeUp ? "online" : "offline"} />
              <span style={{ color:"var(--color-text-secondary)" }}>Bridge {bridgeUp ? "online" : "offline"}</span>
            </div>
          </div>
        } />
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
        borderTop:`2px solid ${AUDIENCE_COLOR}`, borderRadius:12, padding:"14px 16px",
        display:"flex", gap:18, alignItems:"flex-start" }}>
        <div style={{ flexShrink:0, minWidth:90 }}>
          <div style={{ fontSize:40, fontWeight:500, lineHeight:1, color:AUDIENCE_COLOR }}>{live}</div>
          <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:4 }}>phones live</div>
        </div>
        {phoneIds.length === 0 ? (
          <div style={{ fontSize:12, color:"var(--color-text-tertiary)", alignSelf:"center" }}>
            Waiting for the first phone to join.
          </div>
        ) : compact ? (
          <div style={{ display:"flex", flexWrap:"wrap", gap:5, flex:1, minWidth:0 }}>
            {phoneIds.map(id => <PhoneTile key={id} id={id} state={nodes[id]} pings={pingCounts[id] || 0} compact />)}
          </div>
        ) : (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(172px,1fr))", gap:8, flex:1, minWidth:0 }}>
            {phoneIds.map(id => <PhoneTile key={id} id={id} state={nodes[id]} pings={pingCounts[id] || 0} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Stage tab: presenter controls ───────────────────────────────────────────
// Every button is an event: the backend handles interference/reset itself and puts
// audience/replay commands on the bus (stage/command) for the bridge and stage agent.
function ConfirmButton({ label, confirmLabel = "Click again to confirm", onConfirm, disabled, tone = "danger" }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <StageButton tone={armed ? tone : "neutral"} disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel : label}
    </StageButton>
  );
}

function StageButton({ children, onClick, disabled, tone = "neutral", title }) {
  const tones = {
    primary: { bg: "#378ADD", fg: "#ffffff", border: "#378ADD" },
    danger:  { bg: "#E24B4A", fg: "#ffffff", border: "#E24B4A" },
    good:    { bg: "#1D9E75", fg: "#ffffff", border: "#1D9E75" },
    neutral: { bg: "var(--color-background-secondary)", fg: "var(--color-text-primary)", border: "var(--color-border-secondary)" },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{ fontFamily:"inherit", fontSize:13, fontWeight:500, padding:"10px 14px", borderRadius:8,
        border:`1px solid ${t.border}`, background:t.bg, color:t.fg, cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1, minWidth:120 }}>
      {children}
    </button>
  );
}

function StageCard({ step, title, children, status }) {
  return (
    <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
      borderRadius:12, padding:"14px 16px", display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", gap:8 }}>
        <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
          <span style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>{step}</span>
          <span style={{ fontSize:14, fontWeight:500 }}>{title}</span>
        </div>
        {status}
      </div>
      {children}
    </div>
  );
}

function StagePill({ on, onText, offText, warn }) {
  const color = on ? (warn ? "#E24B4A" : "#1D9E75") : "var(--color-text-tertiary)";
  return (
    <span style={{ fontSize:11, padding:"3px 9px", borderRadius:20, border:`1px solid ${color}`, color, whiteSpace:"nowrap" }}>
      {on ? onText : offText}
    </span>
  );
}

const stageRow = (label, value, color) => (
  <div style={{ display:"flex", justifyContent:"space-between", fontSize:12 }}>
    <span style={{ color:"var(--color-text-tertiary)" }}>{label}</span>
    <span style={{ fontWeight:500, color: color || "var(--color-text-primary)" }}>{value}</span>
  </div>
);

let lastStageSpeed = 2; // survives the panel unmounting when you switch tabs
// Turns the bridge's last relay connection error into a plain-language fix.
function RelayProblem({ error, url }) {
  const e = String(error || "").toLowerCase();
  const fix =
    !error                         ? "Waiting for the bridge to try the relay..." :
    e.includes("unauthorized")     ? "Stage token mismatch: stageToken in stage.config.json must equal STAGE_TOKEN in Render." :
    e.includes("invalid namespace") ? "That URL isn't the relay. Use only the base address, e.g. https://your-name.onrender.com" :
    e.includes("your-name")        ? "relayUrl still has the placeholder in stage.config.json." :
                                     "Can't reach the relay. Check the URL, open /healthz in a browser (free tier can take ~1 min to wake), or try another network.";
  return (
    <div style={{ fontSize:11, lineHeight:1.5, padding:"8px 10px", borderRadius:8,
      background:"rgba(226,75,74,0.08)", border:"0.5px solid rgba(226,75,74,0.5)", color:"var(--color-text-secondary)" }}>
      <div style={{ color:"#E24B4A", fontWeight:500 }}>{fix}</div>
      {error && <div>Bridge says: {error}</div>}
      {url && <div style={{ wordBreak:"break-all" }}>Relay URL: {url}</div>}
    </div>
  );
}

function StagePanel({ status, onCommand, phonesLive }) {
  const [speedChoice, setSpeedChoice] = useState(lastStageSpeed);
  const setSpeed = (v) => { lastStageSpeed = v; setSpeedChoice(v); };
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState(null);
  const [showQr, setShowQr] = useState(false);
  const aud = status?.audience;
  const qrSrc = aud?.relayUrl ? `${aud.relayUrl.replace(/\/$/, "")}/qr.svg` : null;
  const joinUrl = aud?.joinUrl || aud?.relayUrl;
  useEffect(() => {
    if (!showQr) return;
    const onKey = (e) => { if (e.key === "Escape") setShowQr(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showQr]);
  const rep = status?.replay;
  const inter = status?.interference || {};
  const replayRunning = rep?.online && ["starting", "running", "finishing"].includes(rep?.state);
  const speed = replayRunning && rep?.speed ? rep.speed : speedChoice; // show the speed actually running

  useEffect(() => {
    if (!replayRunning) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [replayRunning]);

  const send = (target, action, args, jumpTo) => {
    onCommand({ target, action, args }, jumpTo, (res) => {
      setNotice(res?.ok ? null : `${target} ${action}: ${res?.error || "no response from backend"}`);
    });
  };

  const bridgeUp = !!aud?.online;
  const agentUp = !!rep?.online;
  const elapsed = rep?.startedAt ? Math.max(0, (now - rep.startedAt) / 1000) : 0;
  const total = rep?.durationS || 0;
  const pct = total ? Math.min(100, (elapsed / total) * 100) : 0;
  const attackPct = total && rep?.attackAtS != null ? (rep.attackAtS / total) * 100 : null;
  const toAttack = rep?.attackAtS != null ? rep.attackAtS - elapsed : null;
  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

  return (
    <div>
      <SectionHeader title="Stage controls" subtitle="Run each demo from here. Main buttons jump to the tab that shows it." />
      {notice && (
        <div style={{ marginBottom:12, padding:"8px 12px", borderRadius:8, fontSize:12,
          border:"1px solid #E24B4A", color:"#E24B4A", background:"rgba(226,75,74,0.08)" }}>{notice}</div>
      )}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))", gap:14 }}>

        <StageCard step="1" title="Interference"
          status={<StagePill on={inter.wifi || inter.gps} onText="Active" offText="Off" warn />}>
          {(status?.interferenceMode === "threshold"
            ? [["wifi", "Wi-Fi interference", "Raises the Wi-Fi alert threshold to -50 dBm"],
               ["gps",  "GPS interference",   "Raises the GPS L1 alert threshold to 50 dB-Hz"]]
            : [["wifi", "2.4 GHz interference", "Simulated: weak, unstable signal and lost readings on every 2.4 GHz device"],
               ["gps",  "GPS interference",     "Simulated: GPS signal quality collapses, satellites and lock are lost"]]
          ).map(([kind, name, hint]) => (
            <div key={kind} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
              <div>
                <div style={{ fontSize:13 }}>{name}</div>
                <div style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>{hint}</div>
              </div>
              {inter[kind]
                ? <StageButton tone="good" onClick={() => send("interference", "off", { kind })}>Clear</StageButton>
                : <StageButton tone="danger" onClick={() => send("interference", "on", { kind }, kind === "gps" ? "gps" : "overview")}>Trigger</StageButton>}
            </div>
          ))}
        </StageCard>

        <StageCard step="2" title="Watchdog" status={<StagePill on={false} offText="Hands-on" />}>
          <div style={{ fontSize:12, color:"var(--color-text-secondary)", lineHeight:1.5 }}>
            Unplug a real sensor, or stop <code>npm run sensor</code> with Ctrl+C. Its card goes offline and a
            critical watchdog event appears after the watchdog timeout. No button on purpose: the cable is the demo.
          </div>
        </StageCard>

        <StageCard step="3" title="Audience phones"
          status={<StagePill on={bridgeUp && aud?.joinOpen} onText="Joining open" offText={bridgeUp ? "Joining closed" : "Bridge offline"} />}>
          {stageRow("Bridge", bridgeUp ? "online" : "offline", bridgeUp ? "#1D9E75" : "#E24B4A")}
          {stageRow("Relay", aud?.relay ? "connected" : "not connected", aud?.relay ? "#1D9E75" : "#E24B4A")}
          {bridgeUp && !aud?.relay && <RelayProblem error={aud?.relayError} url={aud?.relayUrl} />}
          {stageRow("Phones live", phonesLive)}
          {stageRow("Rejected messages", aud?.rejected ?? 0, (aud?.rejected || 0) > 0 ? "#BA7517" : undefined)}
          {bridgeUp && aud?.relay && qrSrc && (
            <div style={{ display:"flex", gap:12, alignItems:"center" }}>
              <img src={qrSrc} alt="QR code phones scan to join" width={92} height={92}
                style={{ background:"#fff", borderRadius:6, padding:2, flexShrink:0 }} />
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>Phones join at</div>
                <div style={{ fontSize:12, wordBreak:"break-all", marginBottom:6 }}>{joinUrl}</div>
                <StageButton onClick={() => setShowQr(true)}>Show QR full screen</StageButton>
              </div>
            </div>
          )}
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <StageButton tone="primary" disabled={!bridgeUp || !aud?.relay || aud?.joinOpen}
              onClick={() => send("audience", "open", undefined, "overview")}>Open joining</StageButton>
            <StageButton disabled={!bridgeUp || !aud?.joinOpen} onClick={() => send("audience", "close")}>Close joining</StageButton>
            <ConfirmButton label="Disconnect all phones" disabled={!bridgeUp} onConfirm={() => send("audience", "end")} />
          </div>
          {showQr && qrSrc && (
            <div onClick={() => setShowQr(false)} title="Click or press Esc to close"
              style={{ position:"fixed", inset:0, zIndex:1000, background:"rgba(8,10,14,0.96)", cursor:"pointer",
                display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:22 }}>
              <div style={{ fontSize:28, letterSpacing:"0.02em" }}>Scan to become a sensor node</div>
              <img src={qrSrc} alt="QR code phones scan to join"
                style={{ width:"min(62vh, 80vw)", height:"min(62vh, 80vw)", background:"#fff", borderRadius:14, padding:10 }} />
              <div style={{ fontSize:20, color:"var(--color-text-secondary)" }}>{joinUrl}</div>
              <div style={{ fontSize:18, color:AUDIENCE_COLOR }}>{phonesLive} phone{phonesLive === 1 ? "" : "s"} live
                {!aud?.joinOpen && <span style={{ color:"var(--color-text-tertiary)" }}> · joining is closed</span>}</div>
            </div>
          )}
        </StageCard>

        <StageCard step="4" title="Drone attack replay"
          status={<StagePill on={replayRunning} onText={rep?.state === "starting" ? "Starting" : "Running"} offText={agentUp ? "Ready" : "Agent offline"} />}>
          {replayRunning && total > 0 ? (
            <div>
              <div style={{ position:"relative", height:10, borderRadius:5, background:"var(--color-background-secondary)", overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${pct}%`, background:"#00CFFF", transition:"width 0.5s linear" }} />
              </div>
              {attackPct != null && (
                <div style={{ position:"relative", height:0 }}>
                  <div style={{ position:"absolute", left:`calc(${attackPct}% - 1px)`, top:-10, width:2, height:10, background:"#E24B4A" }} />
                </div>
              )}
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginTop:6, color:"var(--color-text-tertiary)" }}>
                <span>{fmt(elapsed)} / {fmt(total)}</span>
                {toAttack != null && (toAttack > 0
                  ? <span style={{ color: toAttack < 6 ? "#E24B4A" : undefined, fontWeight: toAttack < 6 ? 500 : 400 }}>attack in {Math.ceil(toAttack)}s</span>
                  : <span style={{ color:"#E24B4A" }}>attack underway</span>)}
              </div>
            </div>
          ) : (
            <div style={{ fontSize:12, color:"var(--color-text-secondary)", lineHeight:1.5 }}>
              Replays the recorded hijack of cf-e9 through MQTT, like a live flight.
              {rep?.lastResult && <span style={{ color:"var(--color-text-tertiary)" }}> Last run: {rep.lastResult}.</span>}
            </div>
          )}
          <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
            <div style={{ display:"flex", border:"0.5px solid var(--color-border-secondary)", borderRadius:8, overflow:"hidden" }}>
              {[1, 2, 4].map(v => (
                <button key={v} onClick={() => setSpeed(v)} disabled={replayRunning}
                  style={{ fontFamily:"inherit", fontSize:12, padding:"9px 11px", border:"none", cursor:"pointer",
                    background: speed === v ? "var(--color-text-primary)" : "var(--color-background-secondary)",
                    color: speed === v ? "var(--color-background-primary)" : "var(--color-text-secondary)" }}>{v}x</button>
              ))}
            </div>
            {replayRunning
              ? <StageButton onClick={() => send("replay", "stop")}>Stop replay</StageButton>
              : <StageButton tone="primary" disabled={!agentUp} onClick={() => send("replay", "start", { speed }, "drone")}>Start replay</StageButton>}
          </div>
        </StageCard>

        <StageCard step="↺" title="Reset between runs">
          <div style={{ fontSize:12, color:"var(--color-text-secondary)", lineHeight:1.5 }}>
            Clears the live event list, drone trails and missions, ping counts, and ends any interference.
            Everything stays in the database.
          </div>
          <div><ConfirmButton label="Reset dashboard" onConfirm={() => send("dashboard", "reset", undefined, "overview")} /></div>
        </StageCard>
      </div>
    </div>
  );
}

// ─── ApiRow ──────────────────────────────────────────────────────────────────
function ApiRow({ label, path, compact }) {
  const base = BACKEND_URL;
  const url  = base + path;
  return (
    <div onClick={() => window.open(url, "_blank")} style={{
      display:"flex", alignItems:"center", justifyContent:"space-between",
      padding: compact ? "3px 0" : "7px 0",
      borderBottom: compact ? "none" : "0.5px solid var(--color-border-tertiary)",
      cursor:"pointer", gap:8,
    }}
    onMouseEnter={e => e.currentTarget.style.opacity="0.7"}
    onMouseLeave={e => e.currentTarget.style.opacity="1"}>
      <span style={{ fontSize: compact ? 11 : 12, color:"var(--color-text-secondary)" }}>{label}</span>
      <code style={{ fontSize:10, color:"var(--color-text-tertiary)",
        background:"var(--color-background-secondary)", padding:"2px 6px",
        borderRadius:4, fontFamily:"'DM Mono','Fira Code',monospace",
        whiteSpace:"nowrap", flexShrink:0 }}>
        {path.length > 50 ? path.slice(0, 47) + "…" : path}
      </code>
    </div>
  );
}

// ─── EventFeed ───────────────────────────────────────────────────────────────
// ─── Timestamp utilities ─────────────────────────────────────────────────────
function parseEventTime(ts) {
  if (!ts) return new Date();
  const s = String(ts);
  if (!s.endsWith("Z") && !s.includes("+") && !s.match(/[+-]\d{2}:\d{2}$/)) {
    return new Date(s + "Z");
  }
  return new Date(s);
}
function formatEventTime(ts) { return parseEventTime(ts).toLocaleTimeString(); }
function eventAgeMs(ts) { return Date.now() - parseEventTime(ts).getTime(); }
function getDataState(lastSeen, watchdogTimeoutSec = 15) {
  if (!lastSeen) return "absent";
  const ageMs = Date.now() - parseEventTime(lastSeen).getTime();
  if (ageMs < watchdogTimeoutSec * 1000) return "live";
  return "stale";
}
function formatAge(lastSeen) {
  if (!lastSeen) return null;
  const ageMs = Date.now() - parseEventTime(lastSeen).getTime();
  if (ageMs < 60000)   return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m ago`;
  return `${Math.floor(ageMs / 3600000)}h ago`;
}

// ─── EventFeed — deduplicated stream with filter tabs ─────────────────────────
function EventFeed({ events, nodes, config }) {
  const [filter, setFilter]             = useState("all");
  const [showHistorical, setShowHistorical] = useState(false);
  const watchdog = config?.watchdogTimeout || 15;

  const tagged = events.map(e => {
    const age       = eventAgeMs(e.timestamp);
    const nodeState = e.node_id ? nodes?.[e.node_id] : null;
    const nodeDs    = nodeState ? getDataState(nodeState.lastSeen, watchdog) : "absent";
    const nodeOnline = nodeDs === "live";
    const isHistorical = !nodeOnline && age > 30000 &&
      ["interference","anomaly","rf_disruption","medical","watchdog"].includes(e.type);
    return { ...e, age, nodeOnline, isHistorical };
  });

  const dedupMap = new Map();
  tagged.filter(e => !e.isHistorical).forEach(e => {
    const key = `${e.type}:${e.node_id}:${e.message}`;
    const existing = dedupMap.get(key);
    if (!existing) {
      dedupMap.set(key, { ...e, count: 1 });
    } else {
      if (parseEventTime(e.timestamp) > parseEventTime(existing.timestamp)) {
        dedupMap.set(key, { ...e, count: existing.count + 1 });
      } else {
        existing.count += 1;
      }
    }
  });

  let stream = [...dedupMap.values()]
    .sort((a, b) => parseEventTime(b.timestamp) - parseEventTime(a.timestamp));

  const filtered = filter === "all" ? stream : stream.filter(e => e.severity === filter);
  const historical = tagged.filter(e => e.isHistorical);
  const counts = {
    critical: stream.filter(e => e.severity === "critical").length,
    warning:  stream.filter(e => e.severity === "warning").length,
    info:     stream.filter(e => e.severity === "info").length,
  };

  const EventRow = ({ e }) => (
    <div style={{ display:"flex", gap:10, padding:"8px 12px", alignItems:"flex-start",
      borderBottom:"0.5px solid var(--color-border-tertiary)" }}>
      <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0, marginTop:5,
        background: SEVERITY_COLOR[e.severity] || "#888" }} />
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:12, lineHeight:1.4 }}>{e.message}</div>
        <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:2, display:"flex", gap:6 }}>
          {e.node_id && (
            <span style={{ color: NODE_COLORS[nodes?.[e.node_id]?.type] || "#888" }}>{e.node_id}</span>
          )}
          <span>{formatEventTime(e.timestamp)}</span>
        </div>
      </div>
      <div style={{ display:"flex", gap:4, alignItems:"center", flexShrink:0 }}>
        {e.count > 1 && (
          <span style={{ fontSize:10, color:"var(--color-text-tertiary)",
            background:"var(--color-background-secondary)", borderRadius:20,
            padding:"1px 7px", fontWeight:500 }}>×{e.count}</span>
        )}
        <Badge text={e.severity} severity={e.severity} />
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display:"flex", borderBottom:"0.5px solid var(--color-border-tertiary)", padding:"0 12px" }}>
        {["all","critical","warning","info"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            background:"none", border:"none",
            borderBottom: filter===f ? `2px solid ${f==="all" ? "var(--color-text-primary)" : SEVERITY_COLOR[f]}` : "2px solid transparent",
            padding:"7px 12px", fontSize:11, cursor:"pointer", fontFamily:"inherit",
            fontWeight: filter===f ? 500 : 400, textTransform:"capitalize",
            color: filter===f ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
            marginBottom:-1 }}>
            {f}
            {f !== "all" && counts[f] > 0 && (
              <span style={{ marginLeft:4, fontSize:10, color: SEVERITY_COLOR[f], fontWeight:500 }}>{counts[f]}</span>
            )}
          </button>
        ))}
        <span style={{ marginLeft:"auto", fontSize:11, color:"var(--color-text-tertiary)", alignSelf:"center", paddingRight:4 }}>
          {filtered.length} event{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div style={{ overflowY:"auto", maxHeight:400 }}>
        {filtered.length === 0 && (
          <div style={{ padding:"20px 12px", color:"var(--color-text-tertiary)", fontSize:13, textAlign:"center" }}>
            {filter === "all" ? "No events yet" : `No ${filter} events`}
          </div>
        )}
        {filtered.map((e, i) => <EventRow key={i} e={e} />)}
      </div>
      {historical.length > 0 && (
        <div style={{ borderTop:"0.5px solid var(--color-border-tertiary)" }}>
          <button onClick={() => setShowHistorical(v => !v)} style={{
            width:"100%", background:"none", border:"none", cursor:"pointer",
            padding:"8px 12px", textAlign:"left", fontFamily:"inherit",
            fontSize:11, color:"var(--color-text-tertiary)", display:"flex",
            alignItems:"center", justifyContent:"space-between" }}>
            <span>{showHistorical ? "▾" : "▸"} Historical — node offline ({historical.length})</span>
            <span style={{ fontSize:10 }}>click to {showHistorical ? "collapse" : "expand"}</span>
          </button>
          {showHistorical && historical.map((e, i) => (
            <div key={i} style={{ display:"flex", gap:10, padding:"6px 12px",
              borderBottom:"0.5px solid var(--color-border-tertiary)",
              opacity:0.45, alignItems:"flex-start" }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:"#888", marginTop:5, flexShrink:0 }} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, color:"var(--color-text-tertiary)" }}>{e.message}</div>
                <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:1 }}>
                  {e.node_id && <span style={{ marginRight:6 }}>{e.node_id}</span>}
                  {formatEventTime(e.timestamp)} · node offline
                </div>
              </div>
              <Badge text="historical" severity="info" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─── LiveEventRail ────────────────────────────────────────────────────────────
function LiveEventRail({ events, title = "Live events", emptyMsg = "All clear", criticalNow = 0 }) {
  const recent = [...(events||[])]
    .sort((a, b) => (b.t || new Date(b.timestamp||0).getTime()) - (a.t || new Date(a.timestamp||0).getTime()))
    .slice(0, 25);
  const critCount = criticalNow; // active critical alerts right now, not old critical events in the list
  const timeStr = (e) => {
    if (e.timestamp) try { return new Date(e.timestamp).toLocaleTimeString(); } catch {}
    if (e.t) return new Date(e.t).toLocaleTimeString();
    return "";
  };
  const nodeStr = (e) => e.node_id || e.id || "";
  const evtKey  = (e) => `${e.timestamp || e.t || ""}|${nodeStr(e)}|${e.message || ""}`;
  const firstSeenRef = useRef(null);
  if (firstSeenRef.current === null) {
    firstSeenRef.current = new Map((events || []).map(e => [evtKey(e), 0])); // existing history: never "new"
  }
  const now = Date.now();
  recent.forEach(e => { const k = evtKey(e); if (!firstSeenRef.current.has(k)) firstSeenRef.current.set(k, now); });
  if (firstSeenRef.current.size > 500) firstSeenRef.current = new Map([...firstSeenRef.current].slice(-200));
  const freshClass = (e) => {
    const seen = firstSeenRef.current.get(evtKey(e));
    if (!seen || now - seen > 4000) return undefined;
    return e.severity === "critical" ? "evt-new-crit" : "evt-new";
  };
  return (
    <div style={{
      width: 210, flexShrink: 0,
      background: "var(--color-background-primary)",
      border: "0.5px solid var(--color-border-tertiary)",
      borderRadius: 12, overflow: "hidden",
      display: "flex", flexDirection: "column",
      alignSelf: "flex-start", position: "sticky", top: 0,
    }}>
      <div style={{ padding: "9px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)",
        fontSize: 10, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em",
        color: "var(--color-text-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0 }}>
        <span>{title}</span>
        {critCount > 0 && (
          <span style={{ background: "rgba(226,75,74,0.15)", color: SEVERITY_COLOR.critical,
            fontSize: 9, fontWeight: 500, padding: "1px 6px", borderRadius: 10 }}>
            {critCount} critical now
          </span>
        )}
      </div>
      <div style={{ overflowY: "auto", maxHeight: 520 }}>
        {recent.length === 0 ? (
          <div style={{ padding: "18px 12px", textAlign: "center", fontSize: 11, color: "var(--color-text-tertiary)" }}>
            <div style={{ fontSize: 14, marginBottom: 5, opacity: 0.25 }}>✓</div>
            {emptyMsg}
          </div>
        ) : recent.map((e, i) => (
          <div key={`${evtKey(e)}#${i}`} className={freshClass(e)}
            style={{ padding: "6px 10px", borderBottom: "0.5px solid var(--color-border-tertiary)",
            background: e.severity === "critical" ? "rgba(226,75,74,0.03)" : "transparent" }}>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, marginTop: 4,
                background: SEVERITY_COLOR[e.severity] || "#888",
                boxShadow: e.severity === "critical" ? `0 0 4px ${SEVERITY_COLOR.critical}` : "none" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, lineHeight: 1.35, color: "var(--color-text-primary)",
                  overflow: "hidden", textOverflow: "ellipsis",
                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                  {e.message}
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 2, alignItems: "center" }}>
                  {nodeStr(e) && <span style={{ fontSize: 9, color: "#0F6E56", fontWeight: 500 }}>{nodeStr(e)}</span>}
                  <span style={{ fontSize: 9, color: "var(--color-text-tertiary)" }}>{timeStr(e)}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle, right }) {
  return (
    <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:12 }}>
      <div>
        <span style={{ fontSize:13, fontWeight:500, letterSpacing:"0.04em", textTransform:"uppercase",
          color:"var(--color-text-secondary)" }}>{title}</span>
        {subtitle && <span style={{ fontSize:12, color:"var(--color-text-tertiary)", marginLeft:8 }}>{subtitle}</span>}
      </div>
      {right}
    </div>
  );
}

// ─── Active alerts: what's wrong right now (the event log below is the history) ──
// Incidents group alerts that share a root cause (e.g. one interference source hitting
// several devices). Stale alerts belong to nodes that stopped reporting.
const ALERT_COLOR = { critical: "#E24B4A", warning: "#BA7517", info: "#378ADD" };
const normalizeAlerts = (payload) => Array.isArray(payload)
  ? { incidents: [], alerts: payload }
  : { incidents: payload?.incidents || [], alerts: payload?.alerts || [] };
const activeAlertCount = (payload) => {
  const { incidents, alerts } = normalizeAlerts(payload);
  return incidents.length + alerts.filter(a => !a.incident).length;
};

function ActiveAlertsPanel({ alerts: payload, nodeDefs }) {
  const { incidents, alerts } = normalizeAlerts(payload);
  const [now, setNow] = useState(Date.now());
  const total = incidents.length + alerts.filter(a => !a.incident).length;
  useEffect(() => {
    if (!total) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [total]);
  const dur = (ms) => ms < 60000 ? `${Math.max(0, Math.floor(ms / 1000))} s` : `${Math.floor(ms / 60000)} min ${Math.floor((ms % 60000) / 1000)} s`;
  const label = (id) => nodeDefs[id]?.label || id;
  const rank = { critical: 0, warning: 1, info: 2 };
  const loose = alerts.filter(a => !a.incident)
    .sort((a, b) => (a.stale - b.stale) || (rank[a.severity] - rank[b.severity]) || (a.since - b.since));

  const AlertLine = ({ a, compact }) => {
    const c = a.stale ? "var(--color-text-tertiary)" : ALERT_COLOR[a.severity] || ALERT_COLOR.warning;
    return (
      <div style={{ background:"var(--color-background-primary)", borderRadius:10, opacity: a.stale ? 0.7 : 1,
        border:"0.5px solid var(--color-border-tertiary)", borderLeft:`3px solid ${c}`, padding: compact ? "6px 10px" : "9px 12px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
          <span style={{ fontSize:12, fontWeight:500, color:c }}>
            {a.title}{compact ? <span style={{ color:"var(--color-text-secondary)", fontWeight:400 }}> · {label(a.nodeId)}</span> : null}
          </span>
          <span style={{ fontSize:11, color:"var(--color-text-tertiary)", whiteSpace:"nowrap" }}>
            {a.stale ? `no data for ${dur(now - a.staleSince)}` : `for ${dur(now - a.since)}`}
          </span>
        </div>
        <div style={{ fontSize:11, color:"var(--color-text-secondary)", marginTop:3 }}>
          {!compact && `${label(a.nodeId)} · `}{a.stale ? `last ${a.last}` : `now ${a.last}`}
          {a.worst && a.worst !== a.last ? ` · worst ${a.worst}` : ""}
        </div>
      </div>
    );
  };

  return (
    <div style={{ marginBottom:18 }}>
      <SectionHeader title="Active alerts"
        subtitle={total ? `${incidents.length ? `${incidents.length} incident${incidents.length > 1 ? "s" : ""} · ` : ""}${alerts.length} alert${alerts.length === 1 ? "" : "s"}` : "none"} />
      {total === 0 && (
        <div style={{ fontSize:12, color:"var(--color-text-tertiary)", padding:"10px 14px", borderRadius:10,
          background:"var(--color-background-secondary)" }}>Nothing is wrong right now.</div>
      )}
      {incidents.map(inc => {
        const c = inc.state === "recovering" ? "#1D9E75" : ALERT_COLOR[inc.severity] || ALERT_COLOR.warning;
        const members = alerts.filter(a => a.incident === inc.id)
          .sort((a, b) => (rank[a.severity] - rank[b.severity]) || label(a.nodeId).localeCompare(label(b.nodeId)));
        return (
          <div key={inc.id} style={{ marginBottom:10, borderRadius:12, padding:"12px 14px",
            background: inc.state === "recovering" ? "rgba(29,158,117,0.08)" : "rgba(226,75,74,0.08)",
            border:`1px solid ${c}55`, borderLeft:`4px solid ${c}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:10, flexWrap:"wrap" }}>
              <span style={{ fontSize:14, fontWeight:500, color:c }}>
                {inc.title}{inc.state === "recovering" ? " · recovering" : ""}
              </span>
              <span style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>
                {inc.state === "recovering" ? `ended ${dur(now - inc.endedAt)} ago, lasted ${dur(inc.endedAt - inc.since)}` : `for ${dur(now - inc.since)}`}
              </span>
            </div>
            <div style={{ fontSize:12, color:"var(--color-text-secondary)", margin:"4px 0 10px" }}>
              {inc.nodes.length} device{inc.nodes.length === 1 ? "" : "s"} affected: {inc.nodes.join(", ")}
              {inc.worst ? ` · worst ${inc.worst}` : ""} · {members.length} alert{members.length === 1 ? "" : "s"}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:6 }}>
              {members.map(a => <AlertLine key={`${a.nodeId}|${a.key}`} a={a} compact />)}
            </div>
          </div>
        );
      })}
      {loose.length > 0 && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:8 }}>
          {loose.map(a => <AlertLine key={`${a.nodeId}|${a.key}`} a={a} />)}
        </div>
      )}
    </div>
  );
}

// ─── RF Analysis Tab ────────────────────────────────────────────────────────────
function TransmissionTimeline({ rhythm }) {
  if (!rhythm || rhythm.length < 2) {
    return <div style={{ padding:24, textAlign:"center", color:"var(--color-text-tertiary)", fontSize:12 }}>
      Waiting for transmission data...
    </div>;
  }
  const W = 600, H = 70, barW = Math.max(2, W / rhythm.length - 2);
  const maxInterval = Math.max(...rhythm.map(r => r.intervalMs), 2000);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:H }}>
      {rhythm.map((r, i) => {
        const x = (i / rhythm.length) * W;
        const h = Math.min(H - 10, (r.intervalMs / maxInterval) * (H - 10));
        const color = r.type === "gap" ? "#E24B4A" : r.type === "bulk" ? "#BA7517" : "#1D9E75";
        return <rect key={i} x={x} y={H - h} width={barW} height={h} fill={color} opacity={0.8} rx={1} />;
      })}
      <line x1={0} y1={H-1} x2={W} y2={H-1} stroke="var(--color-border-tertiary)" strokeWidth={0.5} />
    </svg>
  );
}

// One RF verdict per node, computed by the backend with the same thresholds as the
// alerts. The overview (cards, header badges) and this tab both read it, so they agree.
const VERDICT_COLOR = { clear: "#1D9E75", degraded: "#BA7517", interference: "#E24B4A", nodata: "#77746D" };
const VERDICT_TINT  = { clear: "rgba(29,158,117,0.12)", degraded: "rgba(186,117,23,0.14)", interference: "rgba(226,75,74,0.16)", nodata: "rgba(119,116,109,0.14)" };
const VERDICT_LABEL = { clear: "Clear: no interference detected", degraded: "Degraded: signal or timing problems", interference: "Interference detected", nodata: "No data: this node is not reporting" };
// A node that isn't reporting has no RF picture at all: "no data", never "clear".
const verdictOf = (rf, status) => status && status !== "online" ? "nodata"
  : rf?.verdict || (rf?.disruptionType && rf.disruptionType !== "none" ? "degraded" : "clear");
const isRfProblem = (v) => v === "degraded" || v === "interference";

function RfAnalysisTab({ nodeIds, nodeDefs, nodes, rfHealthMap, selectedNode, setSelectedNode }) {
  const node = selectedNode || nodeIds[0];
  const def  = nodeDefs[node] || {};
  const rf   = rfHealthMap[node] || {};
  const color = NODE_COLORS[def.type] || "#888";
  const isEventDriven = def.type === "security";
  const verdict = verdictOf(rf, nodes[node]?.status);
  const neverReported = verdict === "nodata" && !nodes[node]?.lastSeen; // nothing to analyse yet
  const vColor = VERDICT_COLOR[verdict];
  const sig = rf.signal;
  const history = (rf.signalHistory && rf.signalHistory.length ? rf.signalHistory : rf.rssiHistory || []).map((v, i) => ({ i, v }));
  const threshold = sig?.threshold ?? -85;
  const unit = sig?.unit || "dBm";
  const lossBad = (rf.packetLossRate || 0) > 10;

  const SignalChart = ({ title, emptyMsg }) => (
    <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
      borderRadius:12, padding:"14px 16px", marginBottom:16 }}>
      <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
        color:"var(--color-text-tertiary)", marginBottom:8 }}>{title}</div>
      {history.length > 1 ? (
        <ResponsiveContainer width="100%" height={130}>
          <LineChart data={history}>
            <XAxis dataKey="i" hide />
            <YAxis domain={[dataMin => Math.floor(Math.min(dataMin, threshold) - 5), dataMax => Math.ceil(Math.max(dataMax, threshold) + 5)]}
              tick={{ fontSize:10 }} width={36} />
            <Tooltip formatter={v => `${v} ${unit}`} labelFormatter={() => ""} contentStyle={{ fontSize:11 }} />
            <ReferenceLine y={threshold} stroke="#E24B4A" strokeDasharray="3 3" strokeWidth={1}
              label={{ value:`alert threshold ${threshold} ${unit}`, position:"insideTopRight", fontSize:9, fill:"#E24B4A" }} />
            <Line type="monotone" dataKey="v" name={sig?.name || "signal"} stroke={verdict === "interference" ? "#E24B4A" : color}
              strokeWidth={1.5} dot={{ r:2 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ padding:"24px 0", textAlign:"center", color:"var(--color-text-tertiary)", fontSize:12 }}>{emptyMsg}</div>
      )}
      <div style={{ fontSize:10, color:"var(--color-text-tertiary)", marginTop:6 }}>
        Below the red line is what raises an interference alert on the dashboard. The line follows your Settings.
      </div>
    </div>
  );

  const row = (label, value, valueColor) => (
    <div style={{ display:"flex", justifyContent:"space-between", gap:12 }}>
      <span style={{ color:"var(--color-text-secondary)" }}>{label}</span>
      <span style={{ fontWeight:500, color: valueColor || "var(--color-text-tertiary)", textAlign:"right" }}>{value}</span>
    </div>
  );

  return (
    <div>
      <SectionHeader title="RF Analysis"
        subtitle={isEventDriven ? "Event-driven sensor: judged on signal strength only" : "Signal strength · packet loss · transmission timing"} />

      <div style={{ display:"flex", gap:6, marginBottom:16, flexWrap:"wrap" }}>
        {nodeIds.map(id => {
          const v = verdictOf(rfHealthMap[id], nodes[id]?.status);
          const selected = node === id;
          return (
            <button key={id} onClick={() => setSelectedNode(id)} style={{
              fontSize:11, padding:"5px 12px", borderRadius:20, cursor:"pointer", fontFamily:"inherit",
              display:"inline-flex", alignItems:"center", gap:6,
              border: selected ? `1px solid ${VERDICT_COLOR[v]}` : "0.5px solid var(--color-border-tertiary)",
              background: v !== "clear" ? VERDICT_TINT[v] : (selected ? "var(--color-background-secondary)" : "var(--color-background-primary)"),
              color: selected ? "var(--color-text-primary)" : "var(--color-text-secondary)",
              fontWeight: selected ? 500 : 400 }}>
              <span style={{ width:7, height:7, borderRadius:"50%", background:VERDICT_COLOR[v] }} />
              {nodeDefs[id]?.label || id}
            </button>
          );
        })}
      </div>

      {/* Verdict, with the reasons behind it */}
      <div style={{ padding:"12px 16px", borderRadius:12, marginBottom:16, background:VERDICT_TINT[verdict],
        borderLeft:`3px solid ${vColor}` }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ width:10, height:10, borderRadius:"50%", background:vColor }} />
          <div style={{ fontSize:14, fontWeight:500, color:vColor }}>{VERDICT_LABEL[verdict]}</div>
        </div>
        <div style={{ fontSize:11, color:"var(--color-text-tertiary)", margin:"2px 0 0 20px" }}>{def.label} · {node}</div>
        {verdict === "nodata" && (
          <div style={{ fontSize:12, color:"var(--color-text-secondary)", margin:"8px 0 0 20px" }}>
            {nodes[node]?.lastSeen ? `Last reading ${new Date(nodes[node].lastSeen).toLocaleTimeString()}. Values below are the last known ones.` : "No reading received since the backend started."}
          </div>
        )}
        {verdict !== "nodata" && (rf.reasons || []).length > 0 && (
          <ul style={{ margin:"8px 0 0 20px", padding:0, listStyle:"none", fontSize:12, color:"var(--color-text-secondary)", lineHeight:1.6 }}>
            {rf.reasons.map((r, i) => <li key={i}>• {r}</li>)}
          </ul>
        )}
      </div>

      {!neverReported && <>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:16 }}>
        {[
          { label: sig ? sig.name : "Signal",
            value: sig ? `${sig.value} ${sig.unit}` : "—",
            sub: sig ? `alert below ${sig.threshold}` : "no signal metric",
            color: sig && sig.value < sig.threshold ? "#E24B4A" : "var(--color-text-primary)" },
          { label:"Packet loss", value: isEventDriven ? "n/a" : `${rf.packetLossRate ?? 0}%`,
            sub: isEventDriven ? "event-driven" : "last 30 s", color: lossBad ? "#E24B4A" : "var(--color-text-primary)" },
          { label:"Gaps", value: isEventDriven ? "n/a" : (rf.recentGaps ?? 0),
            sub: isEventDriven ? "event-driven" : `last 20 readings · ${rf.gapCount ?? 0} total`,
            color: (rf.recentGaps || 0) > 0 ? "#E24B4A" : "var(--color-text-primary)" },
          { label:"Buffered bursts", value: isEventDriven ? "n/a" : (rf.recentBulks ?? 0),
            sub: isEventDriven ? "event-driven" : `last 20 readings · ${rf.bulkSendCount ?? 0} total`,
            color: (rf.recentBulks || 0) > 0 ? "#BA7517" : "var(--color-text-primary)" },
        ].map(c => (
          <div key={c.label} style={{ background:"var(--color-background-secondary)", borderRadius:8, padding:"10px 12px" }}>
            <div style={{ fontSize:10, color:"var(--color-text-secondary)", marginBottom:4 }}>{c.label}</div>
            <div style={{ fontSize:20, fontWeight:500, color:c.color }}>{c.value}</div>
            <div style={{ fontSize:10, color:"var(--color-text-tertiary)", marginTop:2 }}>{c.sub}</div>
          </div>
        ))}
      </div>

      <SignalChart title={sig ? `${sig.name} (live)` : "Signal (live)"}
        emptyMsg={isEventDriven ? "Signal appears when motion or door events fire" : "Waiting for signal readings..."} />

      {!isEventDriven && (
        <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
          borderRadius:12, padding:"14px 16px", marginBottom:16 }}>
          <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
            color:"var(--color-text-tertiary)", marginBottom:8 }}>Transmission rhythm (live)</div>
          <div style={{ display:"flex", gap:14, marginBottom:8, fontSize:10, color:"var(--color-text-tertiary)" }}>
            <span><span style={{ display:"inline-block", width:8, height:8, background:"#1D9E75", borderRadius:2, marginRight:4 }} />On time</span>
            <span><span style={{ display:"inline-block", width:8, height:8, background:"#BA7517", borderRadius:2, marginRight:4 }} />Buffered burst</span>
            <span><span style={{ display:"inline-block", width:8, height:8, background:"#E24B4A", borderRadius:2, marginRight:4 }} />Gap (readings lost)</span>
          </div>
          <TransmissionTimeline rhythm={rf.transmissionRhythm} />
          <div style={{ fontSize:10, color:"var(--color-text-tertiary)", marginTop:6 }}>
            Bar height = time since the previous reading. Tall red bars are gaps; short amber bars are queued readings arriving together.
          </div>
        </div>
      )}

      <div style={{ background:"var(--color-background-secondary)", borderRadius:12, padding:"14px 16px" }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
          color:"var(--color-text-tertiary)", marginBottom:10 }}>What this means</div>
        <div style={{ display:"flex", flexDirection:"column", gap:8, fontSize:12 }}>
          {row("Signal strength", sig ? (sig.value < sig.threshold ? `Below the alert threshold (${sig.value} < ${sig.threshold} ${sig.unit})` : "Above the alert threshold") : "No signal metric",
            sig && sig.value < sig.threshold ? "#E24B4A" : undefined)}
          {row("Signal stability", (rf.rssiVariance || 0) > 5 ? `Fluctuating (σ ${rf.rssiVariance} dB)` : "Stable",
            (rf.rssiVariance || 0) > 5 ? "#BA7517" : undefined)}
          {!isEventDriven && row("Lost readings", (rf.recentGaps || 0) > 0 ? `${rf.recentGaps} gap(s) in the last 20 readings` : "None recently",
            (rf.recentGaps || 0) > 0 ? "#E24B4A" : undefined)}
          {!isEventDriven && row("Device buffering", (rf.recentBulks || 0) > 0 ? `${rf.recentBulks} burst(s): the device queued readings while the link was bad` : "None recently",
            (rf.recentBulks || 0) > 0 ? "#BA7517" : undefined)}
          {!isEventDriven && row("Last recovery", rf.lastRecoveryMs ? `${(rf.lastRecoveryMs / 1000).toFixed(1)} s after the last gap` : "—")}
          {isEventDriven && row("Timing analysis", "Not applicable: silence just means nothing happened")}
        </div>
      </div>
      </>}
    </div>
  );
}

// ─── DroneCard (overview tile) ───────────────────────────────────────────────
function DroneCard({ id, drone, events }) {
  if (!drone) return null;
  const color   = "#0F6E56";
  const ageMs   = drone.lastSeen ? Date.now() - new Date(drone.lastSeen).getTime() : Infinity;
  const isLive  = ageMs < 3000 && drone.status !== 'telemetry_lost';
  const isLost  = drone.status === 'telemetry_lost';
  const batColor = !drone.battery ? "#888"
    : drone.battery < 3.2 ? "#E24B4A"
    : drone.battery < 3.5 ? "#BA7517" : "#1D9E75";

  // Check for active critical events from unified stream
  const activeCritical = (events||[]).filter(e =>
    e.node_id === id && e.severity === "critical" && eventAgeMs(e.timestamp) < 600000
  ).sort((a,b) => parseEventTime(b.timestamp) - parseEventTime(a.timestamp));
  const hasOffPath       = activeCritical.some(e => e.type === "drone_off_path");
  const hasTelemetryLost = isLost || activeCritical.some(e => e.type === "drone_telemetry_lost");
  const isCritical       = hasOffPath || hasTelemetryLost;
  const borderColor      = isCritical ? "#E24B4A" : isLive ? color : "var(--color-border-tertiary)";
  const statusLabel      = hasTelemetryLost ? "SIGNAL LOST" : hasOffPath ? "OFF PATH" : isLive ? "airborne" : "offline";
  const statusColor      = isCritical ? "#E24B4A" : isLive ? color : "var(--color-text-secondary)";

  return (
    <div style={{
      background: isCritical ? "rgba(226,75,74,0.04)" : "var(--color-background-primary)",
      border:`0.5px solid ${isCritical ? "rgba(226,75,74,0.3)" : "var(--color-border-tertiary)"}`,
      borderRadius:12, padding:"14px 16px", display:"flex", flexDirection:"column", gap:4,
      borderTop:`2px solid ${borderColor}`, opacity: isLive || isCritical ? 1 : 0.7 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:16, color: statusColor }}>⬡</span>
          <span style={{ fontSize:13, fontWeight:500 }}>{id}</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <StatusDot status={isCritical ? "critical" : isLive ? "online" : "offline"} />
          <span style={{ fontSize:11, color: statusColor,
            textTransform:"uppercase", letterSpacing:"0.05em", fontWeight: isCritical ? 600 : 400 }}>
            {statusLabel}
          </span>
        </div>
      </div>
      <div style={{ fontSize:11, color:"#0F6E56", fontWeight:500, marginBottom:4 }}>
        drone · Crazyflie (Lighthouse)
      </div>
      {isCritical && activeCritical[0] && (
        <div style={{ fontSize:10, color:"#E24B4A", background:"rgba(226,75,74,0.08)",
          borderRadius:6, padding:"4px 8px", marginBottom:4, lineHeight:1.35 }}>
          ⚠ {activeCritical[0].message}
        </div>
      )}
      {(isLive || isLost || isCritical) ? (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginBottom:4 }}>
            {[["X", drone.x], ["Y", drone.y], ["Z", drone.z]].map(([label, val]) => (
              <div key={label} style={{ background:"var(--color-background-secondary)",
                borderRadius:6, padding:"5px 8px" }}>
                <div style={{ fontSize:10, color:"var(--color-text-tertiary)" }}>
                  {label}{(isLost || (isCritical && !isLive)) ? " *" : ""}
                </div>
                <div style={{ fontSize:12, fontWeight:500, color: (isLost || hasOffPath) ? "#E24B4A" : color }}>
                  {val != null ? val.toFixed(2) : "—"}<span style={{ fontSize:10, color:"var(--color-text-tertiary)" }}>m</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:10, fontSize:11, flexWrap:"wrap",
            borderTop:"0.5px solid var(--color-border-tertiary)", paddingTop:6 }}>
            <span style={{ color:"var(--color-text-secondary)" }}>
              Battery <strong style={{ color: batColor }}>
                {drone.battery != null ? `${drone.battery.toFixed(2)}V` : "—"}
              </strong>
            </span>
          </div>
        </>
      ) : (
        <div style={{ fontSize:12, color:"var(--color-text-tertiary)", padding:"8px 0" }}>
          No telemetry — not flying
        </div>
      )}
    </div>
  );
}

// ─── DroneTab — live flight monitoring ───────────────────────────────────────
// ─── Drone mission overlay ───────────────────────────────────────────────────
// MUST match OFF_PATH_THRESHOLD in mission-tracker.js, so the boundary drawn on the
// map is exactly where the detector raises the off-path alert.
const OFF_PATH_THRESHOLD_M = 0.3;
const OFF_ROUTE_RED = "#FF3B3B";
const DRONE_NEON = { "cf-e9": "#00FF9F", "cf-e8": "#00CFFF" };
const DRONE_NEON_FALLBACK = ["#FFD700", "#FF4BD8", "#00FF9F", "#00CFFF"];
const droneNeon = (id, idx) => DRONE_NEON[id] || DRONE_NEON_FALLBACK[idx % DRONE_NEON_FALLBACK.length];

// The route the tracker's flight model expects: up the street (start x), out to each
// waypoint at its y, back to the street, then home.
function plannedRoute(role) {
  const [sx, sy] = role.start;
  const pts = [{ x: sx, y: sy }];
  for (const [wx, wy] of role.waypoints) pts.push({ x: sx, y: wy }, { x: wx, y: wy }, { x: sx, y: wy });
  pts.push({ x: sx, y: sy });
  return pts;
}

// The x-range mission-tracker.js accepts as on route: the street corridor, each
// waypoint corridor and the transit between them, plus the threshold on both sides.
function allowedZone(role) {
  const xs = [role.start[0], ...role.waypoints.map(w => w[0])];
  const ys = [role.start[1], ...role.waypoints.map(w => w[1])];
  return {
    minX: Math.min(...xs) - OFF_PATH_THRESHOLD_M, maxX: Math.max(...xs) + OFF_PATH_THRESHOLD_M,
    minY: Math.min(...ys) - 0.25,                 maxY: Math.max(...ys) + 0.25,
  };
}

// ─── Package delivery phases ─────────────────────────────────────────────────
// At each waypoint the drone hovers at cruise height, descends to the waypoint's z (the
// drop height), holds there, then climbs back. From above that all looks like hovering,
// so we derive the phase from altitude and show it. Radius matches mission-tracker.js.
const WAYPOINT_REACH_M = 0.3;   // WAYPOINT_REACH_RADIUS in mission-tracker.js
const MIN_AIRBORNE_M   = 0.15;  // MIN_AIRBORNE_Z in mission-tracker.js
const DROP_TOL_M       = 0.06;  // within this of the drop height = delivering

function stepDelivery(st, d, role, deviated, check) {
  const now = Date.now();
  const z = typeof d.z === "number" ? d.z : 0;
  st.trend = st.lastZ == null ? 0 : z - st.lastZ;
  st.lastZ = z;
  const airborne = z >= MIN_AIRBORNE_M;
  if (airborne) st.everAirborne = true;
  const wps = role.waypoints || [];
  let near = null;
  wps.forEach(([wx, wy, wz], i) => {
    const dd = Math.hypot((d.x ?? 99) - wx, (d.y ?? 99) - wy);
    if (dd <= WAYPOINT_REACH_M && (!near || dd < near.dd)) near = { i, dd, target: wz ?? 1 };
  });
  if (airborne && !near) {
    st.cruiseSamples = [...(st.cruiseSamples || []), Math.min(z, 3)].slice(-25);
    const sorted = [...st.cruiseSamples].sort((a, b) => a - b);
    st.cruiseZ = sorted[Math.floor(sorted.length / 2)]; // median: brief altitude spikes don't move it
  }
  const cruiseZ = st.cruiseZ || Math.max(z, 1);
  let ph;
  if (deviated) ph = { phase: "interrupted" };
  else if (near && st.everAirborne) {
    // Checked BEFORE "landed": a drop height can be below the 0.15 m airborne line (WP 2 of cf-e9 is 0.10 m).
    const { i, target } = near;
    // Real drones rarely sit exactly on the drop height: within a quarter of the descent counts.
    const tol = Math.max(DROP_TOL_M, 0.25 * Math.max(0, cruiseZ - target));
    if (z <= target + tol) {
      st.reached.add(i);
      if (st.dropWp !== i) { st.dropWp = i; st.dropSince = now; }
      ph = { phase: "delivering", wp: i, target, dwellS: (now - st.dropSince) / 1000 };
    } else if (st.reached.has(i)) {
      st.delivered.add(i);
      ph = z < cruiseZ - 0.08 ? { phase: "climbing", wp: i, target } : { phase: "departing", wp: i, target };
    } else if (z < cruiseZ - 0.08) ph = { phase: "descending", wp: i, target };
    else ph = { phase: "over", wp: i, target };
  } else if (!airborne) {
    st.reached.forEach(i => st.delivered.add(i));
    ph = { phase: st.everAirborne ? "landed" : "ground" };
  } else {
    st.reached.forEach(i => st.delivered.add(i)); // left a waypoint after reaching drop height
    const next = wps.findIndex((_, i) => !st.delivered.has(i));
    // The mission tracker says every waypoint was reached: the drone is heading home, even if a
    // drop wasn't recognised from altitude (then the count stays honest, e.g. 1/2).
    const trackerDone = !!check?.complete || (check?.total > 0 && check?.visited >= check.total);
    ph = next === -1 || trackerDone ? { phase: "returning" } : { phase: "cruise", wp: next, target: wps[next][2] ?? 1 };
  }
  return { ...ph, z, cruiseZ, trend: st.trend, delivered: [...st.delivered], total: wps.length };
}

const newDeliveryState = () => ({ delivered: new Set(), reached: new Set(), lastZ: null, cruiseZ: null, everAirborne: false });

function phaseText(ph, total) {
  const wp = (i) => `WP ${i + 1}`;
  const m = (v) => `${(+v).toFixed(2)} m`;
  switch (ph?.phase) {
    case "ground":      return { main: "On the ground, waiting for takeoff" };
    case "cruise":      return { main: `Flying to ${wp(ph.wp)} at cruise height ${m(ph.cruiseZ)}` };
    case "over":        return { main: `Over ${wp(ph.wp)}, about to descend`, hint: true };
    case "descending":  return { main: `Descending for delivery at ${wp(ph.wp)}: ${m(ph.z)} → ${m(ph.target)}`, hint: true };
    case "delivering":  return { main: `Delivering package at ${wp(ph.wp)}: ${m(ph.z)} (drop height ${m(ph.target)}) · ${Math.floor(ph.dwellS)} s`, hint: true };
    case "climbing":    return { main: `Package ${ph.wp + 1} delivered ✓ · climbing back to ${m(ph.cruiseZ)}`, hint: true };
    case "departing":   return { main: `Package ${ph.wp + 1} delivered ✓ · leaving ${wp(ph.wp)}` };
    case "returning":   return { main: ph.delivered.length === total ? `All ${total} packages delivered, returning home` : `Returning home: ${ph.delivered.length}/${total} packages delivered` };
    case "landed":      return { main: ph.delivered.length === total ? `Mission complete: ${total}/${total} packages delivered` : `Landed: ${ph.delivered.length}/${total} packages delivered` };
    case "interrupted": return { main: `Mission interrupted: off route · ${ph.delivered.length}/${total} packages delivered`, bad: true };
    default:            return { main: "Waiting for telemetry" };
  }
}

function PackageIcon({ size = 22, color, filled }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.5 L21 7 V17 L12 21.5 L3 17 V7 Z" fill={filled ? color : "none"} fillOpacity={filled ? 0.25 : 0} />
      <path d="M3 7 L12 11.5 L21 7 M12 11.5 V21.5 M7.5 4.8 L16.5 9.3" />
    </svg>
  );
}

// Side view: the vertical motion the top-down map can't show
function AltitudeGauge({ ph, neon: neonIn, width = 140, height = 112, lost = false }) {
  const neon = lost ? "#77746D" : neonIn; // no telemetry: grey, last known position
  const H = height, W = width, top = 12, bottom = 16, axisX = 40; // room on the left for the drone's altitude value
  const maxZ = Math.max(1.2, (ph?.cruiseZ || 1) + 0.15);
  const yOf = (z) => top + (H - top - bottom) * (1 - Math.min(Math.max(z, 0), maxZ) / maxZ);
  const z = ph?.z ?? 0, target = ph?.target, cruise = ph?.cruiseZ || 1;
  const moving = !lost && Math.abs(ph?.trend || 0) > 0.015;
  const down = (ph?.trend || 0) < 0;
  const showDrop = target != null && ["over", "descending", "delivering", "climbing"].includes(ph?.phase);
  const yz = yOf(z), yt = showDrop ? yOf(target) : null, yc = yOf(cruise);
  // Reference labels sit on the right; the drone's own value sits next to the marker on the left side,
  // and reference labels move under their line when the drone is right on top of them.
  const refLabelY = (y) => (Math.abs(y - yz) < 13 ? y + 10 : y - 3);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ flexShrink:0 }} aria-label={`altitude ${z.toFixed(2)} metres`}>
      <text x="2" y="9" fontSize="8" fill="rgba(255,255,255,0.4)" fontFamily="monospace">SIDE VIEW</text>
      <line x1="4" y1={H - bottom} x2={W - 2} y2={H - bottom} stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
      <text x={W - 2} y={H - 4} fontSize="8" textAnchor="end" fill="rgba(255,255,255,0.4)" fontFamily="monospace">ground</text>
      <line x1="4" y1={yc} x2={W - 2} y2={yc} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />
      <text x={W - 2} y={refLabelY(yc)} fontSize="8" textAnchor="end" fill="rgba(255,255,255,0.5)" fontFamily="monospace">cruise {cruise.toFixed(2)}</text>
      {showDrop && <>
        <line x1="4" y1={yt} x2={W - 2} y2={yt} stroke={neon} strokeDasharray="4 3" strokeOpacity="0.85" />
        <text x={W - 2} y={refLabelY(yt)} fontSize="8" textAnchor="end" fill={neon} fontFamily="monospace">drop {target.toFixed(2)}</text>
      </>}
      {z < cruise - 0.02 && <line x1={axisX} y1={yc} x2={axisX} y2={yz} stroke={neon} strokeOpacity="0.35" strokeWidth="2" />}
      <circle cx={axisX} cy={yz} r="6" fill="#030508" stroke={neon} strokeWidth="2" strokeDasharray={lost ? "3 2" : undefined} />
      {moving && <path d={down ? `M${axisX - 4} ${yz + 9} l4 5 l4 -5` : `M${axisX - 4} ${yz - 9} l4 -5 l4 5`} stroke={neon} strokeWidth="1.8" fill="none" />}
      <text x={axisX - 9} y={yz + 3} fontSize="9" textAnchor="end" fill={neon} fontFamily="monospace" fontWeight="bold">{lost ? "?" : z.toFixed(2)}</text>
      {lost && <text x={axisX + 10} y={yz + 3} fontSize="8" fill={neon} fontFamily="monospace">last known {z.toFixed(2)} m</text>}
    </svg>
  );
}

// Mission column beside the flight map: route status, delivery steps, current phase and
// the side view for each drone, so the map and the vertical motion are seen together.
function MissionSidebar({ droneIds, droneState, droneMissions, deliveries, dronePathRef }) {
  const rows = droneIds.filter(id => droneMissions?.[id]?.roles?.[0]?.waypoints?.length);
  const [now, setNow] = useState(Date.now());
  const anyLost = rows.some(id => droneState[id]?.status === "telemetry_lost");
  useEffect(() => { // keeps "last update N s ago" counting while telemetry is silent
    if (!anyLost) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLost]);
  if (!rows.length) return null;
  return (
    <div style={{ flex:"0 0 300px", minWidth:0, display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
        color:"var(--color-text-tertiary)" }}>Mission: package delivery</div>
      {rows.map((id, idx) => {
        const neon  = droneNeon(id, idx);
        const role  = droneMissions[id].roles[0];
        const ph    = deliveries[id];
        const d     = droneState[id] || {};
        const check = d.pathCheck;
        const since = droneMissions[id].registered_at ? Date.parse(droneMissions[id].registered_at) - 1000 : 0;
        const left  = (dronePathRef.current[id] || []).some(p => p.off && p.t >= since); // this mission only
        const lost  = d.status === "telemetry_lost";
        const lastSeenS = d.lastSeen ? Math.max(0, Math.round((now - Date.parse(d.lastSeen)) / 1000)) : null;
        const baseTxt = phaseText(ph, role.waypoints.length);
        const txt   = lost ? { main: "No telemetry: showing the last known position", bad: true } : baseTxt;
        const delivered = new Set(ph?.delivered || []);
        const status = lost ? ["TELEMETRY LOST", OFF_ROUTE_RED]
                     : check?.offPath ? ["OFF ROUTE", OFF_ROUTE_RED] : left ? ["DEVIATED", OFF_ROUTE_RED]
                     : check ? ["ON ROUTE", neon] : ["WAITING", "rgba(255,255,255,0.45)"];
        const alarm = lost || check?.offPath || left;
        const banners = [
          check?.offPath && `Off route: +${(check.deviation ?? 0).toFixed(2)} m outside its allowed zone`,
          !check?.offPath && left && "Left its route during this flight",
          lost && `Telemetry lost${lastSeenS != null ? ` · last update ${lastSeenS} s ago` : ""}`,
        ].filter(Boolean);
        return (
          <div key={id} style={{ padding:"10px 12px", borderRadius:10, background:"#030508",
            border: alarm ? `1px solid ${OFF_ROUTE_RED}` : `0.5px solid ${neon}44` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
              <span style={{ fontSize:13, fontWeight:600, color:neon, fontFamily:"monospace" }}>{id.toUpperCase()}</span>
              <span style={{ fontSize:10, fontWeight:600, color:status[1], letterSpacing:"0.05em" }}>
                {status[0]} · WP {check?.visited ?? 0}/{role.waypoints.length}
              </span>
            </div>
            {banners.map(b => (
              <div key={b} style={{ marginTop:6, padding:"4px 8px", borderRadius:6, fontSize:11, fontWeight:600,
                color:OFF_ROUTE_RED, background:"rgba(255,59,59,0.10)", border:"0.5px solid rgba(255,59,59,0.45)" }}>{b}</div>
            ))}
            {/* Delivery steps: HOME → packages → HOME */}
            <div style={{ display:"flex", alignItems:"center", gap:4, marginTop:8, flexWrap:"wrap" }}>
              <span style={{ fontSize:9, color:"rgba(255,255,255,0.5)", fontFamily:"monospace" }}>HOME</span>
              {role.waypoints.map((w, i) => {
                const isDone = delivered.has(i);
                const isMissed = ph?.phase === "interrupted" && !isDone;
                const isActive = !isDone && !isMissed && ph?.wp === i && ["over", "descending", "delivering"].includes(ph?.phase);
                const arrived = !isDone && (check?.visited || 0) > i; // the tracker saw it reach the waypoint
                const c = isDone || isActive || arrived ? neon : isMissed ? OFF_ROUTE_RED : "rgba(255,255,255,0.35)";
                return (
                  <span key={i} style={{ display:"inline-flex", alignItems:"center", gap:4 }}>
                    <span style={{ width:12, height:2, background: isDone ? neon : "rgba(255,255,255,0.2)" }} />
                    <span title={`WP ${i + 1} · drop height ${(w[2] ?? 1).toFixed(2)} m`}
                      className={isActive ? "dlv-active" : undefined}
                      style={{ display:"inline-flex", alignItems:"center", gap:3, padding:"2px 6px", borderRadius:7,
                        border:`1px solid ${c}`, background: isDone ? `${neon}22` : "transparent", color:c }}>
                      <PackageIcon color={c} filled={isDone} size={15} />
                      <span style={{ fontSize:10, fontFamily:"monospace", fontWeight:600 }}>
                        {isDone ? `✓${i + 1}` : isMissed ? `✕${i + 1}` : `${i + 1}`}{isActive && ph.phase !== "over" ? " ↓" : ""}
                      </span>
                    </span>
                  </span>
                );
              })}
              <span style={{ width:12, height:2, background: ph?.phase === "returning" || ph?.phase === "landed" ? neon : "rgba(255,255,255,0.2)" }} />
              <span style={{ fontSize:9, color:"rgba(255,255,255,0.5)", fontFamily:"monospace" }}>HOME</span>
            </div>
            <div style={{ fontSize:12, lineHeight:1.35, marginTop:8, minHeight:32, color: txt.bad ? OFF_ROUTE_RED : "#E8E6E1" }}>{txt.main}</div>
            <AltitudeGauge ph={ph} neon={neon} width={274} height={104} lost={lost} />
            {txt.hint && <div style={{ fontSize:10, color:"rgba(255,255,255,0.45)", marginTop:2 }}>
              From above this looks like hovering; the side view shows it moving vertically.
            </div>}
          </div>
        );
      })}
      <style>{`@keyframes dlvPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(0,207,255,0); } 50% { box-shadow: 0 0 10px 1px rgba(0,207,255,0.45); } }
        .dlv-active { animation: dlvPulse 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .dlv-active { animation: none; } }`}</style>
    </div>
  );
}

function DroneTab({ droneState, droneEvents, dronePathRef, prevDroneStatus, prevPositionRef, events, droneMissions = {} }) {
    const canvasRef = useRef(null);
    const droneIds = Object.keys(droneState);
    const [layoutData, setLayoutData] = useState(null);
    const [layoutLoading, setLayoutLoading] = useState(true);
    const [clearPathTrigger, setClearPathTrigger] = useState(0);

    // ─── Zoom state ─────────────────────────────────────────────────────────────
    const [zoomLevel, setZoomLevel] = useState(1);
    const MIN_ZOOM = 0.5;
    const MAX_ZOOM = 4;
    const ZOOM_STEP = 0.25;

    // ─── Fetch layout from backend ──────────────────────────────────────────────
    useEffect(() => {
        if (layoutData) { setLayoutLoading(false); return; }  // already loaded — skip refetch
        let cancelled = false;
        const fetchLayout = async () => {
            try {
                const response = await fetch(`${BACKEND_URL}/api/layout`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                if (!cancelled) {
                    setLayoutData(data);
                    console.log("📐 Layout loaded:", data.sensors?.length || 0, "sensors,", data.buildings?.length || 0, "buildings");
                }
            } catch (err) {
                if (!cancelled) {
                    console.warn("Failed to load layout:", err.message);
                    setLayoutData({ sensors: [], buildings: [], router: { mx: 0, my: 0 } });
                }
            } finally {
                if (!cancelled) setLayoutLoading(false);
            }
        };
        fetchLayout();
        return () => { cancelled = true; };
    }, [layoutData]);

    // ─── Path management — single source of truth ──────────────────────────────
    // All path accumulation, clearing, and redraw triggering happens here.
    // DroneTab owns dronePathRef; no parent involvement needed.
    useEffect(() => {
        let pathChanged = false;

        Object.keys(droneState).forEach(id => {
            const drone = droneState[id];
            if (!drone) return;

            const prevStatus = prevDroneStatus.current[id];
            const currStatus = drone.status || 'online';

            // Trails are never cleared automatically: only "Clear path" or a page refresh clears them.
            // (Clearing on telemetry recovery used to erase a hijacked drone's off-route trail, because
            // the attack itself stalls telemetry.)
            prevDroneStatus.current[id] = currStatus;

            // ── Accumulate path points when airborne ──────────────────────────
            if (drone.x != null && drone.y != null && currStatus === 'online') {
                if (!dronePathRef.current[id]) dronePathRef.current[id] = [];

                const path  = dronePathRef.current[id];
                const prevZ = path.length > 0 ? path[path.length - 1].z : null;
                const currZ = drone.z || 0;

                // Keep a point only when the drone moved (1 cm) or its route status changed, so long
                // sessions keep their whole trail; cap at 6000 points per drone.
                const last = path[path.length - 1];
                const off = !!drone.pathCheck?.offPath;
                const moved = !last || Math.hypot(drone.x - last.x, drone.y - last.y) >= 0.01 || Math.abs(currZ - last.z) >= 0.01;
                if (moved || last.off !== off) {
                    path.push({ x: drone.x, y: drone.y, z: currZ, t: Date.now(), off });
                    if (path.length > 6000) path.shift();
                    pathChanged = true;
                }
            }
        });

        // Trigger canvas redraw only when path data actually changed
        if (pathChanged) setClearPathTrigger(n => n + 1);

    }, [droneState]);

    // ─── New mission registered → new flight: clear that drone's old trail ────
    const missionStampRef = useRef(null);
    useEffect(() => {
        const first = missionStampRef.current === null;
        if (first) missionStampRef.current = {};
        let changed = false;
        Object.entries(droneMissions || {}).forEach(([id, m]) => {
            if (!m?.registered_at || missionStampRef.current[id] === m.registered_at) return;
            // (a new mission no longer clears the trail; use "Clear path")
            missionStampRef.current[id] = m.registered_at;
        });
        if (changed) setClearPathTrigger(n => n + 1);
    }, [droneMissions]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Package delivery phase per drone ─────────────────────────────────────
    const deliveryStateRef = useRef({});
    const [deliveries, setDeliveries] = useState({});
    useEffect(() => {
        const next = {};
        Object.entries(droneMissions || {}).forEach(([id, m]) => {
            const role = m?.roles?.[0];
            const d = droneState[id];
            if (!role?.waypoints?.length || !d || d.x == null) return;
            const key = m.registered_at || "";
            let st = deliveryStateRef.current[id];
            if (!st || st.missionKey !== key) st = deliveryStateRef.current[id] = { ...newDeliveryState(), missionKey: key };
            const since = m.registered_at ? Date.parse(m.registered_at) - 1000 : 0;
            const deviated = !!d.pathCheck?.offPath || (dronePathRef.current[id] || []).some(p => p.off && p.t >= since);
            next[id] = stepDelivery(st, d, role, deviated, d.pathCheck);
        });
        setDeliveries(next);
    }, [droneState, droneMissions]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Clear all paths manually (button) ───────────────────────────────────
    const clearAllPaths = () => {
        Object.keys(dronePathRef.current).forEach(id => { dronePathRef.current[id] = []; });
        setClearPathTrigger(n => n + 1);
    };

    // ─── Zoom controls ──────────────────────────────────────────────────────────
    const zoomIn = () => {
        setZoomLevel(prev => Math.min(MAX_ZOOM, prev + ZOOM_STEP));
    };

    const zoomOut = () => {
        setZoomLevel(prev => Math.max(MIN_ZOOM, prev - ZOOM_STEP));
    };

    const resetZoom = () => {
        setZoomLevel(1);
    };

    // ─── Get view bounds based on zoom level ───────────────────────────────────
    const getViewBounds = useCallback(() => {
        // Base view (zoom = 1)
        const baseMinX = -1.8;
        const baseMaxX = 1.8;
        const baseMinY = -2.8;
        const baseMaxY = 2.2;

        const centerX = (baseMinX + baseMaxX) / 2;
        const centerY = (baseMinY + baseMaxY) / 2;
        const halfRangeX = (baseMaxX - baseMinX) / 2 / zoomLevel;
        const halfRangeY = (baseMaxY - baseMinY) / 2 / zoomLevel;

        return {
            minX: centerX - halfRangeX,
            maxX: centerX + halfRangeX,
            minY: centerY - halfRangeY,
            maxY: centerY + halfRangeY
        };
    }, [zoomLevel]);

    // ─── Get transform ──────────────────────────────────────────────────────────
    const getTransform = useCallback((W, H) => {
        const bounds = getViewBounds();
        const rangeX = bounds.maxX - bounds.minX;
        const rangeY = bounds.maxY - bounds.minY;
        const scale = Math.min(W / rangeX, H / rangeY);
        const offX = (W - rangeX * scale) / 2 - bounds.minX * scale;
        const offY = (H - rangeY * scale) / 2 - bounds.minY * scale;

        return {
            scale,
            offX,
            offY,
            bounds,
            toCanvas: (x, y) => ({
                x: x * scale + offX,
                y: H - (y * scale + offY)
            })
        };
    }, [getViewBounds]);

    // ─── Draw map with layout — neon tactical style ───────────────────────────
    const drawMap = useCallback((ctx, W, H) => {
        if (!layoutData || layoutLoading) return;
        const { toCanvas, bounds } = getTransform(W, H);

        // ── Deep space background ─────────────────────────────────────────────
        ctx.fillStyle = "#030508";
        ctx.fillRect(0, 0, W, H);

        // ── Subtle vignette ───────────────────────────────────────────────────
        const vignette = ctx.createRadialGradient(W/2, H/2, H*0.3, W/2, H/2, H*0.9);
        vignette.addColorStop(0, "rgba(0,0,0,0)");
        vignette.addColorStop(1, "rgba(0,0,0,0.6)");
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, W, H);

        // ── Grid — fine lines cyan tint ───────────────────────────────────────
        const gridStep = 0.25;
        // Minor grid
        ctx.strokeStyle = "rgba(0,200,255,0.04)";
        ctx.lineWidth = 0.5;
        for (let x = Math.ceil(bounds.minX/gridStep)*gridStep; x <= bounds.maxX; x += gridStep) {
            const p1 = toCanvas(x, bounds.minY), p2 = toCanvas(x, bounds.maxY);
            ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
        }
        for (let y = Math.ceil(bounds.minY/gridStep)*gridStep; y <= bounds.maxY; y += gridStep) {
            const p1 = toCanvas(bounds.minX, y), p2 = toCanvas(bounds.maxX, y);
            ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
        }
        // Major grid every 1m — brighter
        ctx.strokeStyle = "rgba(0,200,255,0.10)";
        ctx.lineWidth = 0.75;
        for (let x = Math.ceil(bounds.minX); x <= bounds.maxX; x += 1) {
            const p1 = toCanvas(x, bounds.minY), p2 = toCanvas(x, bounds.maxY);
            ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
        }
        for (let y = Math.ceil(bounds.minY); y <= bounds.maxY; y += 1) {
            const p1 = toCanvas(bounds.minX, y), p2 = toCanvas(bounds.maxX, y);
            ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
        }

        // ── Road ─────────────────────────────────────────────────────────────
        const roadCenter = layoutData.router?.mx || 0;
        const roadHalfWidth = 0.30;
        const roadLeft   = toCanvas(roadCenter - roadHalfWidth, 0).x;
        const roadRight  = toCanvas(roadCenter + roadHalfWidth, 0).x;
        const roadTop    = toCanvas(0, bounds.maxY).y;
        const roadBottom = toCanvas(0, bounds.minY).y;

        // Road fill
        ctx.fillStyle = "rgba(20,30,45,0.85)";
        ctx.fillRect(roadLeft, roadBottom, roadRight - roadLeft, roadTop - roadBottom);

        // Road edge lines — neon blue
        ctx.shadowColor = "#00aaff";
        ctx.shadowBlur = 8;
        ctx.strokeStyle = "rgba(0,170,255,0.6)";
        ctx.lineWidth = 1.5;
        for (let offset of [-roadHalfWidth, roadHalfWidth]) {
            const x = toCanvas(roadCenter + offset, 0).x;
            ctx.beginPath();
            ctx.moveTo(x, roadBottom);
            ctx.lineTo(x, roadTop);
            ctx.stroke();
        }
        ctx.shadowBlur = 0;

        // Center dashes — white
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
        ctx.setLineDash([10, 12]);
        ctx.beginPath();
        ctx.moveTo(toCanvas(roadCenter, bounds.minY).x, roadBottom);
        ctx.lineTo(toCanvas(roadCenter, bounds.maxY).x, roadTop);
        ctx.stroke();
        ctx.setLineDash([]);

        // ── Buildings ────────────────────────────────────────────────────────
        const bldgFill = {
            story1:   "rgba(30,90,160,0.25)",
            story3:   "rgba(30,140,80,0.25)",
            hospital: "rgba(200,40,60,0.22)",
            flat:     "rgba(80,60,160,0.20)",
        };
        const bldgGlow = {
            story1:   "#1E6ECC",
            story3:   "#1D9E52",
            hospital: "#E24B4A",
            flat:     "#7F77DD",
        };

        (layoutData.buildings || []).forEach(b => {
            const cx = b.mx||0, cy = b.my||0, w = b.w||0.35, h = b.h||0.35;
            if (cx < bounds.minX-0.5 || cx > bounds.maxX+0.5 || cy < bounds.minY-0.5 || cy > bounds.maxY+0.5) return;
            const p1 = toCanvas(cx - w/2, cy - h/2);
            const p2 = toCanvas(cx + w/2, cy + h/2);
            const bw = p2.x - p1.x, bh = p2.y - p1.y;
            const glow = bldgGlow[b.btype] || "#888";

            // Fill
            ctx.fillStyle = bldgFill[b.btype] || "rgba(80,80,80,0.2)";
            ctx.fillRect(p1.x, p1.y, bw, bh);

            // Neon border with glow
            ctx.shadowColor = glow;
            ctx.shadowBlur = 12;
            ctx.strokeStyle = glow + "cc";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(p1.x, p1.y, bw, bh);
            ctx.shadowBlur = 0;

            // Corner brackets — tactical style
            const bracket = 8;
            ctx.strokeStyle = "rgba(255,255,255,0.6)";
            ctx.lineWidth = 1.5;
            for (let [cx2, cy2, sx, sy] of [
                [p1.x, p1.y, 1, 1], [p2.x, p1.y, -1, 1],
                [p1.x, p2.y, 1, -1], [p2.x, p2.y, -1, -1]
            ]) {
                ctx.beginPath();
                ctx.moveTo(cx2 + sx*bracket, cy2);
                ctx.lineTo(cx2, cy2);
                ctx.lineTo(cx2, cy2 + sy*bracket);
                ctx.stroke();
            }

            // Label
            ctx.fillStyle = "rgba(255,255,255,0.8)";
            ctx.font = "bold 9px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const label = b.label || b.id || '';
            ctx.fillText(label.length > 14 ? label.slice(0,12)+'…' : label, p1.x+bw/2, p1.y+bh/2);
        });

        // ── Sensors ──────────────────────────────────────────────────────────
        const sensorNeon = {
            environmental: "#00FF9F",
            medical:       "#FF4B6E",
            hub:           "#00CFFF",
            traffic:       "#A78BFA",
            security:      "#FF8C42",
            gps:           "#00FF9F",
        };

        (layoutData.sensors || []).forEach(s => {
            const pos = s.position;
            if (!pos || pos.mx === undefined) return;
            if (pos.mx < bounds.minX-0.5 || pos.mx > bounds.maxX+0.5) return;
            const p = toCanvas(pos.mx, pos.my);
            const neon = sensorNeon[s.type] || "#ffffff";

            // Outer glow ring
            ctx.shadowColor = neon;
            ctx.shadowBlur = 14;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 7, 0, Math.PI*2);
            ctx.fillStyle = neon + "22";
            ctx.fill();
            ctx.shadowBlur = 0;

            // Solid dot
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI*2);
            ctx.fillStyle = neon + "cc";
            ctx.fill();
            ctx.strokeStyle = neon;
            ctx.lineWidth = 1;
            ctx.stroke();

            // Inner bright core
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2, 0, Math.PI*2);
            ctx.fillStyle = "#ffffff";
            ctx.fill();

            // Label
            ctx.shadowColor = neon;
            ctx.shadowBlur = 6;
            ctx.fillStyle = neon;
            ctx.font = "bold 8px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            const label = s.label || s.id || '';
            ctx.fillText(label.length > 10 ? label.slice(0,8)+'…' : label, p.x, p.y - 8);
            ctx.shadowBlur = 0;
        });

        // ── Router ───────────────────────────────────────────────────────────
        if (layoutData.router) {
            const r = toCanvas(layoutData.router.mx, layoutData.router.my);
            // Pulsing ring effect
            ctx.shadowColor = "#FFD700";
            ctx.shadowBlur = 20;
            ctx.beginPath();
            ctx.arc(r.x, r.y, 12, 0, Math.PI*2);
            ctx.strokeStyle = "rgba(255,215,0,0.5)";
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(r.x, r.y, 6, 0, Math.PI*2);
            ctx.fillStyle = "#FFD700";
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.fillStyle = "rgba(255,215,0,0.9)";
            ctx.font = "bold 9px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.fillText("ROUTER", r.x, r.y - 15);
        }

        // ── Mission start markers ─────────────────────────────────────────────
        const startY = layoutData.router?.my !== undefined ? layoutData.router.my - 0.15 : -2.18;
        const missionHomes = Object.entries(droneMissions || {})
            .filter(([, m]) => m?.roles?.[0]?.start)
            .map(([id, m], i) => ({ x: m.roles[0].start[0], y: m.roles[0].start[1], label: id, neon: droneNeon(id, i) }));
        (missionHomes.length ? missionHomes : [
            { x: -0.25, y: startY, label: "cf-e8", neon: droneNeon("cf-e8", 0) },
            { x:  0.25, y: startY, label: "cf-e9", neon: droneNeon("cf-e9", 1) },
        ]).forEach(({ x, y, label, neon }) => {
            if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) return;
            const p = toCanvas(x, y);
            ctx.shadowColor = neon;
            ctx.shadowBlur = 16;
            // Diamond shape
            ctx.beginPath();
            ctx.moveTo(p.x, p.y - 8);
            ctx.lineTo(p.x + 6, p.y);
            ctx.lineTo(p.x, p.y + 8);
            ctx.lineTo(p.x - 6, p.y);
            ctx.closePath();
            ctx.fillStyle = neon + "33";
            ctx.strokeStyle = neon;
            ctx.lineWidth = 1.5;
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.fillStyle = neon;
            ctx.font = "bold 8px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText("HOME", p.x, p.y + 10);
            ctx.font = "7px monospace";
            ctx.fillStyle = neon + "bb";
            ctx.fillText(label, p.x, p.y + 20);
        });

        // ── HUD overlays ─────────────────────────────────────────────────────
        ctx.fillStyle = "rgba(0,200,255,0.35)";
        ctx.font = "9px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(`ZOOM ${(zoomLevel*100).toFixed(0)}%`, 10, H - 8);
        ctx.textAlign = "right";
        ctx.fillStyle = "rgba(0,200,255,0.35)";
        ctx.fillText(`${bounds.minX.toFixed(1)}m — ${bounds.maxX.toFixed(1)}m`, W - 10, H - 8);

    }, [layoutData, layoutLoading, getTransform, zoomLevel, droneMissions]);

    // ─── Draw registered missions: allowed zone, planned route, waypoints ─────
    const drawMissions = useCallback((ctx, W, H) => {
        if (!layoutData) return;
        const { toCanvas } = getTransform(W, H);
        Object.entries(droneMissions || {}).forEach(([id, m], i) => {
            const role = m?.roles?.[0];
            if (!role?.start || !role?.waypoints?.length) return;
            const neon  = droneNeon(id, i);
            const check = droneState[id]?.pathCheck;
            const off   = !!check?.offPath;
            const zone  = allowedZone(role);
            const tl = toCanvas(zone.minX, zone.maxY), br = toCanvas(zone.maxX, zone.minY);

            // Allowed zone: faint band + dashed boundaries (red while this drone is outside it)
            ctx.fillStyle = off ? "rgba(255,59,59,0.07)" : neon + "0d";
            ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
            ctx.setLineDash([4, 6]);
            ctx.lineWidth = off ? 2 : 1;
            ctx.strokeStyle = off ? OFF_ROUTE_RED + "dd" : neon + "66";
            [zone.minX, zone.maxX].forEach(x => {
                const a = toCanvas(x, zone.minY), b = toCanvas(x, zone.maxY);
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            });
            ctx.setLineDash([]);
            ctx.fillStyle = off ? OFF_ROUTE_RED : neon + "aa";
            ctx.font = "bold 8px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(`${id.toUpperCase()} ALLOWED ZONE`, (tl.x + br.x) / 2, br.y + 4);

            // Planned route
            const route = plannedRoute(role).map(p => toCanvas(p.x, p.y));
            ctx.setLineDash([8, 6]);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = neon + "99";
            ctx.beginPath();
            route.forEach((p, k) => k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.stroke();
            ctx.setLineDash([]);

        });
    }, [droneMissions, droneState, layoutData, getTransform]);

    // ─── Waypoint markers (drawn after trails so the numbers stay readable) ───
    const drawWaypoints = useCallback((ctx, W, H) => {
        if (!layoutData) return;
        const { toCanvas } = getTransform(W, H);
        Object.entries(droneMissions || {}).forEach(([id, m], i) => {
            const role = m?.roles?.[0];
            if (!role?.waypoints?.length) return;
            const neon  = droneNeon(id, i);
            const check = droneState[id]?.pathCheck;
            const ph    = deliveries[id];
            const done  = new Set(ph?.delivered || []);
            // Waypoints: hollow → arrived (thick ring) → delivering (drop rings) → delivered (filled ✓)
            role.waypoints.forEach(([wx, wy, wz], k) => {
                const p = toCanvas(wx, wy);
                const reached   = (check?.visited || 0) > k;
                const delivered = done.has(k);
                const dropping  = !delivered && ph?.wp === k && (ph.phase === "descending" || ph.phase === "delivering");

                if (dropping) {
                    // Concentric rings closing in on the drop point: "going down here"
                    const t = (Date.now() % 1500) / 1500;
                    for (let r = 0; r < 3; r++) {
                        const rad = 28 - ((t + r / 3) % 1) * 18;
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
                        ctx.strokeStyle = neon + Math.round(40 + (1 - rad / 28) * 160).toString(16).padStart(2, "0");
                        ctx.lineWidth = 1.5;
                        ctx.stroke();
                    }
                    ctx.fillStyle = neon;
                    ctx.font = "bold 9px monospace";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "top";
                    ctx.fillText(`DROP ↓ ${(wz ?? 1).toFixed(2)} m`, p.x, p.y + 30);
                }

                ctx.shadowColor = neon;
                ctx.shadowBlur = delivered || dropping ? 14 : 10;
                ctx.beginPath();
                ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
                ctx.fillStyle = delivered ? neon + "dd" : "#030508";
                ctx.fill();
                ctx.strokeStyle = neon;
                ctx.lineWidth = reached || dropping ? 2.5 : 1.5;
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.fillStyle = delivered ? "#030508" : neon;
                ctx.font = "bold 9px monospace";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(delivered ? "✓" : String(k + 1), p.x, p.y + 0.5);
            });
        });
    }, [droneMissions, droneState, layoutData, getTransform, deliveries]);


    // ─── Draw drone paths — neon trails ──────────────────────────────────────
    const drawDronePaths = useCallback((ctx, W, H) => {
        if (!layoutData) return;
        const { toCanvas } = getTransform(W, H);
        // Neon colors per drone — highly visible

        droneIds.forEach((id, idx) => {
            const path = dronePathRef.current[id] || [];
            if (path.length < 2) return;
            const drone = droneState[id];
            const ageMs = drone?.lastSeen ? Date.now() - new Date(drone.lastSeen).getTime() : Infinity;
            const isLive = ageMs < 3000; // trails stay on screen after landing; only the drone icon dims

            const neon = droneNeon(id, idx);
            const offNow = !!drone?.pathCheck?.offPath;

            // ── Thick glowing trail ───────────────────────────────────────────
            // Glow layer — wide, very transparent
            for (let i = 1; i < path.length; i++) {
                const a = toCanvas(path[i-1].x, path[i-1].y);
                const b = toCanvas(path[i].x, path[i].y);
                const t = i / path.length;
                const alpha = Math.round((0.05 + 0.12 * t) * 255).toString(16).padStart(2,"0");
                ctx.beginPath();
                ctx.strokeStyle = (path[i].off ? OFF_ROUTE_RED : neon) + alpha;
                ctx.lineWidth = 10;
                ctx.lineCap = "round";
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
            }
            // Core line — sharp and bright
            for (let i = 1; i < path.length; i++) {
                const a = toCanvas(path[i-1].x, path[i-1].y);
                const b = toCanvas(path[i].x, path[i].y);
                const t = i / path.length;
                // Off-route segments never fade: they are the evidence
                const alpha = path[i].off ? "ff" : Math.round((0.35 + 0.65 * t) * 255).toString(16).padStart(2,"0");
                const segColor = path[i].off ? OFF_ROUTE_RED : neon;
                ctx.beginPath();
                ctx.shadowColor = segColor;
                ctx.shadowBlur = path[i].off ? 12 : 6;
                ctx.strokeStyle = segColor + alpha;
                ctx.lineWidth = path[i].off ? 3.5 : 2.5;
                ctx.lineCap = "round";
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
            }
            ctx.shadowBlur = 0;

            // Waypoint dots along path — every 10 points
            for (let i = 0; i < path.length - 1; i += 10) {
                const p = toCanvas(path[i].x, path[i].y);
                const t = i / path.length;
                if (t < 0.8) {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 2, 0, Math.PI*2);
                    ctx.fillStyle = neon + "66";
                    ctx.fill();
                }
            }

            // ── Current position — drone icon ─────────────────────────────────
            if (path.length > 0) {
                const pos = toCanvas(path[path.length-1].x, path[path.length-1].y);
                const drone2 = droneState[id];
                const yaw = drone2?.yaw != null ? (drone2.yaw * Math.PI / 180) : 0;

                // Off route: dashed connector to the zone edge it crossed, with the distance
                const role = droneMissions?.[id]?.roles?.[0];
                if (offNow && role) {
                    const cur  = path[path.length - 1];
                    const zone = allowedZone(role);
                    const edgeX = cur.x < zone.minX ? zone.minX : zone.maxX;
                    const edge = toCanvas(edgeX, cur.y);
                    ctx.setLineDash([5, 4]);
                    ctx.strokeStyle = OFF_ROUTE_RED;
                    ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.moveTo(pos.x, pos.y); ctx.lineTo(edge.x, edge.y); ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = OFF_ROUTE_RED;
                    ctx.font = "bold 10px monospace";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "top";
                    ctx.fillText(`+${(drone2.pathCheck.deviation ?? 0).toFixed(2)} m`, (pos.x + edge.x) / 2, pos.y + 12);
                }
                const iconColor = offNow ? OFF_ROUTE_RED : neon;
                const neonIcon = iconColor;

                // Outer pulse ring
                ctx.shadowColor = neonIcon;
                ctx.shadowBlur = 30;
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, 22, 0, Math.PI*2);
                ctx.strokeStyle = neonIcon + "22";
                ctx.lineWidth = 8;
                ctx.stroke();

                // Inner ring
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, 14, 0, Math.PI*2);
                ctx.strokeStyle = neonIcon + "55";
                ctx.lineWidth = 1.5;
                ctx.stroke();
                ctx.shadowBlur = 0;

                // Drone body — hexagon rotated with yaw
                ctx.save();
                ctx.translate(pos.x, pos.y);
                ctx.rotate(-yaw);
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const angle = (Math.PI/3)*i - Math.PI/6;
                    const px = 10 * Math.cos(angle);
                    const py = 10 * Math.sin(angle);
                    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
                }
                ctx.closePath();
                ctx.shadowColor = neonIcon;
                ctx.shadowBlur = 20;
                ctx.fillStyle = neonIcon + "33";
                ctx.fill();
                ctx.strokeStyle = neonIcon;
                ctx.lineWidth = 2;
                ctx.stroke();

                // Direction arrow
                ctx.beginPath();
                ctx.moveTo(0, -14);
                ctx.lineTo(-4, -9);
                ctx.lineTo(4, -9);
                ctx.closePath();
                ctx.fillStyle = neonIcon;
                ctx.fill();
                ctx.shadowBlur = 0;
                ctx.restore();

                // Altitude badge, with an arrow while the drone is descending or climbing
                const z = path[path.length-1].z;
                const dph = deliveries[id];
                const vArrow = dph && Math.abs(dph.trend || 0) > 0.015 ? (dph.trend < 0 ? " ↓" : " ↑") : "";
                const badgeW = vArrow ? 54 : 42;
                ctx.fillStyle = "#000000cc";
                ctx.beginPath();
                ctx.roundRect ? ctx.roundRect(pos.x+14, pos.y-10, badgeW, 16, 3) : ctx.rect(pos.x+14, pos.y-10, badgeW, 16);
                ctx.fill();
                ctx.fillStyle = neon;
                ctx.font = "bold 9px monospace";
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillText(`z:${z != null ? z.toFixed(2) : "--"}m${vArrow}`, pos.x+18, pos.y-2);

                // ID label
                ctx.shadowColor = neon;
                ctx.shadowBlur = 8;
                ctx.fillStyle = neon;
                ctx.font = "bold 10px monospace";
                ctx.textAlign = "center";
                ctx.textBaseline = "bottom";
                ctx.textAlign = "center";
                ctx.textBaseline = "bottom";
                ctx.fillText(id.toUpperCase(), pos.x, pos.y - 12);
                if (offNow) {
                    ctx.fillStyle = OFF_ROUTE_RED;
                    ctx.font = "bold 10px monospace";
                    ctx.fillText("OFF ROUTE", pos.x, pos.y - 25);
                }
                ctx.shadowBlur = 0;

                if (drone?.z != null) {
                    ctx.fillStyle = "rgba(255,255,255,0.4)";
                    ctx.font = "6px monospace";
                    ctx.textBaseline = "top";
                    ctx.fillText(`z:${drone.z.toFixed(2)}m`, pos.x, pos.y + 10);
                }

                if (drone?.battery != null) {
                    const batColor = drone.battery < 3.2 ? "#E24B4A" : drone.battery < 3.5 ? "#BA7517" : "#1D9E75";
                    ctx.fillStyle = batColor + "77";
                    ctx.font = "6px monospace";
                    ctx.textBaseline = "top";
                    ctx.fillText(`🔋${drone.battery.toFixed(2)}V`, pos.x, pos.y + 18);
                }
            }
        });
    }, [droneState, droneIds, layoutData, getTransform, droneMissions, deliveries]);

    // ─── Main canvas render ────────────────────────────────────────────────────
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;

        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);

        const W = rect.width;
        const H = rect.height;

        drawMap(ctx, W, H);
        drawMissions(ctx, W, H);
        drawDronePaths(ctx, W, H);
        drawWaypoints(ctx, W, H);

    }, [drawMap, drawMissions, drawDronePaths, drawWaypoints, clearPathTrigger, zoomLevel]);

    // ─── Handle resize ──────────────────────────────────────────────────────────
    useEffect(() => {
        const handleResize = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;

            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;

            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;

            const ctx = canvas.getContext("2d");
            ctx.scale(dpr, dpr);
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);


    return (
        <div>
            <SectionHeader
                title="Drone Flight Monitor"
                subtitle={`${droneIds.length} drone${droneIds.length !== 1 ? "s" : ""} · Crazyflie Lighthouse`}
                right={
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <button
                            onClick={zoomIn}
                            style={{
                                fontSize: 14,
                                background: "none",
                                border: "0.5px solid var(--color-border-secondary)",
                                borderRadius: 4,
                                padding: "2px 10px",
                                cursor: "pointer",
                                color: "var(--color-text-secondary)",
                                fontFamily: "inherit",
                                fontWeight: 500,
                                minWidth: 28
                            }}
                            title="Zoom in"
                        >
                            +
                        </button>
                        <button
                            onClick={zoomOut}
                            style={{
                                fontSize: 14,
                                background: "none",
                                border: "0.5px solid var(--color-border-secondary)",
                                borderRadius: 4,
                                padding: "2px 10px",
                                cursor: "pointer",
                                color: "var(--color-text-secondary)",
                                fontFamily: "inherit",
                                fontWeight: 500,
                                minWidth: 28
                            }}
                            title="Zoom out"
                        >
                            −
                        </button>
                        <button
                            onClick={resetZoom}
                            style={{
                                fontSize: 10,
                                background: "none",
                                border: "0.5px solid var(--color-border-secondary)",
                                borderRadius: 4,
                                padding: "2px 8px",
                                cursor: "pointer",
                                color: "var(--color-text-secondary)",
                                fontFamily: "inherit"
                            }}
                            title="Reset zoom"
                        >
                            ↺
                        </button>
                        <span style={{
                            fontSize: 10,
                            color: "var(--color-text-tertiary)",
                            minWidth: 36,
                            textAlign: "center"
                        }}>
                            {(zoomLevel * 100).toFixed(0)}%
                        </span>
                        <button
                            onClick={clearAllPaths}
                            style={{
                                fontSize: 11,
                                background: "none",
                                border: "0.5px solid var(--color-border-secondary)",
                                borderRadius: 6,
                                padding: "4px 12px",
                                cursor: "pointer",
                                color: "var(--color-text-secondary)",
                                fontFamily: "inherit",
                                transition: "all 0.2s"
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                        >
                            Clear path
                        </button>
                    </div>
                }
            />

            {droneIds.length === 0 ? (
                <div style={{
                    background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)",
                    borderRadius: 12, padding: "40px 20px", textAlign: "center"
                }}>
                    <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.3 }}>⬡</div>
                    <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>No drones online</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 4 }}>
                        Start the Crazyflie mission script to see live telemetry
                    </div>
                </div>
            ) : (
                <>
                    {/* Telemetry cards */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 10, marginBottom: 16 }}>
                        {droneIds.map(id => <DroneCard key={id} id={id} drone={droneState[id]} events={events} />)}
                    </div>

                    {/* Path trace canvas with layout overlay */}
                    <div style={{
                        background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)",
                        borderRadius: 12, padding: "14px 16px", marginBottom: 16
                    }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                            <div style={{
                                fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em",
                                color: "var(--color-text-tertiary)"
                            }}>
                                Flight path — top-down view (X/Y plane) with layout
                            </div>
                            <div style={{ display: "flex", gap: 10, fontSize: 10, color: "var(--color-text-tertiary)", alignItems: "center" }}>
                                <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#0F6E56", clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)", marginRight: 4 }} />Drone</span>
                                <span><span style={{ display: "inline-block", width: 8, height: 8, background: "rgba(100,150,200,0.18)", borderRadius: 2, border: "0.5px solid rgba(100,150,200,0.35)", marginRight: 4 }} />Building</span>
                                <span><span style={{ display: "inline-block", width: 8, height: 8, background: "rgba(255,215,0,0.35)", borderRadius: "50%", marginRight: 4 }} />Router</span>
                                <span><span style={{ display: "inline-block", width: 8, height: 8, background: "rgba(255,255,255,0.3)", borderRadius: "50%", marginRight: 4 }} />Sensor</span>
                            </div>
                        </div>
                        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
                            <MissionSidebar droneIds={droneIds} droneState={droneState} droneMissions={droneMissions}
                                deliveries={deliveries} dronePathRef={dronePathRef} />
                            <div style={{ flex: "1 1 480px", minWidth: 0 }}>
                                <canvas
                                    ref={canvasRef}
                                    style={{ width: "100%", height: "560px", background: "#030508", borderRadius: 8, display: "block", cursor: "crosshair" }}
                                />
                            </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 6 }}>
                            <span>Trail fades oldest → newest · Hexagon = current position</span>
                            <span>z altitude shown beside marker · Trails stay until Clear path or page refresh</span>
                        </div>
                    </div>

                    
                </>
            )}
        </div>
    );
}
function SettingsPanel({ config, defaults, onUpdate }) {
  const [local, setLocal] = useState(config);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setLocal(config); }, [config]);
  const set = (key, val) => setLocal(prev => ({ ...prev, [key]: val }));
  const save = () => { onUpdate(local); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  // Defaults come from the backend (config/alerting.json); the local copy is only a fallback.
  const reset = () => { const d = defaults || DEFAULT_CONFIG; setLocal(d); onUpdate(d); };

  const Row = ({ label, desc, k, min, max, step = 1, unit = "" }) => (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 140px 80px", gap:12, alignItems:"center",
      padding:"10px 0", borderBottom:"0.5px solid var(--color-border-tertiary)" }}>
      <div>
        <div style={{ fontSize:13, fontWeight:500 }}>{label}</div>
        <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:2 }}>{desc}</div>
      </div>
      <input type="range" min={min} max={max} step={step} value={local[k]}
        onChange={e => set(k, parseFloat(e.target.value))} style={{ width:"100%", accentColor:"#378ADD" }} />
      <div style={{ fontSize:13, fontWeight:500, textAlign:"right", color:"#378ADD" }}>{local[k]}{unit}</div>
    </div>
  );

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
        <SectionHeader title="Monitoring Parameters" subtitle="Applied live to backend detection" />
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={reset} style={{ fontSize:11, background:"none",
            border:"0.5px solid var(--color-border-secondary)", borderRadius:6,
            padding:"5px 12px", cursor:"pointer", color:"var(--color-text-secondary)", fontFamily:"inherit" }}>
            Reset defaults
          </button>
          <button onClick={save} style={{ fontSize:11, background: saved ? "#1D9E75" : "#378ADD", color:"#fff",
            border:"none", borderRadius:6, padding:"5px 14px", cursor:"pointer", fontFamily:"inherit",
            transition:"background 0.3s", fontWeight:500 }}>
            {saved ? "✓ Saved" : "Apply"}
          </button>
        </div>
      </div>
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--color-text-tertiary)", marginBottom:8 }}>Network & watchdog</div>
        <Row label="Watchdog timeout" desc="Seconds of silence before node marked offline" k="watchdogTimeout" min={5} max={60} unit="s" />
        <Row label="Packet loss window" desc="Time window for packet loss calculation" k="packetLossWindow" min={10} max={120} unit="s" />
      </div>
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--color-text-tertiary)", marginBottom:8 }}>RF & WiFi</div>
        <Row label="RSSI threshold" desc="Alert when WiFi RSSI drops below this" k="rssiThreshold" min={-100} max={-50} unit=" dBm" />
        <Row label="RSSI jump alert" desc="Alert on sudden RSSI drop larger than this" k="rssiJumpThreshold" min={5} max={40} unit=" dB" />
        <Row label="433 MHz threshold" desc="Alert when 433 signal drops below this" k="signal433Threshold" min={-100} max={-40} unit=" dBm" />
      </div>
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--color-text-tertiary)", marginBottom:8 }}>GPS / GNSS</div>
        <Row label="SNR L1 threshold" desc="GPS L1 interference alert below this" k="snrL1Threshold" min={5} max={50} unit=" dB-Hz" />
        <Row label="SNR L5 threshold" desc="GPS L5 interference alert below this" k="snrL5Threshold" min={5} max={50} unit=" dB-Hz" />
        <Row label="Satellite drop alert" desc="Alert when sat count drops by this many" k="satDropThreshold" min={1} max={10} unit=" sats" />
      </div>
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--color-text-tertiary)", marginBottom:8 }}>Environmental</div>
        <Row label="Temp jump alert" desc="Alert on temperature spike larger than this" k="tempJumpThreshold" min={1} max={20} unit="°C" />
      </div>
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--color-text-tertiary)", marginBottom:8 }}>Medical</div>
        <Row label="Heart rate min" desc="Alert when heart rate drops below this" k="heartRateMin" min={20} max={60} unit=" bpm" />
        <Row label="Heart rate max" desc="Alert when heart rate exceeds this" k="heartRateMax" min={80} max={200} unit=" bpm" />
        <Row label="SpO2 minimum" desc="Alert when blood oxygen drops below this" k="spo2Min" min={85} max={99} unit="%" />
      </div>
    </div>
  );
}

// Drone tab opens on its own when drones become active after this long without telemetry.
const DRONE_TAB_REARM_MS = 10000;

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function SmartCityMonitor() {
  const socket = useSocket(BACKEND_URL);
  const [nodes, setNodes]         = useState({});
  const [nodeDefs, setNodeDefs]   = useState({});
  const [events, setEvents]       = useState([]);
  const [config, setConfig]       = useState(DEFAULT_CONFIG);
  const [configDefaults, setConfigDefaults] = useState(null);
  const [rfHealthMap, setRfHealthMap] = useState({});
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedRfNode, setSelectedRfNode] = useState(null);
  const [droneState, setDroneState]     = useState({});   // latest telemetry per drone id
  const [droneEvents, setDroneEvents]   = useState([]);   // attack, halt, battery events
  const dronePathRef    = useRef({});  // flight path history — lifted so it survives tab switches
  const [droneMissions, setDroneMissions] = useState({}); // registered pre-flight missions per drone id
  const missionFetchedRef = useRef({});
  const prevDroneStatus = useRef({});  // tracks status transitions for path clearing
  const prevPositionRef = useRef({});  // tracks z-crossing for takeoff detection
  const lastDroneTelemRef = useRef(0); // when any drone last sent telemetry (auto-open of the Drone tab)
  const activeTabRef = useRef("overview");
  const historyRef = useRef({});
  const [pingTotal, setPingTotal] = useState(0);
  const [stageStatus, setStageStatus] = useState(null);
  const [activeAlerts, setActiveAlerts] = useState({ incidents: [], alerts: [] });
  const [eventStats, setEventStats] = useState(null); // counted in the backend's database for this session
  const [stageMode, setStageMode] = useState(false);
  const pingCountsRef      = useRef({}); // per-phone lifetime pings
  const pendingAudienceRef = useRef({}); // phone updates batched between flushes
  const audienceFlushRef   = useRef(null);

  const pushHistory = useCallback((nodeId, metrics) => {
    if (!historyRef.current[nodeId]) historyRef.current[nodeId] = {};
    Object.entries(metrics).forEach(([k, v]) => {
      if (typeof v !== "number") return;
      // New array each time: the chart library freezes arrays it has rendered,
      // so pushing into the old one throws and the sparkline stops updating.
      const prevHist = historyRef.current[nodeId][k] || [];
      historyRef.current[nodeId][k] = [...prevHist.slice(-49), { v, t: Date.now() }];
    });
  }, []);

  useEffect(() => {
    if (!socket) return;

    // Phones are batched and applied a few times a second, so hundreds of them
    // don't each re-render the whole dashboard. Sensor nodes are unchanged.
    const flushAudience = () => {
      audienceFlushRef.current = null;
      const batch = pendingAudienceRef.current;
      pendingAudienceRef.current = {};
      let added = 0;
      for (const [id, u] of Object.entries(batch)) {
        if (u.metrics.pings > 0) {
          pingCountsRef.current[id] = (pingCountsRef.current[id] || 0) + u.metrics.pings;
          added += u.metrics.pings;
        }
      }
      setNodes(prev => {
        const next = { ...prev };
        for (const [id, u] of Object.entries(batch)) {
          next[id] = { ...prev[id], ...u, metrics: { ...prev[id]?.metrics, ...u.metrics } };
        }
        return next;
      });
      if (added) setPingTotal(t => t + added);
    };

    const onUpdate = ({ nodeId, metrics, status, lastSeen, packetLoss, rfHealth }) => {
      if (isAudiencePhoneNode(nodeId)) {
        const prevPending = pendingAudienceRef.current[nodeId];
        const pings = (prevPending?.metrics?.pings || 0) + (metrics?.pings || 0);
        pendingAudienceRef.current[nodeId] = {
          status, lastSeen, packetLoss,
          metrics: { ...prevPending?.metrics, ...metrics, pings }, // pings set every time so old taps don't linger
        };
        if (!audienceFlushRef.current) audienceFlushRef.current = setTimeout(flushAudience, 250);
        return;
      }
      setNodes(prev => ({ ...prev, [nodeId]: {
        ...prev[nodeId], metrics: { ...prev[nodeId]?.metrics, ...metrics }, status, lastSeen, packetLoss
      }}));
      if (rfHealth) setRfHealthMap(prev => ({ ...prev, [nodeId]: { ...prev[nodeId], ...rfHealth } }));
      pushHistory(nodeId, metrics);
    };
    const onEvent   = (e)    => setEvents(prev => [...prev.slice(-99), e]);
    const onRecent  = (evts) => setEvents(evts);
    const onConfig  = (cfg)  => setConfig(cfg);
    const onRfFull  = (rfMap)=> setRfHealthMap(rfMap);

    const onDroneTelem = (data) => {
      const id = data.id;
      if (!id) return;

      // Drones just became active (first telemetry after 10 s of none): open the Drone tab once.
      // Switching away while they fly is respected; the next flight opens it again.
      // Not while you're editing Settings, so unsaved changes aren't lost.
      const nowMs = Date.now();
      if (nowMs - lastDroneTelemRef.current > DRONE_TAB_REARM_MS &&
          activeTabRef.current !== "settings") {
        setActiveTab("drone");
      }
      lastDroneTelemRef.current = nowMs;
      // The backend is tracking a mission this page never received (registered while the
      // page was loading): fetch missions once for this drone.
      if (data.pathCheck && !missionFetchedRef.current[id]) {
        missionFetchedRef.current[id] = true;
        fetch(`${BACKEND_URL}/api/drones`)
          .then(r => r.ok ? r.json() : {})
          .then(all => setDroneMissions(prev => ({
            ...prev,
            ...Object.fromEntries(Object.entries(all || {}).filter(([, d]) => d?.mission).map(([k, d]) => [k, d.mission])),
          })))
          .catch(() => { missionFetchedRef.current[id] = false; });
      }

      // Only responsibility: update drone state.
      // Path accumulation, clearing, and canvas redraw are handled entirely in DroneTab.
      setDroneState(prev => ({ ...prev, [id]: { ...data, lastSeen: new Date().toISOString() } }));

      const ts = new Date().toISOString();
      const now = Date.now();

      // halt flag is ML training label only — not reported to dashboard

      // ── Battery — three tiers ──────────────────────────────────────────────
      const bat = data.battery;
      if (bat != null && bat > 0) {
        let sev = null, msg = null;
        if      (bat < 3.2) { sev = "critical"; msg = `${id} battery critical: ${bat.toFixed(2)}V — landing imminent`; }
        else if (bat < 3.5) { sev = "warning";  msg = `${id} battery low: ${bat.toFixed(2)}V`; }
        else if (bat < 3.7) { sev = "info";     msg = `${id} battery at ${bat.toFixed(2)}V — monitor`; }
        if (sev) {
          setDroneEvents(prev => {
            // Deduplicate per tier — don't repeat same severity within 15s
            if (prev.some(e => e.node_id === id && e.type === "drone_battery" &&
              e.severity === sev && now - e.t < 15000)) return prev;
            return [...prev.slice(-99), {
              type: "drone_battery", node_id: id, id, severity: sev,
              message: msg, timestamp: ts, t: now
            }];
          });
        }
      }

      // ── Position info — log every 10 seconds per drone ────────────────────
      if (data.x != null && data.y != null && data.z != null) {
        setDroneEvents(prev => {
          const lastPos = prev.filter(e => e.node_id === id && e.type === "drone_position").slice(-1)[0];
          if (lastPos && now - lastPos.t < 10000) return prev;
          return [...prev.slice(-99), {
            type: "drone_position", node_id: id, id, severity: "info",
            message: `${id} position x:${data.x.toFixed(2)} y:${data.y.toFixed(2)} z:${data.z.toFixed(2)}m${data.yaw != null ? ` yaw:${data.yaw.toFixed(1)}°` : ""}`,
            timestamp: ts, t: now
          }];
        });
      }

      // ── Controller info — log on first appearance or change ───────────────
      if (data.controller) {
        setDroneEvents(prev => {
          const lastCtrl = prev.filter(e => e.node_id === id && e.type === "drone_controller").slice(-1)[0];
          if (lastCtrl && lastCtrl.message.includes(data.controller)) return prev;
          return [...prev.slice(-99), {
            type: "drone_controller", node_id: id, id, severity: "info",
            message: `${id} controller: ${data.controller}`,
            timestamp: ts, t: now
          }];
        });
      }
    };
    const onDroneState = (ds) => setDroneState(ds);
    const onDroneMission = ({ droneId, mission }) => {
      if (droneId) { missionFetchedRef.current[droneId] = true; setDroneMissions(prev => ({ ...prev, [droneId]: mission })); }
    };
    // Missions registered before this page loaded
    fetch(`${BACKEND_URL}/api/drones`)
      .then(r => r.ok ? r.json() : {})
      .then(all => setDroneMissions(prev => ({
        ...Object.fromEntries(Object.entries(all || {}).filter(([, d]) => d?.mission).map(([id, d]) => [id, d.mission])),
        ...prev,
      })))
      .catch(() => {});
    const onFull   = ({ nodes: n, nodeDefinitions: d, droneState: ds }) => {
      setNodes(n); setNodeDefs(d);
      if (ds) setDroneState(ds);
    };

    socket.on("state:full",      onFull);
    socket.on("node:update",     onUpdate);
    socket.on("event:new",       onEvent);
    socket.on("events:recent",   onRecent);
    socket.on("config:current",  onConfig);
    socket.on("config:defaults", setConfigDefaults);
    socket.on("rfhealth:full",   onRfFull);
    socket.on("drone:telemetry", onDroneTelem);
    socket.on("drone:state",     onDroneState);
    socket.on("drone:mission",   onDroneMission);
    const onStageStatus = (st) => setStageStatus(st);
    const onStageReset = () => {
      setEvents([]);
      setDroneMissions({});
      Object.keys(dronePathRef.current).forEach(k => { dronePathRef.current[k] = []; });
      missionFetchedRef.current = {};
      pingCountsRef.current = {};
      setPingTotal(0);
    };
    socket.on("stage:status",    onStageStatus);
    const onActiveAlerts = (payload) => setActiveAlerts(normalizeAlerts(payload));
    socket.on("alerts:active",   onActiveAlerts);
    const onEventStats = (st) => setEventStats(st);
    socket.on("events:stats",    onEventStats);
    socket.on("stage:reset",     onStageReset);

    return () => {
      clearTimeout(audienceFlushRef.current);
      audienceFlushRef.current = null;
      socket.off("state:full",      onFull);
      socket.off("node:update",     onUpdate);
      socket.off("event:new",       onEvent);
      socket.off("events:recent",   onRecent);
      socket.off("config:current",  onConfig);
      socket.off("config:defaults", setConfigDefaults);
      socket.off("rfhealth:full",   onRfFull);
      socket.off("drone:telemetry", onDroneTelem);
      socket.off("drone:state",     onDroneState);
      socket.off("drone:mission",   onDroneMission);
      socket.off("stage:status",    onStageStatus);
      socket.off("alerts:active",   onActiveAlerts);
      socket.off("events:stats",    onEventStats);
      socket.off("stage:reset",     onStageReset);
    };
  }, [socket, pushHistory]);

  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  const sendStageCommand = useCallback((cmd, jumpTo, onResult) => {
    if (!socket?.connected) { onResult?.({ ok: false, error: "dashboard is not connected to the backend" }); return; }
    socket.timeout(4000).emit("stage:command", cmd, (err, res) => {
      const result = err ? { ok: false, error: "backend did not answer" } : res;
      onResult?.(result);
      if (result?.ok && jumpTo) setActiveTab(jumpTo);
    });
  }, [socket]);

  const handleConfigUpdate = useCallback((updates) => {
    setConfig(updates);
    socket?.emit("config:update", updates);
  }, [socket]);

  // Sensor grid, counts, RF tab and explorer only cover the testbed's own nodes.
  const nodeIds = Object.keys(nodeDefs).filter(id => !isAudienceAny(id, nodeDefs[id]));
  const phoneIds = Object.keys(nodes).filter(isAudiencePhoneNode);
  // Audience section only appears once you open joining with the bridge running, and stays
  // (phones that left shown offline) until you press "Disconnect all phones".
  const bridgeStatus = stageStatus?.audience;
  const bridgeUp = bridgeStatus ? !!bridgeStatus.online : nodes["audience-bridge"]?.status === "online";
  const phonesLiveNow = phoneIds.filter(id => nodes[id]?.status === "online").length;
  const audienceActive = bridgeUp && (!!bridgeStatus?.joinOpen || phonesLiveNow > 0 || phoneIds.length > 0);
  const onlineCount   = nodeIds.filter(id => nodes[id]?.status === "online").length;
  // "Critical now" = active critical incidents and alerts (current state), not old events in the history.
  const { incidents: activeIncidents, alerts: activeAlertItems } = normalizeAlerts(activeAlerts);
  const criticalNow = activeIncidents.filter(i => i.state !== "recovering" && i.severity === "critical").length
    + activeAlertItems.filter(a => !a.incident && !a.stale && a.severity === "critical").length;
  const eventsLogged = eventStats ? eventStats.total : events.length;
  const disruptedCount= nodeIds.filter(id => isRfProblem(verdictOf(rfHealthMap[id], nodes[id]?.status))).length;
  // Same verdict the RF Analysis tab shows: online nodes the backend says are under interference.
  // (Falls back to recent interference events if the backend doesn't send verdicts.)
  const hasVerdicts = Object.values(rfHealthMap).some(r => r?.verdict);
  const interferenceNodes = new Set(hasVerdicts
    ? nodeIds.filter(id => rfHealthMap[id]?.verdict === "interference" && nodes[id]?.status === "online")
    : events.slice(-20)
        .filter(e => isInterferenceEvent(e) && eventAgeMs(e.timestamp) < 20000 && nodes[e.node_id]?.status === "online")
        .map(e => e.node_id));
  const interferenceActive = interferenceNodes.size > 0;

  const tabs = [
    { id:"overview",  label:"Overview" },
    { id:"sensors",   label:"Sensors" },
    { id:"gps",       label:"GPS" },
    { id:"rf",        label:`RF Analysis${disruptedCount > 0 ? ` (${disruptedCount})` : ""}` },
    { id:"events",    label:`Events${activeAlertCount(activeAlerts) > 0 ? ` · ${activeAlertCount(activeAlerts)} active` : ""}` },
    { id:"drone",     label:`Drone${Object.keys(droneState).length > 0 ? ` (${Object.keys(droneState).length})` : ""}` },
    { id:"explorer",  label:"Data Explorer" },
    { id:"settings",  label:"⚙ Settings" },
    { id:"stage",     label:"▶ Stage" },
  ];

  return (
    <div style={{ fontFamily:"'DM Mono','Fira Code','Courier New',monospace", padding:"16px 20px", minHeight:600,
      zoom: stageMode ? 1.3 : 1 }}>
      <style>{DASHBOARD_CSS}</style>
      {interferenceActive && <div className="if-page" aria-hidden="true" />}

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        marginBottom:20, paddingBottom:14, borderBottom:"0.5px solid var(--color-border-tertiary)" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:500, letterSpacing:"-0.01em" }}>Smart City Monitor</div>
          <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:2, letterSpacing:"0.04em" }}>RF TESTBED · LIVE</div>
                  </div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {interferenceActive && <span className="if-badge"><Badge text="INTERFERENCE ACTIVE" severity="critical" /></span>}
          {disruptedCount > 0 && <Badge text={`${disruptedCount} RF DISRUPTED`} severity="warning" />}
          <div style={{ display:"flex", alignItems:"center", gap:5, padding:"4px 10px",
            background:"var(--color-background-secondary)", borderRadius:20, fontSize:12 }}>
            <StatusDot status="online" />
            <span style={{ color:"var(--color-text-secondary)" }}>{onlineCount}/{nodeIds.length} nodes</span>
          </div>
          <button onClick={() => setStageMode(v => !v)} title="Larger text for the projector"
            style={{ fontSize:12, fontFamily:"inherit", padding:"4px 10px", borderRadius:20, cursor:"pointer",
              border: stageMode ? `1px solid ${AUDIENCE_COLOR}` : "0.5px solid var(--color-border-secondary)",
              background:"var(--color-background-secondary)",
              color: stageMode ? AUDIENCE_COLOR : "var(--color-text-secondary)" }}>
            {stageMode ? "Stage mode on" : "Stage mode"}
          </button>
        </div>
      </div>

      {/* Stat Bar */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:20 }}>
        {[
          { label:"Online",         value:onlineCount,                total:nodeIds.length, color:"#1D9E75" },
          { label:"RF Disrupted",   value:disruptedCount,             total:nodeIds.length, color:"#D85A30" },
          { label:"Critical now",   value:criticalNow,                total:null,            color: criticalNow > 0 ? "#E24B4A" : "#1D9E75" },
          { label:"Events logged",  value:eventsLogged,               total:null,            color:"#378ADD" },
        ].map(s => (
          <div key={s.label} style={{ background:"var(--color-background-secondary)", borderRadius:8, padding:"10px 12px" }}>
            <div style={{ fontSize:11, color:"var(--color-text-secondary)", marginBottom:4 }}>{s.label}</div>
            <div style={{ fontSize:22, fontWeight:500, color:s.color }}>
              {s.value}<span style={{ fontSize:12, color:"var(--color-text-tertiary)", fontWeight:400 }}>
                {s.total !== null ? `/${s.total}` : ""}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", marginBottom:16, borderBottom:"0.5px solid var(--color-border-tertiary)", flexWrap:"wrap" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            background:"none", border:"none",
            borderBottom: activeTab===t.id ? "2px solid var(--color-text-primary)" : "2px solid transparent",
            padding:"8px 14px", fontSize:12, cursor:"pointer", fontFamily:"inherit",
            fontWeight: activeTab===t.id ? 500 : 400,
            color: activeTab===t.id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
            letterSpacing:"0.03em", marginBottom:-1 }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Overview */}
      {activeTab === "overview" && (
        <div style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
          <div style={{ flex:1, minWidth:0 }}>
            <SectionHeader title="Node Grid"
              subtitle={`${nodeIds.length} sensors${Object.keys(droneState).length > 0 ? ` · ${Object.keys(droneState).length} drone${Object.keys(droneState).length!==1?"s":""}` : ""}`} />
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))", gap:10 }}>
              {nodeIds.map(id => (
                <NodeCard key={id} id={id} def={nodeDefs[id]||{}} state={nodes[id]}
                  histories={historyRef.current[id]||{}} rfHealth={rfHealthMap[id]}
                  interference={interferenceNodes.has(id)} />
              ))}
              {Object.entries(droneState).map(([id, drone]) => (
                <DroneCard key={id} id={id} drone={drone} events={events} />
              ))}
            </div>
            {audienceActive && (
              <div style={{ marginTop:22 }}>
                <AudiencePanel phoneIds={phoneIds} nodes={nodes} pingCounts={pingCountsRef.current} pingTotal={pingTotal} />
              </div>
            )}
          </div>
          <LiveEventRail events={events} title="Live events" emptyMsg="All clear" criticalNow={criticalNow} />
        </div>
      )}

      {/* Tab: Sensors */}
      {activeTab === "sensors" && (
        <div>
          <SectionHeader title="Sensor Feeds" subtitle="Live sparklines" />
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:16 }}>
            {nodeIds.filter(id => nodeDefs[id]?.type !== "gps").map(id => {
              const def   = nodeDefs[id] || {};
              const color = NODE_COLORS[def.type] || "#888";
              const m     = nodes[id]?.metrics || {};
              const hist  = historyRef.current[id] || {};
              return (
                <div key={id} style={{ background:"var(--color-background-primary)",
                  border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 16px",
                  filter: nodes[id]?.status === "online" ? "none" : "grayscale(1)", opacity: nodes[id]?.status === "online" ? 1 : 0.5,
                  transition:"filter 0.4s ease, opacity 0.4s ease" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                    <span style={{ fontSize:14, color }}>{NODE_ICONS[def.type]}</span>
                    <span style={{ fontSize:13, fontWeight:500 }}>{def.label}</span>
                    <StatusDot status={nodes[id]?.status || "offline"} />
                  </div>
                  {def.type==="hub"          && <><MetricRow label="Video FPS"  value={m.video_fps}  unit="fps" color={color} sparkData={hist.video_fps}  /><MetricRow label="Audio"      value={m.audio_db}   unit="dB"  color={color} sparkData={hist.audio_db}   /><MetricRow label="RSSI"       value={m.wifi_rssi}  unit="dBm" color={color} sparkData={hist.wifi_rssi}  /></>}
                  {def.type==="environmental"&& <><MetricRow label="Temp"       value={m.temperature} unit="°C" color={color} sparkData={hist.temperature}/><MetricRow label="Humidity"   value={m.humidity}   unit="%"   color={color} sparkData={hist.humidity}    /><MetricRow label="RSSI"       value={m.wifi_rssi}  unit="dBm" color={color} sparkData={hist.wifi_rssi}  /></>}
                  {def.type==="medical"      && <><MetricRow label="Heart Rate" value={m.heart_rate} unit="bpm" color={color} sparkData={hist.heart_rate} /><MetricRow label="SpO2"      value={m.spo2}       unit="%"   color={color} sparkData={hist.spo2}        /><MetricRow label="RSSI"       value={m.wifi_rssi}  unit="dBm" color={color} sparkData={hist.wifi_rssi}  /></>}
                  {def.type==="automation"   && <><MetricRow label="Plug"       value={m.plug_state}  unit=""   color={color} /><MetricRow label="RSSI"        value={m.wifi_rssi}  unit="dBm" color={color} sparkData={hist.wifi_rssi}  /></>}
                  {def.type==="traffic"      && <><div style={{ padding:"8px 0" }}><TrafficLight state={m.light_state} /></div><MetricRow label="RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={hist.wifi_rssi} /></>}
                  {def.type==="security"     && <><MetricRow label="Motion"     value={m.motion_detected?"DETECTED":"clear"} unit="" color={color} /><MetricRow label="Door" value={m.door_open?"OPEN":"closed"} unit="" color={color} /><MetricRow label="433 Signal" value={m.signal_433} unit="dBm" color={color} sparkData={hist.signal_433} /></>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab: GPS */}
      {activeTab === "gps" && (
        <div>
          <SectionHeader title="GPS / GNSS Node" subtitle="SparkFun NEO-F10N · L1/L5" />
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:16 }}>
              <div style={{ fontSize:12, color:"var(--color-text-secondary)", marginBottom:12, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em" }}>Lock & Satellites</div>
              <GPSPanel metrics={nodes["gps-node"]?.metrics} />
            </div>
            <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:16 }}>
              <div style={{ fontSize:12, color:"var(--color-text-secondary)", marginBottom:8, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em" }}>SNR History</div>
              <div style={{ marginBottom:4 }}>
                <span style={{ fontSize:11, color:"#0F6E56" }}>● L1 </span>
                <span style={{ fontSize:11, color:"#378ADD" }}>● L5</span>
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={(historyRef.current["gps-node"]?.snr_l1||[]).map((d,i) => ({
                  t:i, l1:d.v, l5:(historyRef.current["gps-node"]?.snr_l5||[])[i]?.v }))}>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0,50]} tick={{ fontSize:10 }} width={28} />
                  <Tooltip formatter={v => v?.toFixed(1)} labelFormatter={() => ""} contentStyle={{ fontSize:11 }} />
                  <Line type="monotone" dataKey="l1" stroke="#0F6E56" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="l5" stroke="#378ADD" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:16, gridColumn:"span 2" }}>
              <div style={{ fontSize:12, color:"var(--color-text-secondary)", marginBottom:8, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em" }}>Satellite Count History</div>
              <ResponsiveContainer width="100%" height={100}>
                <AreaChart data={historyRef.current["gps-node"]?.satellites||[]}>
                  <defs>
                    <linearGradient id="satGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#0F6E56" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#0F6E56" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0,14]} tick={{ fontSize:10 }} width={24} />
                  <Tooltip formatter={v => Math.round(v)} labelFormatter={() => ""} contentStyle={{ fontSize:11 }} />
                  <Area type="monotone" dataKey="v" stroke="#0F6E56" strokeWidth={1.5} fill="url(#satGrad)" dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Tab: RF Analysis */}
      {activeTab === "rf" && (
        <RfAnalysisTab nodeIds={nodeIds} nodeDefs={nodeDefs} nodes={nodes} rfHealthMap={rfHealthMap}
          selectedNode={selectedRfNode} setSelectedNode={setSelectedRfNode} />
      )}

      {/* Tab: Events */}
      {activeTab === "events" && (
        <div>
          <ActiveAlertsPanel alerts={activeAlerts} nodeDefs={nodeDefs} />
          <SectionHeader title="Event Log"
            subtitle={eventStats
              ? `${eventStats.total} logged this session · ${eventStats.critical} critical${eventStats.total > events.length ? ` · showing latest ${events.length}` : ""}`
              : `${events.length} events`} right={
            <button onClick={() => setEvents([])} style={{ fontSize:11, background:"none",
              border:"0.5px solid var(--color-border-secondary)", borderRadius:6,
              padding:"3px 10px", cursor:"pointer", color:"var(--color-text-secondary)", fontFamily:"inherit" }}>
              Clear
            </button>} />
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, overflow:"hidden" }}>
            <EventFeed events={events} nodes={nodes} config={config} />
          </div>
        </div>
      )}

      {/* Tab: Stage (presenter controls) */}
      {activeTab === "stage" && (
        <StagePanel status={stageStatus} onCommand={sendStageCommand}
          phonesLive={phoneIds.filter(id => nodes[id]?.status === "online").length} />
      )}

      {/* Tab: Settings */}
      {activeTab === "settings" && (
        <SettingsPanel config={config} defaults={configDefaults} onUpdate={handleConfigUpdate} />
      )}

      {/* Tab: Data Explorer */}
      {activeTab === "explorer" && (
        <div>
          <SectionHeader title="Data Explorer"
            subtitle="Query the monitoring API — click any endpoint to open it" />

          {/* Node endpoints */}
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
            borderRadius:12, padding:"14px 16px", marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:500, color:"var(--color-text-tertiary)",
              textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>
              Node data
            </div>
            {[
              { label:"All nodes — current state",        path:"/api/nodes" },
              { label:"Full system state",                path:"/api/state" },
              { label:"Current layout definition",        path:"/api/layout" },
            ].map(e => (
              <ApiRow key={e.path} label={e.label} path={e.path} />
            ))}

            {/* Per-node history endpoints */}
            <div style={{ fontSize:11, color:"var(--color-text-tertiary)", margin:"10px 0 6px",
              paddingTop:8, borderTop:"0.5px solid var(--color-border-tertiary)" }}>
              Per-node history — click a node then a metric:
            </div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:8 }}>
              {nodeIds.map(id => (
                <div key={id} style={{ background:"var(--color-background-secondary)",
                  border:"0.5px solid var(--color-border-tertiary)", borderRadius:8, padding:"6px 10px" }}>
                  <div style={{ fontSize:11, fontWeight:500, color:"var(--color-text-primary)",
                    marginBottom:4 }}>{nodeDefs[id]?.label || id}</div>
                  {(nodeDefs[id]?.metrics || ["wifi_rssi"]).map(metric => (
                    <ApiRow key={metric} label={metric}
                      path={`/api/nodes/${id}/history?metric=${metric}&limit=200`}
                      compact />
                  ))}
                  <ApiRow label="RF health" path={`/api/nodes/${id}/rf-health`} compact />
                </div>
              ))}
            </div>
          </div>

          {/* Events */}
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
            borderRadius:12, padding:"14px 16px", marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:500, color:"var(--color-text-tertiary)",
              textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>
              Events
            </div>
            {[
              { label:"All recent events (last 50)",       path:"/api/events" },
              { label:"Critical events only",              path:"/api/events?severity=critical" },
              { label:"Warning events only",               path:"/api/events?severity=warning" },
              { label:"Interference events only",          path:"/api/events?type=interference" },
            ].map(e => (
              <ApiRow key={e.path} label={e.label} path={e.path} />
            ))}
          </div>

          {/* Config */}
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
            borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:11, fontWeight:500, color:"var(--color-text-tertiary)",
              textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>
              System
            </div>
            {[
              { label:"Current monitoring config",         path:"/api/config" },
            ].map(e => (
              <ApiRow key={e.path} label={e.label} path={e.path} />
            ))}
          </div>
        </div>
      )}

      {/* Tab: Drone */}
      {activeTab === "drone" && (() => {
        const droneOnlyEvents = events.filter(e =>
          e.type === "drone_off_path" || e.type === "drone_telemetry_lost" ||
          e.type === "drone_telemetry_recovered" || e.type === "drone_battery" ||
          e.type === "drone_info" || e.type === "drone_mission_complete" ||
          e.type === "drone_landed" || (e.node_id && e.node_id.startsWith("cf-"))
        );
        return (
          <div style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <DroneTab
                droneState={droneState}
                droneEvents={droneOnlyEvents}
                dronePathRef={dronePathRef}
                prevDroneStatus={prevDroneStatus}
                prevPositionRef={prevPositionRef}
                events={droneOnlyEvents}
                droneMissions={droneMissions}
              />
            </div>
            <LiveEventRail
              events={droneOnlyEvents}
              title="Drone events"
              emptyMsg="No events — normal operation"
              criticalNow={activeAlertItems.filter(a => droneState[a.nodeId] && !a.stale && a.severity === "critical").length}
            />
          </div>
        );
      })()}
     

      {/* Footer */}
      <div style={{ marginTop:24, paddingTop:12, borderTop:"0.5px solid var(--color-border-tertiary)",
        display:"flex", justifyContent:"flex-end" }}>
        <span style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>
          Smart City RF Testbed · OCII · {new Date().getFullYear()}
        </span>
      </div>
    </div>
  );
}

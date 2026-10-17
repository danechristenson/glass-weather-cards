/*
 * Glass Weather Cards for Home Assistant
 *
 *   custom:glass-weather-now     current conditions, today's high and low, details
 *   custom:glass-weather-hourly  the next hours: an icon per hour, a temperature wave, rain chances
 *   custom:glass-weather-week    the days ahead, one slim row each
 *   custom:glass-frost           wraps any card in the same frosted glass
 *
 * plus a dashboard strategy, custom:glass-weather-calendar, that builds a calendar page
 * around them. Forecasts come straight from the weather entity (weather/subscribe_forecast),
 * so any weather integration works. No build step, no dependencies.
 */

const VERSION = "0.1.1";

const ICONS = {
  "clear-night": "mdi:weather-night", cloudy: "mdi:weather-cloudy", exceptional: "mdi:alert-circle-outline",
  fog: "mdi:weather-fog", hail: "mdi:weather-hail", lightning: "mdi:weather-lightning",
  "lightning-rainy": "mdi:weather-lightning-rainy", partlycloudy: "mdi:weather-partly-cloudy",
  pouring: "mdi:weather-pouring", rainy: "mdi:weather-rainy", snowy: "mdi:weather-snowy",
  "snowy-rainy": "mdi:weather-snowy-rainy", sunny: "mdi:weather-sunny", windy: "mdi:weather-windy",
  "windy-variant": "mdi:weather-windy-variant",
};
const NIGHT_ICONS = { partlycloudy: "mdi:weather-night-partly-cloudy", sunny: "mdi:weather-night" };

// One look for every card: frosted glass, and one colour per kind of weather
const GLASS_CSS = `
  :host { display: block; height: 100%; }
  ha-card {
    height: 100%; box-sizing: border-box; overflow: hidden;
    background: rgba(var(--rgb-card-background-color, 28, 28, 28), var(--glass-weather-alpha, 0.55));
    backdrop-filter: blur(var(--glass-weather-blur, 8px));
    -webkit-backdrop-filter: blur(var(--glass-weather-blur, 8px));
  }
  ha-icon { color: #cfd8dc; }
  ha-icon[icon$="sunny"] { color: #ffca28; }
  ha-icon[icon$="partly-cloudy"] { color: #ffe082; }
  ha-icon[icon$="night"], ha-icon[icon$="night-partly-cloudy"] { color: #b3c3ff; }
  ha-icon[icon*="rainy"], ha-icon[icon$="pouring"] { color: #4fc3f7; }
  ha-icon[icon*="snowy"], ha-icon[icon$="hail"] { color: #e1f5fe; }
  ha-icon[icon*="lightning"] { color: #ffd54f; }
  .precip { color: #4fc3f7; }
  .muted { opacity: 0.6; }
`;

const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usable = (state) => state && !["unknown", "unavailable", ""].includes(state.state);
const num = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const round = (v) => (num(v) === null ? null : Math.round(Number(v)));

// Is it night at this time? Uses the sun entity's next rising and setting
function nightAt(hass, time) {
  const sun = hass.states["sun.sun"]?.attributes;
  if (!sun?.next_rising || !sun?.next_setting) {
    const h = time.getHours();
    return h < 7 || h >= 19;
  }
  const rise = new Date(sun.next_rising), set = new Date(sun.next_setting);
  return set < rise ? time >= set && time < rise : time < rise || time >= set;
}

function iconFor(condition, night) {
  return (night && NIGHT_ICONS[condition]) || ICONS[condition] || "mdi:weather-partly-cloudy";
}

// Base class: config, hass, forecast subscriptions and rendering into a shadow root
class GlassWeatherBase extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._forecasts = {};
    this._unsubs = [];
  }

  // Forecast types the card needs, e.g. ["daily"]
  get forecastTypes() { return []; }

  setConfig(config) {
    if (!config?.entity || !config.entity.startsWith("weather.")) {
      throw new Error("Set 'entity' to a weather entity, e.g. weather.home");
    }
    const changed = this._config?.entity !== config.entity;
    this._config = config;
    if (changed) this._resubscribe();
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._resubscribe();
    this._render();
  }

  connectedCallback() { if (this._hass && !this._unsubs.length) this._resubscribe(); }

  disconnectedCallback() { this._unsubscribe(); }

  _unsubscribe() {
    this._unsubs.forEach((u) => u.then((f) => f()).catch(() => {}));
    this._unsubs = [];
  }

  _resubscribe() {
    if (!this._hass || !this._config || !this.isConnected) return;
    this._unsubscribe();
    for (const type of this.forecastTypes) {
      this._unsubs.push(this._hass.connection.subscribeMessage((msg) => {
        this._forecasts[type] = msg.forecast || [];
        this._render();
      }, { type: "weather/subscribe_forecast", forecast_type: type, entity_id: this._config.entity }));
    }
  }

  _render() {
    if (!this._hass || !this._config) return;
    const html = this.renderHTML();
    if (html === this._last) return;
    this._last = html;
    this.shadowRoot.innerHTML = `<style>${GLASS_CSS}${this.css || ""}</style>${html}`;
    this.afterRender?.();
  }

  _state(id) { return id ? this._hass.states[id] : undefined; }
}

/* ---------- now ---------- */

class GlassWeatherNow extends GlassWeatherBase {
  get forecastTypes() { return ["daily"]; }

  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { domain: "weather" } } },
        { name: "summary_entity", selector: { entity: {} } },
        { name: "yard_entity", selector: { entity: { domain: "sensor", device_class: "temperature" } } },
        { type: "expandable", name: "", flatten: true, title: "Extra details", schema: [
          { name: "feels_like_entities", selector: { entity: { multiple: true, domain: "sensor" } } },
          { name: "wind_gust_entity", selector: { entity: { domain: "sensor" } } },
          { name: "pressure_tendency_entity", selector: { entity: { domain: "sensor" } } },
          { name: "uv_entity", selector: { entity: { domain: "sensor" } } },
          { name: "air_quality_entity", selector: { entity: { domain: "sensor" } } },
          { name: "alert_entities", selector: { entity: { multiple: true, domain: "sensor" } } },
        ] },
        { name: "tap_action", selector: { ui_action: {} } },
      ],
      computeLabel: (s) => ({
        entity: "Weather", summary_entity: "Forecast text (optional)", yard_entity: "Your own outdoor temperature (optional)",
        feels_like_entities: "Feels like (first available: wind chill, humidex...)", wind_gust_entity: "Wind gusts",
        pressure_tendency_entity: "Pressure tendency (rising/falling)", uv_entity: "UV index", air_quality_entity: "Air quality",
        alert_entities: "Weather alerts (counts; titles from attributes)", tap_action: "Tap action",
      }[s.name]),
    };
  }

  static getStubConfig(hass) {
    return { entity: Object.keys(hass.states).find((e) => e.startsWith("weather.")) || "weather.home" };
  }

  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.addEventListener("click", this._onClick ||= () => this._tap());
  }

  _tap() {
    const action = this._config.tap_action || { action: "more-info" };
    if (action.action === "none") return;
    if (action.action === "navigate" && action.navigation_path) {
      history.pushState(null, "", action.navigation_path);
      window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
      return;
    }
    if (action.action === "url" && action.url_path) { window.open(action.url_path); return; }
    this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: this._config.entity } }));
  }

  get css() {
    return `
      ha-card { padding: 12px 16px; cursor: pointer; }
      .top { display: flex; align-items: center; gap: 12px; }
      .top > ha-icon { --mdc-icon-size: 48px; }
      .temp { font-size: 2.6em; font-weight: 500; line-height: 1; }
      .range { font-size: 1.1em; opacity: 0.85; }
      .yard { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; font-size: 1.6em; line-height: 1.1; opacity: 0.55; }
      .yard small { font-size: 0.45em; text-transform: uppercase; letter-spacing: 0.08em; }
      .sum { margin-top: 6px; font-size: 1.05em; }
      .details { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px 12px; margin-top: 8px; font-size: 0.9em; opacity: 0.9; }
      .details span { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
      .details ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); }
      ha-alert { display: block; margin-bottom: 8px; }
    `;
  }

  renderHTML() {
    const c = this._config, hass = this._hass, w = this._state(c.entity);
    if (!w) return `<ha-card><div class="sum">${escape(c.entity)} not found</div></ha-card>`;
    const a = w.attributes, unit = a.temperature_unit || "°";
    const val = (id) => (usable(this._state(id)) ? this._state(id).state : null);
    const now = new Date();
    // today's high and low: the first daily entry for today (a "tonight" entry has no high)
    const daily = this._forecasts.daily || [];
    const today = daily.find((f) => new Date(f.datetime).toDateString() === now.toDateString()) || daily[0];
    const high = round(today?.temperature), low = round(today?.templow);
    const range = [high !== null ? `High ${high}°` : "", low !== null ? `Low ${low}°` : ""].filter(Boolean).join(" · ");
    // alerts
    const alerts = (c.alert_entities || []).flatMap((id) => {
      const s = this._state(id);
      if (!s || !(num(s.state) > 0)) return [];
      const kind = id.includes("warning") ? "error" : id.includes("watch") ? "warning" : "info";
      return Object.entries(s.attributes).filter(([k, v]) => typeof v === "string" && !/time|friendly_name|icon|attribution|unit/.test(k))
        .map(([, v]) => `<ha-alert alert-type="${kind}">${escape(v)}</ha-alert>`);
    }).join("");
    // details
    const feels = (c.feels_like_entities || []).map(val).find((v) => v !== null) ?? a.apparent_temperature;
    const gust = val(c.wind_gust_entity) ?? a.wind_gust_speed;
    const trend = { rising: "↑", falling: "↓", steady: "→" }[String(val(c.pressure_tendency_entity) || "").toLowerCase()] || "";
    const sun = hass.states["sun.sun"]?.attributes || {};
    const time = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const compass = (b) => (num(b) === null ? "" : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(Number(b) / 45) % 8]);
    const items = [
      num(feels) !== null && ["mdi:thermometer", `Feels like ${round(feels)}°`],
      num(a.humidity) !== null && ["mdi:water-percent", `Humidity ${round(a.humidity)}%`],
      num(a.wind_speed) !== null && ["mdi:weather-windy", `Wind ${compass(a.wind_bearing)} ${round(a.wind_speed)} ${a.wind_speed_unit || ""}${num(gust) !== null ? `, gusts ${round(gust)}` : ""}`],
      num(a.pressure) !== null && ["mdi:gauge", `${a.pressure} ${a.pressure_unit || ""} ${trend}`],
      val(c.uv_entity) !== null && ["mdi:sun-wireless", `UV ${val(c.uv_entity)}`],
      val(c.air_quality_entity) !== null && ["mdi:air-filter", `Air quality ${round(val(c.air_quality_entity))}`],
      sun.next_rising && ["mdi:weather-sunset-up", `Sunrise ${time(sun.next_rising)}`],
      sun.next_setting && ["mdi:weather-sunset-down", `Sunset ${time(sun.next_setting)}`],
    ].filter(Boolean).map(([i, t]) => `<span><ha-icon icon="${i}"></ha-icon>${escape(t)}</span>`).join("");
    const yard = c.yard_entity !== undefined
      ? `<span class="yard"><small>Yard</small>${val(c.yard_entity) !== null ? `${round(val(c.yard_entity))}°` : "—"}</span>` : "";
    const summary = val(c.summary_entity) || "";
    return `<ha-card>${alerts}
      <div class="top"><ha-icon icon="${iconFor(w.state, nightAt(hass, now))}"></ha-icon>
        <span class="temp">${round(a.temperature) ?? "–"}°</span><span class="range">${escape(range)}</span>${yard}</div>
      ${summary ? `<div class="sum">${escape(summary)}</div>` : ""}
      <div class="details">${items}</div></ha-card>`;
  }
}

/* ---------- hourly ---------- */

class GlassWeatherHourly extends GlassWeatherBase {
  get forecastTypes() { return ["hourly"]; }

  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { domain: "weather" } } },
        { name: "hours", selector: { number: { min: 6, max: 48, mode: "box" } } },
      ],
      computeLabel: (s) => ({ entity: "Weather", hours: "Hours to show (default 24)" }[s.name]),
    };
  }

  static getStubConfig(hass) { return { ...GlassWeatherNow.getStubConfig(hass), hours: 24 }; }

  getGridOptions() { return { columns: 24, rows: "auto", min_columns: 6 }; }

  get css() {
    return `
      ha-card { padding: 12px 8px; }
      .scroll { overflow-x: auto; }
      .grid { display: grid; row-gap: 4px; align-items: center; text-align: center; font-size: 0.85em; }
      .time { opacity: 0.7; }
      .grid ha-icon { --mdc-icon-size: 24px; }
      .wave { width: 100%; height: 60px; }
      .temp { font-weight: 600; }
      .rain { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; min-height: 34px; color: #4fc3f7; }
      .bar { width: 60%; background: #4fc3f7; opacity: 0.55; border-radius: 2px; margin-bottom: 2px; }
    `;
  }

  renderHTML() {
    const now = Date.now() - 59 * 60 * 1000;
    const hours = (this._forecasts.hourly || []).filter((f) => new Date(f.datetime).getTime() >= now).slice(0, this._config.hours || 24);
    if (!hours.length) return `<ha-card><div class="time">Waiting for the hourly forecast…</div></ha-card>`;
    const n = hours.length, times = hours.map((h) => new Date(h.datetime));
    const temps = hours.map((h) => Number(h.temperature));
    const lo = Math.min(...temps), hi = Math.max(...temps), span = Math.max(hi - lo, 1);
    const points = temps.map((v, i) => `${(i + 0.5) * 10},${(5 + (1 - (v - lo) / span) * 40).toFixed(1)}`).join(" ");
    const row = (cls, fn) => hours.map((h, i) => `<div class="${cls}">${fn(h, i)}</div>`).join("");
    const rain = (h) => {
      const p = num(h.precipitation_probability);
      if (p) return `<div class="bar" style="height:${Math.max(3, p * 0.3)}px"></div><small>${round(p)}%</small>`;
      const mm = num(h.precipitation);
      return mm ? `<div class="bar" style="height:${Math.min(30, 3 + mm * 6)}px"></div><small>${mm}</small>` : "";
    };
    return `<ha-card><div class="scroll"><div class="grid" style="grid-template-columns: repeat(${n}, minmax(30px, 1fr))">
      ${row("time", (h, i) => String(times[i].getHours()).padStart(2, "0"))}
      ${row("icon", (h, i) => `<ha-icon icon="${iconFor(h.condition, nightAt(this._hass, times[i]))}"></ha-icon>`)}
      <svg class="wave" style="grid-column: 1 / span ${n}" viewBox="0 0 ${n * 10} 50" preserveAspectRatio="none">
        <polyline points="${points}" fill="none" stroke="#ffb74d" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      </svg>
      ${row("temp", (h) => `${round(h.temperature)}°`)}
      ${row("rain", rain)}
    </div></div></ha-card>`;
  }
}

/* ---------- week ---------- */

class GlassWeatherWeek extends GlassWeatherBase {
  get forecastTypes() { return ["daily"]; }

  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { domain: "weather" } } },
        { name: "days", selector: { number: { min: 3, max: 14, mode: "box" } } },
      ],
      computeLabel: (s) => ({ entity: "Weather", days: "Days to show (default 7)" }[s.name]),
    };
  }

  static getStubConfig(hass) { return { ...GlassWeatherNow.getStubConfig(hass), days: 7 }; }

  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

  get css() {
    return `
      ha-card { padding: 8px 12px; display: flex; }
      table { width: 100%; height: 100%; border-collapse: collapse; }
      td { padding: 1px 4px; line-height: 1.3; }
      td ha-icon { --mdc-icon-size: 22px; }
      td.r { text-align: right; white-space: nowrap; }
    `;
  }

  renderHTML() {
    const today = new Date().toDateString();
    // skip a leftover "tonight" entry (no high) and anything before today
    const days = (this._forecasts.daily || [])
      .filter((f) => f.temperature !== null && f.temperature !== undefined)
      .filter((f) => new Date(f.datetime) >= new Date(new Date().toDateString()) || new Date(f.datetime).toDateString() === today)
      .slice(0, this._config.days || 7);
    if (!days.length) return `<ha-card><div class="muted">Waiting for the daily forecast…</div></ha-card>`;
    const rows = days.map((f) => {
      const d = new Date(f.datetime);
      const name = d.toDateString() === today ? "Today" : d.toLocaleDateString([], { weekday: "short" });
      const p = num(f.precipitation_probability), mm = num(f.precipitation);
      const precip = p ? `${round(p)}%` : mm ? `${mm} ${this._hass.states[this._config.entity]?.attributes.precipitation_unit || "mm"}` : "";
      return `<tr><td width="30"><ha-icon icon="${iconFor(f.condition, false)}"></ha-icon></td><td><b>${escape(name)}</b></td>
        <td class="r precip"><small>${escape(precip)}</small></td>
        <td class="r" width="70"><b>${round(f.temperature)}°</b> ${f.templow !== undefined && f.templow !== null ? `<small class="muted">${round(f.templow)}°</small>` : ""}</td></tr>`;
    }).join("");
    return `<ha-card><table>${rows}</table></ha-card>`;
  }
}

/* ---------- frost: any card in the same glass ---------- */

class GlassFrost extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>
      :host { display: block; height: 100%; }
      /* blur what's behind, and make the wrapped card's own background see-through: every
         Home Assistant card draws its background from --ha-card-background */
      .glass { height: 100%; border-radius: var(--ha-card-border-radius, 12px); overflow: hidden;
        backdrop-filter: blur(var(--glass-weather-blur, 8px)); -webkit-backdrop-filter: blur(var(--glass-weather-blur, 8px));
        --ha-card-background: rgba(var(--rgb-card-background-color, 28, 28, 28), var(--glass-weather-alpha, 0.55)); }
      :host([background]) .glass { border-radius: 0; }
    </style><div class="glass"></div>`;
  }

  setConfig(config) {
    if (!config?.card) throw new Error("Set 'card' to the card to wrap");
    this._config = config;
    // background: true fixes the wrapped card behind the whole page (e.g. an animated sky)
    this.style.cssText = config.background ? "position: fixed; inset: 0; z-index: -1; height: 100vh;" : "";
    this.toggleAttribute("background", !!config.background);
    this._build();
  }

  async _build() {
    const helpers = await window.loadCardHelpers();
    this._card = helpers.createCardElement(this._config.card);
    if (this._hass) this._card.hass = this._hass;
    const box = this.shadowRoot.querySelector(".glass");
    box.replaceChildren(this._card);
  }

  set hass(hass) { this._hass = hass; if (this._card) this._card.hass = hass; }

  getCardSize() { return this._card?.getCardSize?.() ?? 4; }

  getGridOptions() { return this._card?.getGridOptions?.() ?? { columns: "full" }; }
}

/* ---------- dashboard strategy: a calendar page with the weather ---------- */

class GlassWeatherCalendarStrategy extends HTMLElement {
  static async generate(config, hass) {
    const entity = config.weather_entity || Object.keys(hass.states).find((e) => e.startsWith("weather."));
    const calendars = config.calendars || Object.keys(hass.states).filter((e) => e.startsWith("calendar."));
    // Optional cards (credited in the README) are used when installed. Dashboard resources load
    // alongside this strategy, so give each a moment to register before deciding.
    const available = (tag) => Promise.race([
      customElements.whenDefined(tag).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    const [sky, daylight, bubble] = await Promise.all(
      ["dynamic-weather-card", "daylight-calendar-card", "bubble-card"].map(available));

    const now = { type: "custom:glass-weather-now", entity, ...(config.now || {}), grid_options: { columns: 12, rows: "auto" } };
    if (bubble) now.tap_action = { action: "navigate", navigation_path: "#weather" };
    const top = [now,
      { type: "custom:glass-weather-hourly", entity, hours: 24, grid_options: { columns: 24, rows: "auto" } },
      { type: "custom:glass-weather-week", entity, days: 7, grid_options: { columns: 12, rows: "auto" } }];
    if (config.background !== false && sky) {
      top.unshift({ type: "custom:glass-frost", background: true, card: { type: "custom:dynamic-weather-card", entity,
        name: "", height: 1440, border_radius: 0, overlay_opacity: 0.25, animation_quality: "medium",
        tap_action: { action: "none" }, styles: ".content, .header { display: none !important; }" } });
    }
    const calendar = daylight
      ? { type: "glass-frost", card: { type: "custom:daylight-calendar-card", entities: calendars, default_view: "month",
            compact_height: true, background_opacity: 50, header_background_opacity: 45 }, grid_options: { columns: "full", rows: 16 } }
      : { type: "glass-frost", card: { type: "calendar", entities: calendars, initial_view: "dayGridMonth" }, grid_options: { columns: "full", rows: 12 } };
    calendar.type = "custom:glass-frost";
    const sections = [
      { type: "grid", column_span: 4, cards: top },
      { type: "grid", column_span: 4, cards: [calendar] },
    ];
    if (config.shopping_list) {
      sections.push({ type: "grid", column_span: 1, cards: [{ type: "custom:glass-frost",
        card: { type: "todo-list", entity: config.shopping_list }, grid_options: { columns: "full", rows: "auto" } }] });
    }
    if (bubble) {
      sections.push({ type: "grid", column_span: 1, cards: [{ type: "custom:bubble-card", card_type: "pop-up", hash: "#weather",
        name: "Weather", icon: "mdi:weather-partly-cloudy", width_desktop: "960px",
        cards: [{ type: "custom:glass-weather-hourly", entity, hours: 48 }, { type: "custom:glass-weather-week", entity, days: 14 }] }] });
    }
    return { views: [{ title: config.title || "Calendar", path: "calendar", type: "sections", max_columns: 4, sections }] };
  }
}

/* ---------- register ---------- */

const define = (tag, cls) => { if (!customElements.get(tag)) customElements.define(tag, cls); };
define("glass-weather-now", GlassWeatherNow);
define("glass-weather-hourly", GlassWeatherHourly);
define("glass-weather-week", GlassWeatherWeek);
define("glass-frost", GlassFrost);
define("ll-strategy-dashboard-glass-weather-calendar", GlassWeatherCalendarStrategy);

const docs = "https://github.com/danechristenson/glass-weather-cards";
const suggest = (type, extra = {}) => (hass, entityId) =>
  entityId.startsWith("weather.") ? { config: { type: `custom:${type}`, entity: entityId, ...extra } } : null;
window.customCards = window.customCards || [];
window.customCards.push(
  { type: "glass-weather-now", name: "Glass weather: now", description: "Current conditions, today's high and low, details.", preview: true, documentationURL: docs, getEntitySuggestion: suggest("glass-weather-now") },
  { type: "glass-weather-hourly", name: "Glass weather: hourly", description: "An icon per hour with a temperature wave and rain chances.", preview: true, documentationURL: docs, getEntitySuggestion: suggest("glass-weather-hourly", { hours: 24 }) },
  { type: "glass-weather-week", name: "Glass weather: week", description: "The days ahead, one slim row each.", preview: true, documentationURL: docs, getEntitySuggestion: suggest("glass-weather-week", { days: 7 }) },
  { type: "glass-frost", name: "Glass frost", description: "Wraps any card in the same frosted glass.", documentationURL: docs },
);
window.customStrategies = window.customStrategies || [];
window.customStrategies.push({ type: "glass-weather-calendar", strategyType: "dashboard", name: "Glass weather calendar",
  description: "Your calendars with the weather across the top, in frosted glass.", documentationURL: docs });

console.info(`%c GLASS-WEATHER-CARDS %c ${VERSION} `, "color: #fff; background: #4fc3f7; font-weight: 600", "color: #4fc3f7");

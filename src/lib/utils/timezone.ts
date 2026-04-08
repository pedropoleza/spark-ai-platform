// Mapa de estados dos EUA para timezone
const US_STATE_TIMEZONES: Record<string, string> = {
  // Eastern
  "CT": "America/New_York", "DE": "America/New_York", "FL": "America/New_York",
  "GA": "America/New_York", "IN": "America/Indiana/Indianapolis", "KY": "America/New_York",
  "ME": "America/New_York", "MD": "America/New_York", "MA": "America/New_York",
  "MI": "America/Detroit", "NH": "America/New_York", "NJ": "America/New_York",
  "NY": "America/New_York", "NC": "America/New_York", "OH": "America/New_York",
  "PA": "America/New_York", "RI": "America/New_York", "SC": "America/New_York",
  "VT": "America/New_York", "VA": "America/New_York", "WV": "America/New_York",
  "DC": "America/New_York",
  // Central
  "AL": "America/Chicago", "AR": "America/Chicago", "IL": "America/Chicago",
  "IA": "America/Chicago", "KS": "America/Chicago", "LA": "America/Chicago",
  "MN": "America/Chicago", "MS": "America/Chicago", "MO": "America/Chicago",
  "NE": "America/Chicago", "ND": "America/Chicago", "OK": "America/Chicago",
  "SD": "America/Chicago", "TN": "America/Chicago", "TX": "America/Chicago",
  "WI": "America/Chicago",
  // Mountain
  "AZ": "America/Phoenix", "CO": "America/Denver", "ID": "America/Boise",
  "MT": "America/Denver", "NM": "America/Denver", "UT": "America/Denver",
  "WY": "America/Denver",
  // Pacific
  "CA": "America/Los_Angeles", "NV": "America/Los_Angeles",
  "OR": "America/Los_Angeles", "WA": "America/Los_Angeles",
  // Other
  "AK": "America/Anchorage", "HI": "Pacific/Honolulu",
};

// Nomes completos
const US_STATE_NAMES: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
  "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
};

export function getTimezoneFromState(state: string): string | null {
  const upper = state.trim().toUpperCase();
  if (US_STATE_TIMEZONES[upper]) return US_STATE_TIMEZONES[upper];

  const lower = state.trim().toLowerCase();
  const abbr = US_STATE_NAMES[lower];
  if (abbr && US_STATE_TIMEZONES[abbr]) return US_STATE_TIMEZONES[abbr];

  return null;
}

export function getTimezoneLabel(tz: string): string {
  const labels: Record<string, string> = {
    "America/New_York": "Eastern (ET)",
    "America/Chicago": "Central (CT)",
    "America/Denver": "Mountain (MT)",
    "America/Los_Angeles": "Pacific (PT)",
    "America/Phoenix": "Arizona (MST)",
    "America/Indiana/Indianapolis": "Indiana (ET)",
    "America/Detroit": "Michigan (ET)",
    "America/Boise": "Idaho (MT)",
    "America/Anchorage": "Alaska (AKT)",
    "Pacific/Honolulu": "Hawaii (HST)",
    "America/Sao_Paulo": "Brasilia (BRT)",
  };
  return labels[tz] || tz;
}

export function getCurrentTimeInTimezone(tz: string): string {
  return new Date().toLocaleString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

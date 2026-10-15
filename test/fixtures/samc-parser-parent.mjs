// Frozen parser from 882e0dc80c62a64e380b9260e28cb162434e3e9c, before P1.
// Keep this independent of the typed leaf: it is the differential oracle.
const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(xml)?.[1]?.trim();
const rows = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "gi"))].map((m) => m[1]);

export function parseSamc(xml, source) {
  const app = tag(xml, "APPLICATION_ID");
  if (!app) return [];
  const authorities = rows(xml, "AMC_CHNL_AUTH").map((row) => ({
    path: tag(row, "CHANNEL_ID")?.toLowerCase(),
    program: tag(row, "PROGRAM_ID")?.toUpperCase(),
    activity: tag(row, "ACTIVITY"),
  }));
  return rows(xml, "AMC_CHANNEL").map((row) => ({
    applicationId: app.toUpperCase(),
    path: tag(row, "CHANNEL_ID")?.toLowerCase(),
    type: tag(row, "MESSAGE_TYPE_ID")?.toUpperCase(),
    scope: tag(row, "SCOPE"),
    authorities,
    source,
  })).filter((row) => row.path && row.type);
}

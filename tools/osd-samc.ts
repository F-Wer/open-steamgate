// SPDX-License-Identifier: MIT
// Pure SAMC source parser shared by the generator and the AMC host.
// Missing tags remain own properties with undefined values, not omitted keys.
export interface SamcAuthority {
  path: string | undefined;
  program: string | undefined;
  activity: string | undefined;
}

export interface SamcChannel {
  applicationId: string;
  path: string | undefined;
  type: string | undefined;
  scope: string | undefined;
  authorities: SamcAuthority[];
  source: string | undefined;
}

const tag = (xml: string, name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(xml)?.[1]?.trim();
const rows = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "gi"))].map((m) => m[1]);

export function parseSamc(xml: string, source?: string): SamcChannel[] {
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

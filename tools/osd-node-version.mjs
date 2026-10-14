const REQUIREMENTS = "Node 22 needs >=22.18 (unflagged TypeScript type stripping for tools/**/*.ts); Node 23 needs >=23.6 (type stripping; node:sqlite since 23.4); .nvmrc selects Node 24.";
const UNTESTED = "untested with open-rfc engines ^22.14||^24";

function parsedVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
  return match === null ? undefined : {major: Number(match[1]), minor: Number(match[2])};
}

export function nodeVersionProblem(version) {
  const parsed = parsedVersion(version);
  if (parsed === undefined) return `Cannot read Node version ${JSON.stringify(version)}. ${REQUIREMENTS}`;
  const {major, minor} = parsed;
  if (major < 22 || (major === 22 && minor < 18) || (major === 23 && minor < 6)) {
    return `Node ${version} is unsupported. ${REQUIREMENTS}`;
  }
  return undefined;
}

export function requireSupportedNode(version = process.versions.node, prefix = "", warn = console.warn) {
  const issue = nodeVersionProblem(version);
  if (issue !== undefined) {
    const error = new Error(`${prefix}${issue}`);
    error.code = "NODE_VERSION_UNSUPPORTED";
    throw error;
  }
  const {major} = parsedVersion(version);
  if (major === 23 || major > 24) warn(`${prefix}Node ${version} is ${UNTESTED}`);
}

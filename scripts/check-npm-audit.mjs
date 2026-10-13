import { readFile } from "node:fs/promises";

const auditPath = process.argv[2] ?? "npm-audit.json";
const exceptionsPath = process.argv[3] ?? "SECURITY_EXCEPTIONS.md";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

let report;
let exceptions;
try {
  report = JSON.parse(await readFile(auditPath, "utf8"));
  exceptions = await readFile(exceptionsPath, "utf8");
} catch (error) {
  fail(`Unable to read npm audit report or security exceptions: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit();
}

if (report.error || !report.vulnerabilities || typeof report.vulnerabilities !== "object") {
  fail("npm audit did not produce a valid vulnerability report; refusing to treat an audit error as a pass.");
  process.exit();
}

const exceptionPackages = new Set();
const exceptionAdvisories = new Set();
const exceptionPattern = /\*\*Package:\*\*\s+`([^\`]+)`\s+—\s+\*\*Advisories?:\*\*\s+([^\n]+)/g;
for (const match of exceptions.matchAll(exceptionPattern)) {
  exceptionPackages.add(match[1]);
  for (const advisory of match[2].matchAll(/GHSA-[a-z0-9-]+/gi)) {
    exceptionAdvisories.add(advisory[0].toUpperCase());
  }
}

const vulnerabilities = report.vulnerabilities;
const highOrCritical = severity => severity === "high" || severity === "critical";

function isCoveredByException(packageName, seen = new Set()) {
  const vulnerability = vulnerabilities[packageName];
  if (!vulnerability || !highOrCritical(vulnerability.severity)) return true;
  if (seen.has(packageName) || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) return false;

  const nextSeen = new Set(seen);
  nextSeen.add(packageName);
  return vulnerability.via.every(item => {
    if (typeof item === "string") return isCoveredByException(item, nextSeen);
    if (!item || typeof item !== "object") return false;
    if (item.severity && !highOrCritical(item.severity)) return true;
    const advisory = typeof item.url === "string" ? item.url.match(/GHSA-[a-z0-9-]+/i)?.[0]?.toUpperCase() : undefined;
    if (advisory && exceptionAdvisories.has(advisory) && exceptionPackages.has(packageName)) return true;
    // A parent dependency is exempt only when every high/critical child is
    // transitively covered by a specifically documented package exception.
    if (typeof item.name === "string") return isCoveredByException(item.name, nextSeen);
    return false;
  });
}

const unresolved = Object.entries(vulnerabilities)
  .filter(([, vulnerability]) => highOrCritical(vulnerability.severity))
  .filter(([packageName]) => !isCoveredByException(packageName))
  .map(([packageName, vulnerability]) => ({
    packageName,
    severity: vulnerability.severity,
    direct: vulnerability.isDirect,
    range: vulnerability.range,
    via: vulnerability.via
  }));

if (unresolved.length > 0) {
  console.error("Unexcepted high/critical npm vulnerabilities:");
  for (const item of unresolved) console.error(JSON.stringify(item));
  fail(`${unresolved.length} high/critical vulnerable package(s) are not covered by a current, explicit exception. Patch them or document a narrowly scoped exception with a review date.`);
} else {
  console.log(`npm audit passed: no unexcepted high/critical vulnerabilities (${exceptionAdvisories.size} documented advisory IDs checked).`);
}

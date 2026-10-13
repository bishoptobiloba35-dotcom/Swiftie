import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const checkerPath = fileURLToPath(new URL("../../../scripts/check-npm-audit.mjs", import.meta.url));

test("dependency audit guard rejects a simulated high-severity dependency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "swiftdrop-audit-"));
  const auditPath = join(directory, "audit.json");
  const exceptionsPath = join(directory, "SECURITY_EXCEPTIONS.md");
  try {
    await writeFile(exceptionsPath, "# No active exceptions\\n", "utf8");
    await writeFile(auditPath, JSON.stringify({
      vulnerabilities: {
        "synthetic-high-dependency": {
          severity: "high",
          isDirect: true,
          range: "<1.0.1",
          via: [{
            name: "synthetic-high-dependency",
            severity: "high",
            url: "https://github.com/advisories/GHSA-abcd-efgh-ijkl",
            range: "<1.0.1
          }]
        }
      }
    }), "utf8");

    const result = spawnSync(process.execPath, [checkerPath, auditPath, exceptionsPath], { encoding: "utf8" });
    assert.equal(result.status, 1, "a high-severity advisory without a documented exception must fail CI");
    assert.match(result.stderr, /not covered by a current, explicit exception/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dependency audit guard passes a clean audit report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "swiftdrop-audit-clean-"));
  const auditPath = join(directory, "audit.json");
  const exceptionsPath = join(directory, "SECURITY_EXCEPTIONS.md");
  try {
    await writeFile(exceptionsPath, "# No active exceptions\\n", "utf8");
    await writeFile(auditPath, JSON.stringify({ vulnerabilities: {} }), "utf8");
    const result = spawnSync(process.execPath, [checkerPath, auditPath, exceptionsPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

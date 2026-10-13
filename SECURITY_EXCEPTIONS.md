# Security Exceptions

Temporary, reviewed exceptions for high-severity npm advisories that do not have an installable upstream fix as of 2026-10-13. These exceptions are consumed by `scripts/check-npm-audit.mjs`; new advisories are not automatically exempt.

**Owner:** Platform engineering  
**Initial review date:** 2026-10-13  
**Next review date:** 2026-11-13

## Active exceptions

- **Package:** `braces` — **Advisory:** GHSA-vfj7-8cjw-p6xm  
  **Status:** No patched upstream npm release is available; the advisory affects versions through 3.0.3 and lists no patched version. It is pulled in transitively by Metro/micromatch tooling. Its exposure is currently limited to repository-controlled build/test glob patterns rather than user-supplied runtime patterns. Recheck the upstream advisory and release before the next review date.

- **Package:** `image-size` — **Advisories:** GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr  
  **Status:** The official npm package's latest published release is 2.0.2, which remains affected; the advisory's suggested 2.0.3 release is not available from the official package. It is reached through the Expo/Metro build toolchain and processes build assets, not uploaded customer images in a production API request. Recheck for an official patched release or a validated compatible replacement before the next review date.

- **Package:** `node-forge` — **Advisory:** GHSA-86w9-cpqp-85rv  
  **Status:** No patched upstream release is listed for the affected version range through 1.4.0. It is reached through Expo signing/configuration tooling and is not a direct runtime API dependency. Recheck for a patched release and assess whether the affected signing path is used in production builds before the next review date.

## Exception rules

- The CI audit guard only permits these exact package/advisory exceptions and their transitive dependency effects.
- Any new high/critical advisory fails CI until fixed or separately reviewed and added here.
- Do not interpret an exception as proof that the dependency is safe; it is a time-limited risk acceptance.

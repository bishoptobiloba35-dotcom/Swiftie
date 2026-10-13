# Security Exceptions

Temporary, reviewed exceptions for high-severity npm advisories that do not have an installable upstream fix as of 2026-10-13. The audit guard consumes the exact package/advisory identifiers below; new advisories are not automatically exempt.

**Exception owner:** Platform engineering  
**Recorded:** 2026-10-13  
**Next review date:** 2026-11-13  
**Required review:** Recheck upstream advisory status and dependency reachability; remove each exception immediately when a safe fix or compatible replacement is available.

## Active exceptions

- **Package:** `braces` — **Advisory:** GHSA-vfj7-8cjw-p6xm  
  **Severity:** High (npm audit)  
  **Justification:** The advisory affects versions through 3.0.3 and currently lists no patched upstream version. The dependency is transitive through Metro/micromatch tooling; the identified use is repository-controlled build/test glob patterns, not user-supplied runtime patterns.  
  **Mitigation:** Keep glob patterns repository-controlled, avoid passing untrusted input to affected matching paths, retain the blocking audit guard, and recheck the upstream advisory before the review date.  
  **Owner:** Platform engineering  
  **Review date:** 2026-11-13

- **Package:** `image-size` — **Advisories:** GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr  
  **Severity:** High (npm audit)  
  **Justification:** The official npm release available at review time is 2.0.2; the reported 2.0.3 remediation is not available from the official package. The dependency is reached through the Expo/Metro build toolchain and handles build assets, rather than customer-uploaded images in a production API request.  
  **Mitigation:** Do not use this build-tool dependency to process untrusted runtime uploads; retain server-side upload validation and the blocking audit guard; verify the official package and evaluate a compatible replacement at the next review.  
  **Owner:** Platform engineering  
  **Review date:** 2026-11-13

- **Package:** `node-forge` — **Advisory:** GHSA-86w9-cpqp-85rv  
  **Severity:** High (npm audit)  
  **Justification:** No patched upstream release is listed for the affected range through 1.4.0. The dependency is transitive through Expo signing/configuration tooling and is not a direct runtime API dependency.  
  **Mitigation:** Restrict use to the existing build/signing toolchain, do not introduce it into request-handling paths, retain the blocking audit guard, and validate the affected signing path plus upstream patch availability at review.  
  **Owner:** Platform engineering  
  **Review date:** 2026-11-13

## Exception rules

- The CI audit guard only permits these exact package/advisory exceptions and their transitive dependency effects.
- Any new high/critical advisory fails CI until fixed or separately reviewed and added here.
- Exceptions are time-limited risk acceptance, not proof that a dependency is safe. Review and remove them when their stated review date is reached.

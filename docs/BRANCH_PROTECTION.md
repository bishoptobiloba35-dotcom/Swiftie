# Main branch release gate

The repository's production CI workflow is the required pre-merge quality gate. The six checks are:

- `typecheck (shared)`
- `typecheck (api)`
- `typecheck (admin)`
- `typecheck (customer)`
- `typecheck (driver)`
- `api-tests`

Repository administrators should require all six checks on `main`, require branches to be up to date before merging, require pull requests, and disallow force-pushes/deletion of `main`.

GitHub branch protection/rulesets are account-level repository settings and cannot be safely represented as source code in this repository. After enabling the policy in GitHub, verify it by opening a test pull request and confirming that a failing required check blocks merge.

The policy should not require deployment/provider secrets in ordinary CI. Production EAS builds, payment credentials, notification credentials, monitoring credentials, and store submissions remain release-environment gates.

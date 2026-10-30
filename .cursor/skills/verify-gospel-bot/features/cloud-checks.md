# Cloud checks

These checks run with no cloud credentials and change no cloud resources. `terraform init` and Docker builds need network access the first time.

## Sub-features

- Release gates: `build.sh`, `release.sh`, `smoke.sh`, and `promote.sh`.
- Terraform for `bootstrap`, `environment`, `smoke`, and `canary`.
- Neon inspection and provisioning.
- Cloud smoke, a synthetic send inside the pinned image.
- Staging canary, one marked test message to a private chat.

## Driving it

```sh
node scripts/cloud/verify-workflows.mjs
actionlint .github/workflows/*.yml
for script in scripts/cloud/*.sh; do bash -n "$script"; done
terraform fmt -check -recursive infra
for dir in bootstrap environment smoke canary; do
	terraform -chdir=infra/$dir init -backend=false -input=false
	terraform -chdir=infra/$dir validate
done
terraform -chdir=infra/environment test
terraform -chdir=infra/canary test
node --test scripts/cloud/neon-operation.test.mjs scripts/cloud/neon-staging.test.mjs
node scripts/cloud/canary.test.mjs
node scripts/cloud/cloud-smoke.test.mjs
scripts/cloud/cloud-smoke.sh local
```

`neon-role.test.mjs`, `neon-existing.pg.test.mjs`, and the canary integration test need Postgres, so they run inside `node local-lab/verify-runtime.mjs`.

## Gotchas

`verify-workflows.mjs` runs the release scripts against stubs. It does not read workflow YAML, so a workflow edit also needs `actionlint`. No workflow runs `actionlint`, so run it yourself.

`ci.yml` does not run `verify-workflows.mjs`, `canary.test.mjs`, or Terraform checks. `infrastructure.yml` runs them on pull requests that touch `infra/`, `scripts/cloud/`, or its listed workflows. A change outside those paths does not start them.

`infra/smoke` and `infra/bootstrap` have no `terraform test` files. Mock-provider tests do not prove IAM or API behavior.

A workflow that reads a personal value must read it from `secrets`, not `vars`. This repository is public, and its Actions logs show plain variables.

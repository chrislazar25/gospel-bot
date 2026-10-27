# Cloud review fixes

The release deploy step emits the actual Cloud Run URL. The next `google-github-actions/auth` step requests an ID token for that audience through Workload Identity Federation. `smoke.sh` consumes the action's token, verifies that anonymous health requests fail, and runs the authenticated health request before the check job. This follows the action's [ID token inputs](https://github.com/google-github-actions/auth#inputs-generating-id-tokens).

`promote.sh` owns the production promotion gate. It requires a successful manual Release run on master at the current commit and the `tested-staging-image` artifact. Candidate builds publish a different artifact and cannot pass this gate. The artifact must contain the staging environment marker and an immutable digest for this project's runtime image. The destination `image.txt` changes only after every check passes.

`neon-role.mjs` reconciles each role in one PostgreSQL transaction, including its password, grants, and read-only default. A SQL error rolls back the transaction. A disconnected session causes PostgreSQL to roll back its uncommitted changes. Existing sessions retain their previous grants until the transaction commits.

Run the offline workflow checks with `node scripts/cloud/verify-workflows.mjs` and lint the workflow with `actionlint .github/workflows/release.yml`. These checks use local command stubs and synthetic tokens. They perform no cloud operations.

Run the database test with `TEST_DATABASE_URL` set to a disposable local PostgreSQL administrator connection and invoke `node scripts/cloud/neon-role.test.mjs`. The test creates a uniquely named database and roles, then removes them. It proves rollback after a real SQL error and a terminated connection, reads during uncommitted revokes, successful runtime grants, repeated reconciliation, and status read-only defaults. No Neon API or Google Cloud credentials are used.

# Hold or retry after failure

## Sub-features

- Retry after explicit proof of rejection.
- Hold after a generic server error or an accepted request whose response is lost.
- Preserve the daily claim and evidence through application and database restarts.

## How to get to it (user POV)

Set the fake provider's mode, then call the normal send route. The simulator controls are test setup. The application still uses the real HTTP boundary and Postgres.

## Driving it with verify.mjs

Run `node local-lab/verify.mjs drive` on a fresh stack. Require proven rejection to permit a later successful POST with the same delivery ID. Require an accepted request with a dropped response to stay unknown after repeated POSTs and restarts, with exactly one external acceptance. Require a generic HTTP 500 to stay unknown. Compare durable application state with the independent fake-provider log.

## Gotchas

Timeouts and missing history are ambiguous. Holding may leave a day unsent if the app crashes after the claim but before HTTP. Automatic failover cannot safely resolve that gap without stronger provider guarantees. This lab does not prove real Green API behavior.

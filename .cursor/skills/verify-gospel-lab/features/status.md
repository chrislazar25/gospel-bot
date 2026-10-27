# Inspect delivery status

## Sub-features

- Read a delivery by its application UUID.
- Distinguish provider acceptance from confirmed delivery.
- Keep confirmed evidence after repeated reads and restarts.

## How to get to it (user POV)

Use the `id` returned by POST in `GET /get-status/{id}`. The provider's ID is a separate field. No status request sends another message.

## Driving it with verify.mjs

Run `node local-lab/verify.mjs drive` after launch. Require `accepted` while the provider reports only `sent`. Release a delivery receipt through the fake control and require `confirmed`. Repeated GET requests must leave the fake submission count unchanged.

## Gotchas

An accepted request is not proof the group received it. An empty or failed receipt lookup cannot authorize a resend. Lost acceptance without a known provider ID stays unknown in this simulator contract.

# Gospel Bot feature map

Each file describes one feature from the point of view of its user, and the commands that prove it.

## Local delivery lab

Drive these journeys through `node local-lab/verify.mjs drive` after a fresh launch. The runtime schema, Compose file, and helper in `local-lab/` own the concrete contract.

- [Send today's message](send.md) covers the public send route, replica competition, and the IST daily boundary.
- [Inspect delivery status](status.md) covers receipts in the lab and in the production status service.
- [Hold or retry after failure](failures.md) covers proven rejection, uncertain acceptance, and restart durability.

## Production system

- [Production runtime](runtime.md) covers the job commands, the Green API boundary, and the image.
- [Content pipeline](content.md) covers archive import, batch drafting, and approved message files.
- [Cloud checks](cloud-checks.md) covers workflows, release scripts, Terraform, Neon tooling, cloud smoke, and the canary.
- [Production](production.md) covers read-only checks against the live system.

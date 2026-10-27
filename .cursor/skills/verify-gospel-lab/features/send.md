# Send today's message

## Sub-features

- Create a delivery ID before sending.
- Return the same daily ID across concurrent replicas and repeated requests.
- Select the intended date in Asia/Kolkata.

## How to get to it (user POV)

POST an empty JSON object to `/send-todays-message` on either assigned app URL. The configured target and synthetic content determine the payload. The request cannot choose arbitrary text, date, or destination.

## Driving it with verify.mjs

Launch a fresh isolated stack, then run `node local-lab/verify.mjs drive`. The helper sends concurrent requests across both app URLs and repeats the POST. Require one daily ID, an unchanged payload hash, and one accepted external message. The local clock fixture exercises the IST date boundary without waiting for midnight.

## Gotchas

The frozen fixtures are synthetic test content, not Dad-approved messages. Approval automation and calendar coverage are separate work. Each run must use an empty disposable database. Never reset a developer's existing database to make a journey pass.

# Group attribution and external time separators

Inspected both user references directly: group attribution `libfile_22ee5744b0d48191b05913c5bcc84fdb`, time separators `libfile_d2b2bbdbf0888191b32f034acfd1c2ab`.

## Behavior

Group assistant messages form adjacent sender runs. A colored sender name appears once above a run, and its real BotAvatar appears outside the left edge of the last bubble, bottom aligned. Uploaded picture/custom avatar configuration flows from the resolved sender record unchanged. Dark identity colors get a readable lighter name-label shade without mutating the identity. Sender changes, time separators, non-bot events, failed/uncertain/interrupted/cancelled boundaries close runs. Missing/deleted sender IDs never fall back to the selected/recipient bot; missing IDs are not assumed to represent the same person.

All visible bubble timestamp metadata and timestamp titles were removed. Muted centered separators appear at the first message, a local calendar-day change, or at least five minutes elapsed. Times use the device timezone via Intl, retain actual ISO timestamps, and expose full date/seconds/timezone through accessible time elements outside bubbles. Invalid timestamps say unknown rather than fabricating the current time. Stable message keys remain unchanged; grouping depends on adjacency/real timestamps, never streaming text length or wall-clock time.

Streaming replies now participate in the same transcript layout and sender attribution instead of a separate composer block. Their time anchor comes from the actual running turn/thread, and tail-follow updates with deltas. Single-chat sender/avatar presentation remains unchanged; outgoing identity colors, neutral group outgoing bubbles, task failures, request cards and phone navigation are preserved.

## Actual validation

- GUI lint and TypeScript passed.
- `node --import tsx --test test/gui-message-layout.test.ts test/gui-identity-color.test.ts test/gui-presentation.test.ts`:23 passed.
- Tests cover repeated/different senders, user/event/failure boundaries, unknown/deleted identity, avatar record preservation, five-minute threshold, Asia/Shanghai midnight versus UTC, DST repeated local hour, invalid/full timestamps, stream delta stability, interior grouping after history prepend, single-chat isolation and sender-label contrast.
- Production GUI bundle and Tauri macOS debug app build passed.
- Native isolated fixture: two consecutive teal-sender messages had one label and one avatar at the second bubble's bottom. A custom-dark sender and removed member had distinct correct attribution. Separators appeared at23:58, next-day00:00 and00:08; no redundant separator for near-in-time replies.
- Two real mock-agent streams were triggered together by the fixture-only message `Stream layout fixture`. AX and screenshot captured both attributed partial replies in the transcript; final state contained the two completed replies with no leftover streaming blocks.
- 360px native window verified wrapping, sender/avatar placement, time separators and scrolling. Single-chat narrow screenshot verified neutral assistant/tinted user bubbles with external time separators and no added sender avatars.
- History prepend was tested in pure layout projection; this client has no interactive older-history paging control, so native pagination scroll anchoring was not exercised. Real iOS device behavior and spoken VoiceOver output remain unverified; macOS accessibility tree exposed full time semantics.

The optional `--message-layout` fixture seeds only controlled dummy messages in its isolated /tmp group history, including a removed-member placeholder and deterministic real timestamps. It creates no automation or external action. Original user daemon processes and real profiles remain untouched.

## Library screenshots, version0

- Desktop runs/date boundaries: `libfile_e25c31fb81f8819199fe21a8592ca5c7`
- In-progress two-sender streaming: `libfile_7dce361ebf5c8191b96230bf71aa7078`
- Narrow group: `libfile_eeebf86a1f9c8191a098abd29d86eadd`
- Narrow single chat/time separators: `libfile_e2c364a30c708191b588224fe8f48be8`

All screenshots are inspected native captures of dummy fixture data, with no credentials/private runtime data. No push, publication, installer replacement or security changes.

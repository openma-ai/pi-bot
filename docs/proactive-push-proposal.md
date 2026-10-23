# Proactive push: revised scope

2026-10-23. This supersedes the independent notification-center proposal in
5bb4213 and its experimental implementation in 61a0e46, following the user's
clarification: **the agent's reply is the notification**.

The earlier source audit remains in Git history. The current implementation is
[one reply path](proactive-replies.md), not an additional notification platform.

## Current boundary

Monitor and bounded dream are two producers. They share existing trigger/task
lifecycle and return discoveries to the main bot inbox. The main agent chooses
whether to reply through send_message. That reply is recorded in canonical
outbox and delivered by the existing channel. No reply means no new user message.

No notification/* API, separate summary/body, public priority/read/preferences
center or independent notification delivery queue is needed for this stage.
Existing request forms and message/outbox/journal remain authoritative.

## iOS facts from the source audit

The current GUI Notification.jsx is an in-App Radix Toast. The native mobile
client disconnects runtime/SSE when hidden (src/gui/useRuntime.js:102–114).
Tailscale supplies connectivity, not iOS background execution. No APNs plugin,
registration/token bridge or provider sender was found in the audited tree.
The iOS project uses dev.pibot.ios; desktop dev.pibot.desktop is not its topic.
Audited source entitlements are empty; this is not proof of a signed archive's
final capability state.

| Channel | Scope |
| --- | --- |
| Existing app conversation/inbox | Re-sync existing committed replies after opening/reconnecting. |
| In-app foreground hint | Present an existing message while App is active; not another authored reply. |
| Native local notification | OS can deliver a request already scheduled by the App; it cannot learn an arbitrary new server result after suspension. |
| APNs remote alert | Optional later reminder linked to an existing message ID; server/provider and Apple registration required. |

Apple describes [local scheduling](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app)
and [best-effort background updates](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app).
Silent push is not a dependable continuous agent runtime. The official
[Tauri notification plugin](https://v2.tauri.app/plugin/notification/) provides
local notification functionality; remote registration/provider is separate.

## Later APNs choice, if requested

An existing always-on daemon can be the provider; a new public cloud relay is
not mandatory. This can reuse local build/signing and avoid new CI spend, but
sleeping/offline daemon means delayed sending. A relay adds hosting, storage,
network and operations costs; no provider or free tier is assumed to exist.

Before real deployment, explicitly select provider location, Apple App ID/team/
entitlement/profile, APNs key or certificate custody, authenticated installation
and token binding, token retention/revocation, and intended device test targets.
These were not created, inspected as credentials, or enabled in this work.
[Apple registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns),
[provider setup](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server).

APNs acceptance is not a human read or business-completion receipt. A future
transport must recheck canonical message/source validity before retry; uncertain
sends cannot be assumed not to have happened. Already accepted alerts may be
delayed and cannot be reliably recalled. Clicking must load current message/task
state, never execute an old approval from its payload. No extra authored message
is created to compensate for delivery uncertainty.
[APNs responses](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns),
[request semantics](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

This revision only narrows architecture and updates documentation. It does not
implement APNs, upload tokens, request OS permission or enable real push.

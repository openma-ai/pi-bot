# Pinned OpenMatter trigger primitives

Actual upstream Core WorkEvent schemas, DurableInbox contract, and SQLite inbox implementation from https://github.com/openma-ai/OpenMatter at a5181d3f11d52f60c76aca1ab3e0665193b751df.

The source packages were unavailable from the npm registry when integrated. These three source files are vendored with only package imports changed to relative paths. No scheduler/lease/deduplication algorithm is reimplemented. See PROVENANCE.json for original source hashes. Effect is a pinned registry dependency. Upstream code remains separate from the Pi host policy adapter.

Used boundary: durable WorkEvent ingress and fenced handoff to Pi. This is not a replacement for Pi's agent/tool runtime or an adoption of the entire OpenMatter Loop/Reaction kernel. Inbox `completed` means handoff completed, not user-task completion. User-task completion still requires native inbox/tool/send_message evidence.

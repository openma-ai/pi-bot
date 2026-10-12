# Direct local credential entry

Usable commands:

```
npm run credential-entry
npm run evaluate -- --dry-run
# After model/budget approval, user personally launches this in a local terminal:
npm run evaluate -- --real --approved-budget --model deepseek-v4-flash
```

`credential-entry` demonstrates direct hidden entry, consumes and deletes the
value locally, and makes no provider call. Evaluation real mode uses the same
entry path to authenticate only its trusted temporary Pi provider runtime.
There is no credential argument, environment import, DSH file import, clipboard
read, readline history, or plaintext persistent secret store. Noninteractive
pipes are rejected. Raw TTY mode disables echo; Enter submits, Ctrl-C cancels;
raw mode and input flow are restored. Incoming mutable byte buffers are cleared.
Errors/output never include the value; only fixed status is printed.

Authentication boundary is the user's OS login and their local interactive
terminal/process, not a network form. No web server, port or remote endpoint is
opened. This does not protect against compromised same-account processes,
terminal recording/keyloggers, or process-memory access. Node string copies
cannot guarantee physical memory zeroization. The hidden entry tests use fake
values only; a real PTY fake-value run confirms no echo and clean process exit.

`CredentialBroker` is host-only and ephemeral. Requests/one-use references bind
bot, task and tool; at most five-minute TTL, revoke, delete-on-consumption, close
clears all entries. Returned failures are fixed statuses so tool exceptions do
not expose submitted values. For evaluation, a single provider-specific smoke
scope installs the key into an in-memory ModelRuntime; it is removed on shutdown
and is never accessible to model tools. No real credential was entered in tests.

Optional native `request_credential` emits only a form descriptor through
send_message; it never accepts a secret. Tool invocation is allowlisted and
bound to an explicit source event. Repeated keys reuse the descriptor. This is
an integration API for future hosts, not a working browser form. A future web
host would need owner authentication, origin/CSRF checks, escaped text rendering,
and tool-specific consumer notifications. An authenticated network form has not
been implemented or claimed production secure.

Visual interaction follows the public credential-request reconstruction brief;
no original Grok implementation/source was supplied or verified.

# Channel layer: where it stands, and what is left

Written to be read on another host. Everything below is in `wip/device-debug-cache` (App) — the CLI
half is in `feature/cursor-agent` — and everything described as done is pushed.

## The model, in one paragraph

A machine is reached over one of three channels: **server**, **lan**, **relay**. The App's decisions
about which one — can it be reached, where would we send, which address answers — live in
`sources/sync/channels/` and nowhere else. `measure.ts` builds a driver per channel; `candidates.ts`
orders the addresses a channel would use; `health.ts` remembers what each address has done;
`execute.ts` (`carryOperation`) asks the drivers in priority order and lets whichever accepts carry the
operation. Callers say *what* they want, not *where*.

## The rules that came out of this work

- **Reachability is an observation, not a claim.** A machine publishing an address is a claim. It counts
  only once something answered there — a socket that came up, a browse that found it *here*.
- **A channel that cannot carry something offers nothing.** With the relay's hub down, the relay driver
  returns no endpoints and no socket target, so nothing downstream has to invent a fallback. The hub is
  one connection; a machine is a stream inside it.
- **Port priority wins**: a session on a channel reads on that channel; the server carrying it has no
  channel, so every daemon channel that accepts is offered in the device's priority order.
- **A pin outranks the priority**, and a caller's forced route outranks both (`channels/readRoute.ts`).
- **A refusal is an answer** — it stops the call, it is never substituted with another action, and it is
  never held against the address. Only "nothing answered" is.
- **A read is not a place to rebuild state**: a read that proves what was already proven writes nothing,
  or every poll rebuilds the session list (that mistake froze the App once).

## Done and pushed

- Published LAN addresses are read, ordered, health-filtered, and used by reads and sockets
  (`7fb7f53a`, `4a53bddd`, `25c144c7`); the daemon only offers interfaces carrying a default route
  (`9589b5ce`, CLI).
- Per-address health with hysteresis (`d5fdc6c6`), and the removal of `routeFailures` — the ninety-second
  amnesia that made channels flap.
- The driver contract (`5c645616`), `carryOperation` (`9ce9cdb0`), control/restart through it
  (`ed752910`), versions and lifecycle through it (`d27ec23e`), sockets (`b5a87d13`), the server as a
  channel for restart (`df6550ed`), the hub rule (`4ad087ef`).
- The read path: routes (`c1a1fa06`), addresses (`28323ba2`), paging health (`fc8f6f6c`), the rule made
  pure and tested (`d8837431`).
- Markdown emphasis on iOS, and the delimiter fix (`3bedeb13`, `84a0e94d`, `d249c53a`).

## Left, in the order worth doing

1. **The send path** — `flushOutbox` still walks its own ladder (daemon socket → server socket → server
   HTTP). Highest risk of anything left: the App has **no outbox tests**, so write those first.
2. **The machine's data key over the LAN** — machine-scoped operations (`machineRPC`, machine metadata)
   need a key the App can only get from the server today. The daemon holds it and already hands out
   session keys the same way over `/lan/history`.
3. **Why the daemon's server registration gets `ERR_CANCELED`** — it recurred for hours on one host and
   a daemon restart cleared it. Registration should not be cancellable by its own client.
4. **LAN TLS** — deferred, see the notes in `lan-tls-deferred` (memory).
5. A `Failed to get git status` toast, unrelated to the above.

## How to work on this without a person in the loop

- The **dev tools page** (`/dev`, network section) shows each channel's liveness, its connections, the
  candidates with their phase and retry countdown, and the priority — read it rather than guessing.
- The **daemon log** (`~/.happy/daemon.log`) carries proof refusals at warning level; `DEBUG=1` in the
  daemon's launchd plist turns on the rest.
- **Changing UI means looking at it.** Screenshot the app (`screencapture -x`) and read it before
  claiming anything; a bundle grep only proves the code shipped.
- `yarn typecheck` has a baseline of ~20 pre-existing errors outside these files; the test suite has five
  pre-existing failures (apiGithub, typesRaw, reducer ×2, reducerTracer) — both worth checking against.

import { setDefaultResultOrder } from "node:dns";

// Node's fetch() (undici) otherwise lets the OS's getaddrinfo order pick
// which address family to try first, and on a lot of home/ISP networks
// that advertise IPv6 without it actually routing anywhere, a *fresh*
// outbound connection -- e.g. Supabase's Auth API, which every Server
// Action here calls directly with its own fetch -- picks the dead IPv6
// route, hangs, and surfaces as "AuthRetryableFetchError: fetch failed"
// with no further detail. A request that happens to reuse an
// already-established (working) connection isn't affected, which is why
// this can show up as "some auth calls work, others consistently don't"
// rather than a clean total outage. Forcing IPv4 first avoids ever
// picking the broken path.
setDefaultResultOrder("ipv4first");

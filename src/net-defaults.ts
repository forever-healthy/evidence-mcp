// Node's dual-stack connect (Happy Eyeballs) gives each address 500 ms before it tries
// the next. A host without working IPv6 dials an API's IPv4 address; with hundreds of
// connections opened at once (the evidence map's screening, 400 at a time) its TCP and
// TLS setup can take longer, the attempt is cut, and the call fails with ETIMEDOUT
// (speed test 2026-11-20: 158 of 1,200 calls at 400 parallel; 3 with 2 s). 2 s per
// address: a slow handshake is waited for, a dead address still costs little.
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

setDefaultAutoSelectFamilyAttemptTimeout(2000);

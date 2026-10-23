# Branch 004 POS002 approval

The user requested approval of branch 004 POS02 on 2026-10-23. Read-only
Tailscale inspection confirmed node `noJJCWPrL221CNTRL`, hostname `POS002`,
IPv4 `100.73.76.18`, online state, and the company tailnet `akcd1998.github`.

Existing authenticated SMB shares were used only to inspect these local files:

| Local path on POS002 | File version | Bytes |
| --- | --- | --- |
| `D:\AdaSoft\AdaPos4.0HpmFhn\AdaPos\AdaPosFront.exe` | 4.6006.0032 | 13701120 |
| `D:\AdaSoft\AdaPos4.0HpmFhn\AdaSmart\AdaSmart.exe` | 4.6006.0024 | 50626560 |

Both approved paths have readable PE headers. No remote file/settings changes,
SQL calls, AdaPos execution, installation, or member claims are part of this
approval. The receipt scope 004/002 follows the user's explicit terminal identity;
this is not a completed live receipt or member-history acceptance test.

Version 1.3.8 adds exactly this node to the compiled policy and binds it to
branch `004`, register `002`. Other devices keep their existing permissions.
Existing matching requirements (node ID, hostname, IP on a local adapter,
company tailnet, online Tailscale and approved local AdaSoftware) remain intact.
The installer/runtime checks are unchanged. Older binaries cannot gain this
approval by changing a config file; use the new installer on this device.

Offline checks cover admission, wrong-node/wrong-host/local-adapter/Ada-file
rejection, own receipt acceptance, foreign-register/branch rejection and copied
configuration rejection. The usual desktop, member, setup and history checks
are also required before publishing. No assertion of remote installation is made.

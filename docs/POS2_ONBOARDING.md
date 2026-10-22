# POS2 onboarding, 22 October 2026

The user authorized company-device approval for POS2, Tailscale IPv4
`100.93.254.58`. Tailscale reported the online Windows node
`nEdQXowQ4t11CNTRL`, hostname `POS2`, in `akcd1998.github`.
The branch number was not inferred from the hostname.

## Private file connection

Run `tools/Connect-PosShare.ps1` from the Windows workstation that will read the
POS shares. The helper verifies the target node and TCP 445 first, then opens a
Windows credential prompt. Enter the account created on POS2 (for example
`POS2\your-account`) in that dialog, never in chat or a command argument.

It creates a nonpersistent Windows SMB session, enumerates actual disk shares,
and checks only their root readability. No drive letter, Credential Manager
entry, remote write, ACL change or account change is made. The password is held
only for authentication; its temporary native buffer is zeroed and disposed.
Windows retains the authenticated network session for the current logon.
Existing sessions are preserved; Windows error 1219 requires the operator to
resolve the conflicting account rather than silently disconnecting it.

The connection report contains identity, share names and Windows result codes,
never a username or password. `-InspectOnly` verifies identity/transport and
compiles the native adapter without prompting or authenticating.

At `2026-10-22T10:47:40Z`, the user entered credentials privately and the helper
successfully read shares `C` and `D`. Administrative shares `C$` and `D$` returned
access denied. Share-enumeration level 2 also returned access denied, so level 1
provided the share names without their local-path mappings. Permissions were
left unchanged. No vendor databases were opened or copied.

## Read-only AdaSoftware evidence

The following PE executables were read from `\\100.93.254.58\D\AdaSoft\AdaPos4.0HpmFhn`:

| Relative file | Bytes | File version | SHA-256 |
| --- | ---: | --- | --- |
| `AdaPos\AdaPosFront.exe` | 13701120 | 4.6006.0032 | E0A54692E5287CD6947BF5528AB588C3C2372382DA77757E876357B33651340A |
| `AdaSmart\AdaSmart.exe` | 50626560 | 4.6006.0024 | BA8F8708A2EC955CA98E26559E34F2809568BF427F9C573FB7DC27AD698655BE |

Both have an MZ header and readable Windows file-version metadata. The compiled
policy permits their standard `D:\AdaSoft\AdaPos4.0HpmFhn` paths. Because share
mapping metadata was unavailable, the installer must still confirm those paths
exist on a fixed local drive; file sharing alone does not bypass that check.

## Installation boundary

POS2 needs installer 1.3.4 or later containing this node; earlier compiled
policies cannot approve it from the web inventory. Existing approved computers
can keep their versions. Updating remains operator initiated.

After installation, use the existing AdaPos setup assistant to check the actual
SQL instance and branch. No SQL login, connection configuration, member receipt
or installation on POS2 was tested during this file-access audit.

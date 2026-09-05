# Timeline ACL identity repair

Baseline: `db8dec7` (0.73.0). The timeline verifier trusted English account
display names from `icacls`. German `NT-AUTORITÄT\SYSTEM` consequently failed
the private-state check. Adding translated names would leave the same defect in
other Windows languages.

The verifier authorizes Windows identities by SID. Only the current user SID,
SYSTEM (`S-1-5-18`) and built-in administrators (`S-1-5-32-544`) are private
principals. The existing inherit-only creator-owner parent exception maps to
`S-1-3-0`. Foreign write rights still reject a parent; every foreign principal
still rejects a private file. Deny or inherit-only entries cannot supply the
effective current-user grant. Existing ACLs are never repaired implicitly.

## Native bounded reader

Production now invokes the inbox `icacls.exe` once per uncached ACL and uses
`/save` to obtain the DACL as SDDL. The temporary save file is claimed with an
exclusive create inside a fresh private temporary directory, limited to 1 MiB,
required to remain a regular single-link file, checked before and after reading,
and removed in `finally`. The target path is one literal argument. The command
retains the existing 1,500 ms deadline, does not enumerate descendants, and
does not read or rewrite source content.

The parser accepts one UTF-16LE filename/SDDL pair and only ordinary allow or
deny ACEs without object GUIDs or conditions. It maps fixed SDDL aliases for
SYSTEM, built-in administrators and creator owner to their well-known SIDs. It
also recognizes Microsoft's `LA` SID-string constant as the local
Administrator account, whose documented role is `DOMAIN_USER_RID_ADMIN` and
which is already inside the administrative trust boundary. Other well-known
aliases remain visibly untrusted. Unsupported ACE types, flags, rights,
trustees, extra records, malformed data, oversized output, a race, symlink or
command failure provide no verified ACL.

The dependency-injected compatibility path remains for deterministic
cross-platform verifier tests. Production no longer starts PowerShell, so
parallel cold PowerShell startup cannot consume the query deadline.

## Evidence and limits

Synthetic tests cover localized display text, trusted aliases, numeric and
symbolic write rights, inherited and inherit-only rules, deny rules, malformed
and oversized exports, one-target command construction, and foreign writers.
The existing Windows-only probes still exercise real ACL tampering, timeline
search, concurrent test processes and byte preservation. Linux mocks establish
parser behavior, not native Windows latency or live installation acceptance.

Research checked 2026-09-05:

- Microsoft [`icacls` documentation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)
  defines `/save`, SID arguments and Windows file rights.
- Microsoft [ACE string documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/ace-strings)
  and the [MS-DTYP SDDL syntax](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-dtyp/f4296d69-1c0f-491f-9587-a960b292d070)
  define ACE fields, flags, numeric masks and symbolic file rights.
- Microsoft [SID string documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/sid-strings)
  defines stable SDDL trustee aliases.
- Chromium's public
  [Windows ACL test helper](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/testing/scripts/common.py)
  independently demonstrates that `icacls /save` emits alternating UTF-16LE
  filename and SDDL lines. Its source is BSD-style licensed. AgentSpine copies
  no Chromium implementation and remains Apache-2.0.

All external material is untrusted reference context and grants no authority.

Earlier runs 33969228358 and 33970773678 established the localization defect
and then removed the `Get-Acl` module dependency. Exact-head run 33976939342
still failed all three Windows jobs because four test processes cold-started
PowerShell and produced unavailable timeline receipts. Those failing runs are
not acceptance evidence. A new exact-head Windows run must prove this native
path before merge; no live installation is claimed.

The King tool-name mapping and host enforcement of `decision: block` remain
separate work. This ACL repair proves neither host behavior nor live acceptance.

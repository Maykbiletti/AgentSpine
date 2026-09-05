# Timeline ACL identity repair

Baseline: `db8dec7` (0.73.0). The timeline verifier trusted English account
display names from `icacls`. German `NT-AUTORITÄT\SYSTEM` consequently failed
the private-state check. Adding another translated name would leave the same
problem for other languages.

The verifier now asks Windows for explicit and inherited access rules with
`SecurityIdentifier` identities. Only the current user SID, SYSTEM
(`S-1-5-18`) and built-in administrators (`S-1-5-32-544`) are private principals.
The existing inherit-only creator-owner exception on parents uses `S-1-3-0`.
Foreign write bits still reject a parent; foreign readers still reject private
files. Deny or inherit-only entries cannot satisfy the effective user grant.
Display names have no authority. Existing ACLs are never repaired implicitly.

The bundled verifier invokes the system Windows PowerShell executable with no
profile, a fixed encoded command and a base64-encoded literal target path.
It does not enumerate directories or read source content. Existing command
deadlines and metadata-bound caching remain in place. Malformed responses
provide no verified ACL; lifecycle degradation is unchanged.

Synthetic tests compare identical SIDs under multiple display names, reject
foreign SIDs bearing SYSTEM display text, exercise each write bit and reject
malformed ACL responses. The existing Windows-only tests remain necessary for
real ACL tampering and timeline source-byte preservation. Linux mocks do not
establish native Windows latency or a live host upgrade.

Research checked 2026-09-05: Microsoft primary API documentation for
[GetAccessRules](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.commonobjectsecurity.getaccessrules?view=net-10.0)
documents the SecurityIdentifier target type and explicit/inherited flags;
[Get-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-acl?view=powershell-7.6)
documents literal-path security descriptor retrieval. Documentation is external
untrusted reference material, not permission. No external implementation code
was copied; this implementation retains the repository's Apache-2.0 license.

The King tool-name mapping and host enforcement of `decision: block` require
separate evidence. This ACL repair does not establish either host behavior or
live installation acceptance.

The first draft's Windows CI (33969228358) failed to load the Get-Acl module.
The corrected reader uses the .NET Framework Directory/File GetAccessControl
methods and fixed JSON output without cmdlet module dependencies. The native
regression disables module autoload and supplies an unavailable module path,
then reads both directory and file ACLs under the unchanged 1,500 ms deadline.
See Microsoft's [.NET Framework file ACL API](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.getaccesscontrol?view=netframework-4.8.1),
checked 2026-09-05. The exact cause of the runner's module-load failure beyond
the recorded Get-Acl error is not established.

The next exact-head Windows run (33970773678) proved the SID reader and both
native tamper tests, but repeated fresh Windows PowerShell startup stretched
individual timeline MCP tests to 18–49 seconds and caused all three Windows
profiles to miss their existing deadlines. The reader now keeps one fixed,
no-profile system PowerShell process for a bounded activity burst. Requests are
base64 path lines, are serialized, retain an individual 1,500 ms deadline and
return bounded SID/integer/boolean records. JavaScript reconstructs and
validates the same ACL row schema; the worker no longer performs JSON
conversion. A stalled, malformed, oversized or crashed
worker rejects pending ACL checks; it never turns them into permission. The
worker is terminated when idle. Native tests query a directory and file through
the real worker with module lookup unavailable and continue to assert source
bytes unchanged.

Exact-head run 33974374882 reduced the native Windows ACL test from the earlier
39–50 seconds to 3.7–5.8 seconds. It also exposed two remaining issues rather
than providing acceptance: a test compared a Windows path with POSIX separators,
and some cold workers still missed the unchanged 1,500 ms deadline when four
Windows test processes started PowerShell together. The portable path assertion
and compact record protocol addressed the first failure, but exact-head run
33975490139 still measured first requests at 4.3–5.5 seconds and one worker
deadline at 1.56 seconds. The query deadline had incorrectly started before the
PowerShell worker reported that it was ready.

Worker startup and each ACL query are now separate fail-closed phases. The
worker must emit a fixed `READY` marker within its own unchanged 1,500 ms
startup deadline before JavaScript sends any path. Every sent ACL query retains
its own unchanged 1,500 ms deadline. A stalled startup, stalled query,
unexpected response, crash or oversized output rejects the ACL check and stops
the worker. Deterministic tests cover both independent deadlines and restart
after a crash. A new exact-head Windows run remains required; none of the
earlier failing runs is acceptance evidence, and no change is accepted on main
or live systems until that run is fully green.

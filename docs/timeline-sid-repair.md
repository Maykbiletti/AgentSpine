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

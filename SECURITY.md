# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's security
advisory feature for this repository. Do not open a public issue until a fix or
disclosure plan has been agreed. Include reproduction steps, affected versions
or commits, and the expected impact.

No formal response-time SLA is currently offered, but reports will be
acknowledged and assessed as maintainers are available.

## Supported versions

This project is pre-release and currently supports only the latest code on the
default branch. There are no maintained release branches.

## Trust boundaries

Network files may contain embedded JavaScript component definitions. Those
components execute with `new Function` in the solver worker and are trusted
code, not a security sandbox. Only load component code from sources you trust.
Worker isolation keeps computation off the UI thread but does not make hostile
code safe.

The optional local companion server exposes files from its configured
component-library directory. Bind it only to intended interfaces and review
its directory and environment configuration before use. The browser app is
local-first, but imported models, local storage, downloads, and companion
server access still cross trust boundaries.

## Export control

Nothing in this repository is export controlled. All source code,
documentation, material property data, and validation data derive from
lawfully published sources in the public domain (as defined in ITAR §120.34
and EAR §734.7). Contributions must not include export-controlled material.
Note that public availability alone is not sufficient: technical data
released without authorization remains controlled. See
[Contributing](CONTRIBUTING.md).

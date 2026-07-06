# Security Policy

## Reporting a Vulnerability

We take the security of Shepherd seriously, especially given its multi-tenant,
hosted deployment. If you believe you have found a security vulnerability, please
report it to us privately. **Do not open a public GitHub issue for security
reports.**

Please report vulnerabilities through one of the following channels:

- **GitHub Security Advisories** (preferred): use the
  ["Report a vulnerability"](https://github.com/Korso-AI/shepherd/security/advisories/new)
  button under the repository's **Security** tab. This keeps the discussion
  private until a fix is released.
- **Email**: `security@korsoai.com`

Please include, as much as you can:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept, affected endpoints, or code paths).
- The affected component (`hub`, `mcp-server`, `ui`) and version/commit.
- Any suggested remediation, if you have one.

## What to Expect

- **Acknowledgement** within 3 business days.
- An initial assessment and severity classification within 7 business days.
- We will keep you informed of remediation progress and coordinate a disclosure
  timeline with you. We aim to resolve high-severity issues promptly and will
  credit reporters who wish to be acknowledged.

## Scope

This policy covers the code in this repository: the coordination **hub**
(`packages/hub`), the **MCP server** (`packages/mcp-server`), the **shared**
contracts (`packages/shared`), and the **dashboard UI** (`packages/ui`).

The Korso-hosted platform's front-end/BFF (backend-for-frontend) and its
authentication layer live in a separate, non-public repository; vulnerabilities
in the hosted service itself may also be reported through the channels above.

## Supported Versions

Shepherd is under active development. Security fixes are applied to the latest
release on the `main` branch. We recommend always running the most recent
published version of `@korso/shepherd` and `@korso/shepherd-ui`.

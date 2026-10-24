# Security policy

GiveLoom handles sensitive supporter and donor information. Please report suspected vulnerabilities privately so they can be assessed and fixed before details are public.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/sgerner/giveloom/security/advisories/new) for this repository. Include:

- A clear description of the affected component and impact.
- Steps to reproduce or a proof of concept that uses synthetic data.
- Any relevant version, environment, or configuration details.
- Your preferred way to coordinate a fix and public disclosure.

Do not include real donor records, secrets, or credentials. Do not create a public issue or pull request with exploit details. If GitHub private reporting is unavailable, contact the maintainers through a private channel linked from the repository rather than posting technical details publicly.

Please allow maintainers reasonable time to investigate and prepare a fix before public disclosure. We will acknowledge reports and coordinate next steps, but no response-time or bounty commitment is currently specified.

## Supported versions

GiveLoom is under active development and does not currently publish a supported-version schedule. Report vulnerabilities against the latest repository revision and include the affected commit or release if known.

## Security notes

Automated checks and local test results do not establish that a deployment is secure or production-ready. Operators should follow [docs/operations.md](docs/operations.md), protect `.env` and backup files, use HTTPS, configure private malware scanning before enabling uploads, and validate provider configuration and restore procedures before storing real donor data.

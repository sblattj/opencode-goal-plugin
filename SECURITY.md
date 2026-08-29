# Security Policy

## Supported Versions

Only the current `main` branch of this repository receives security fixes. This
fork is not published to npm; installs come from the repository directly, so
re-installing from `main` always includes all shipped fixes.

| Version | Supported |
| --- | --- |
| Current `main` | ✅ |
| Any older commit | ❌ |

This repository is a fork of
[`prevalentWare/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin)
(MIT). If a vulnerability also affects upstream, please report it there too — this
fork's maintainer cannot fix it for upstream's users.

## Reporting a Vulnerability

Please report security issues privately so a fix can be released before the
details are public:

- Open a private report through
  [GitHub Security Advisories on this repository](https://github.com/sblattj/opencode-goal-plugin/security/advisories/new),
  with a description, reproduction steps, and the affected commit.

There is no email contact configured for this fork. Do not send reports about it to
the upstream project's security address — upstream does not maintain this code.

Please do not open a public issue for suspected vulnerabilities.

## What to expect

- We will acknowledge your report within 5 business days.
- We will assess impact, work on a fix, and keep you informed of progress.
- Once a fix lands on `main`, we will credit you in the commit or release notes if
  you would like.

## Scope notes

This plugin runs inside OpenCode with the permissions of the OpenCode session
that loads it. Reports about the plugin weakening a user-facing OpenCode
boundary (for example mode isolation, permission prompts, or autonomous
continuation limits) are in scope, even when the underlying capability is
provided by OpenCode itself.

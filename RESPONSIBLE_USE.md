# Responsible Use

Allman is a tool for managing **your own** LinkedIn inbox from the terminal. It
authenticates with your own credentials, runs on your own machine, and stores
all data locally. Tarka Ventures, Inc. does not relay, store, or have access
to your messages or session.

## Intended use

- Reading, searching, and replying to conversations in your own inbox.
- Piping your own messages to local agents and scripts.
- Bulk-importing your own message history into local tooling.

## Use that we do not support or encourage

- **Mass unsolicited outreach.** Allman is not a cold-outbound spam tool.
  LinkedIn enforces per-day messaging limits server-side, and accounts that
  send spam will be restricted or banned by LinkedIn directly.
- **Operating someone else's account.** Allman authenticates with your own
  browser session. Logging in as another person, or running Allman against an
  account you don't control, is a violation of LinkedIn's User Agreement and
  is not a use case we support.
- **Scraping data you don't have access to.** Allman is a messaging client,
  not a scraper. It accesses only what your authenticated LinkedIn session
  already exposes to you in the LinkedIn UI.
- **Circumventing LinkedIn rate limits or safety controls.** The built-in
  rate limiter (default 3000ms between sends) is intentional. Disabling or
  working around platform-side rate limits is not a supported configuration.

## Compliance is your responsibility

Your use of Allman to access the LinkedIn service is governed by LinkedIn's
[User Agreement](https://www.linkedin.com/legal/user-agreement), which is
a contract between you and LinkedIn. Tarka is not a party to that agreement
and cannot grant you rights against it. You are responsible for ensuring
your use complies with LinkedIn's terms, applicable law, and any obligations
you have to the people you correspond with.

If LinkedIn restricts your account, that's between you and LinkedIn. We
cannot intervene.

## What Tarka does not do

- We do not store your credentials or cookies.
- We do not relay your messages through our servers.
- We do not aggregate, sell, or analyze your message data.
- We do not operate accounts on your behalf.

See `LICENSE` and the top-level `NOTICE` for the legal framing.

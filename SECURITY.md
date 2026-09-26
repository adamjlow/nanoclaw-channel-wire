# Security policy

This channel handles decrypted end-to-end encrypted Wire messages and the device identity of a Wire
app. Security is its main design goal (see the [README](README.md#security-model)), and reports are
taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting on this
repository (**Security** tab, then **Report a vulnerability**). Include the version or commit,
steps to reproduce, and the impact. You should get an acknowledgement within a few working days.

We're especially interested in anything that breaks one of the channel's guarantees:
- a message not addressed to the app (group chatter, group files, other events) reaching NanoClaw,
  an agent, or a log;
- Wire credentials, the crypto key, or `store/wire/` becoming reachable from an agent container;
- the Wire SDK or its native code affecting the NanoClaw host process;
- message content, tokens, keys or unmasked ids appearing in logs;
- a forged or replayed button click resolving an approval.

Report vulnerabilities in the Wire SDK itself to
[wireapp/wire-apps-js-sdk](https://github.com/wireapp/wire-apps-js-sdk), and vulnerabilities in
NanoClaw core to [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw).

## Supported versions

Security fixes go into the latest release.

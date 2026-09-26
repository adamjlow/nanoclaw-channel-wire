# Live test image. Wire's CoreCrypto needs glibc >= 2.38, so Debian 13 (trixie).
# Node 22 matches NanoClaw's .nvmrc and the ABI of the mounted node_modules.
FROM node:22-trixie-slim
# The state volume inherits this directory's owner on first use, so the
# unprivileged node user can create the app's 0700 state dir inside it.
RUN mkdir -p /state && chown node:node /state && chmod 0700 /state
USER node
WORKDIR /app

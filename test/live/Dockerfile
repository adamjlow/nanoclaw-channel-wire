# Live test image. Wire's CoreCrypto needs glibc >= 2.38, so Debian 13 (trixie).
# Node 22 matches NanoClaw's .nvmrc and the ABI of the mounted node_modules.
FROM node:22-trixie-slim
USER node
WORKDIR /app

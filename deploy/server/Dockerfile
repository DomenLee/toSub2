FROM node:22-bookworm-slim AS build
WORKDIR /opt/tosub2
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY web ./web
COPY requirements.txt ./requirements.txt
COPY deploy/server ./deploy/server
RUN node deploy/server/patch.mjs .
RUN cp deploy/server/security.mjs src/server-security.mjs && cp deploy/server/sync.mjs src/server-sync.mjs && cp deploy/server/repair.mjs src/server-repair.mjs && cp deploy/server/identity.mjs src/identity.mjs && cp deploy/server/SyncPanel.jsx web/src/SyncPanel.jsx && cp deploy/server/SyncPanel.css web/src/SyncPanel.css
RUN cp deploy/server/accounts.mjs src/server-accounts.mjs && cp deploy/server/Accounts.jsx web/src/Accounts.jsx
RUN node --input-type=module -e 'import {build} from "vite";import react from "@vitejs/plugin-react";await build({root:"web",plugins:[react()]});'
RUN node --input-type=module -e 'import fs from "node:fs";const pkg=JSON.parse(fs.readFileSync("package.json"));for(const name of ["vite","@vitejs/plugin-react","react","react-dom","lucide-react"])delete pkg.dependencies[name];fs.writeFileSync("package.json",JSON.stringify(pkg));' && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/tosub2
COPY --from=build /opt/tosub2/src ./src
COPY --from=build /opt/tosub2/web/dist ./web/dist
COPY --from=build /opt/tosub2/node_modules ./node_modules
COPY --from=build /opt/tosub2/package.json /opt/tosub2/requirements.txt ./
RUN python3 -m venv /opt/python && /opt/python/bin/pip install --no-cache-dir -r requirements.txt
ENV NODE_ENV=production ONBOARDING_HOST=0.0.0.0 ONBOARDING_PORT=4399 ONBOARDING_OUTPUT_ROOT=/data/jobs TOSUB2_PYTHON=/opt/python/bin/python PUBLIC_ORIGIN=https://tosub.gptplusch.store
USER 1000:1000
CMD ["node", "src/console-server.mjs"]

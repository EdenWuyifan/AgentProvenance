FROM node:20-bookworm-slim AS frontend-builder

WORKDIR /app/agent_provenance_react
COPY agent_provenance_react/package.json ./
RUN npm install
COPY agent_provenance_react ./
RUN npm run build

FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    HOSTNAME="0.0.0.0" \
    PORT="3000" \
    PROVENANCE_BACKEND_URL="http://127.0.0.1:8008"

WORKDIR /app
COPY agent_provenance_backend/requirements.txt ./agent_provenance_backend/requirements.txt
RUN pip install --no-cache-dir -r agent_provenance_backend/requirements.txt

COPY --chown=node:node agent_provenance_backend ./agent_provenance_backend
COPY --chown=node:node --from=frontend-builder /app/agent_provenance_react/.next/standalone ./agent_provenance_react
COPY --chown=node:node --from=frontend-builder /app/agent_provenance_react/.next/static ./agent_provenance_react/.next/static
COPY --chown=node:node --from=frontend-builder /app/agent_provenance_react/public ./agent_provenance_react/public
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p agent_provenance_react/.cache && chown -R node:node agent_provenance_react/.cache

USER node
EXPOSE 3000

CMD ["docker-entrypoint.sh"]

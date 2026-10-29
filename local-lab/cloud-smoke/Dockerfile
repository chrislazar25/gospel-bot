ARG RUNTIME_IMAGE=gospel-runtime:cloud-smoke-base
FROM ${RUNTIME_IMAGE}
USER root
RUN apk add --no-cache postgresql17 postgresql17-client openssl
COPY local-lab/cloud-smoke /verification
COPY scripts/cloud/neon-role.mjs /verification/neon-role.mjs
LABEL io.gospel.image-purpose=cloud-smoke
USER node
CMD ["node", "/verification/run.mjs"]

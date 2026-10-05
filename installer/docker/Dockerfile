# Vayrone PostMaster — optional container image.
#   node scripts/build-release.mjs --target linux-x64 --format node --no-runtime
#   docker build -f installer/docker/Dockerfile -t vayrone/postmaster:<version> .
#   docker compose -f installer/docker/docker-compose.yml up -d
# Only the built release folder is copied into the image (no source code).
FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title="Vayrone PostMaster" \
      org.opencontainers.image.vendor="Vayrone Infratech" \
      org.opencontainers.image.description="Vayrone PostMaster by Vayrone Infratech — LAN mail server suite"
RUN groupadd --system vpm && useradd --system --gid vpm --home-dir /data --shell /usr/sbin/nologin vpm \
 && mkdir -p /opt/vayrone-postmaster /data /config && chown vpm:vpm /data /config
COPY --chown=root:root release/linux-x64/app /opt/vayrone-postmaster/app
COPY --chown=root:root release/linux-x64/db /opt/vayrone-postmaster/db
COPY --chown=root:root release/linux-x64/web /opt/vayrone-postmaster/web
COPY --chown=root:root release/linux-x64/THIRD_PARTY_LICENSES.md release/linux-x64/LEGAL.txt release/linux-x64/VERSION release/linux-x64/README.txt /opt/vayrone-postmaster/
COPY --chown=root:root --chmod=0755 installer/docker/entrypoint.sh /usr/local/bin/vpm-entrypoint
# VPM_DOCKER: updates come as new images, so the in-app updater is switched off.
ENV VPM_HOME=/opt/vayrone-postmaster VPM_CONFIG=/config/vpm.config.json NODE_ENV=production VPM_DOCKER=1
USER vpm
VOLUME ["/data", "/config"]
# Unprivileged ports inside the container; map them to 443/587/… on the host.
EXPOSE 8443 2587 2465 2143 2993 2110 2995
ENTRYPOINT ["/usr/local/bin/vpm-entrypoint"]
CMD ["all"]

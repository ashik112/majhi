# Release images contain the app. Only the owner's passwd entry is built here.
ARG SERVER_FROM
ARG RUNNER_FROM
FROM ${RUNNER_FROM} AS runner
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG HOST_HOME=/home/majhi
RUN --mount=type=bind,source=docker/owner.sh,target=/tmp/owner.sh sh /tmp/owner.sh
FROM ${SERVER_FROM} AS runtime
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG HOST_HOME=/home/majhi
RUN --mount=type=bind,source=docker/owner.sh,target=/tmp/owner.sh sh /tmp/owner.sh

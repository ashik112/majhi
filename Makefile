SHELL := /bin/sh
export HOST_UID := $(shell id -u)
export HOST_GID := $(shell id -g)
# The commit baked into the image, so majhi can tell when newer code is on disk.
export MAJHI_COMMIT := $(shell git rev-parse HEAD 2>/dev/null || echo dev)
# The Mac's time zone, for days, weeks and months of tokens and cost.
export MAJHI_TZ := $(shell readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||' | grep . || echo UTC)
COMPOSE := docker compose
# Laya in Docker (PyTorch CPU) everywhere but Apple silicon Macs, which run it natively (SPEC 5.12).
# `make up LAYA=docker` builds it on a Mac too, as the fallback; `LAYA=off` skips it.
LAYA ?= $(if $(filter Darwin-arm64,$(shell uname -s)-$(shell uname -m)),native,docker)
export COMPOSE_PROFILES := $(if $(filter docker,$(LAYA)),laya,)
LAYA_BUILD := $(if $(filter docker,$(LAYA)),--profile laya,)
SECRETS_KEY := $(or $(MAJHI_SECRETS_KEY),$(HOME)/.config/majhi/secrets.key)
export MAJHI_SECRETS_KEY := $(SECRETS_KEY)

.PHONY: up down logs host-logs doctor ci

## Build the server and runner images (and Laya's off Apple silicon), install the host helper, mount every workspace root from majhi.yaml, and start majhi on http://127.0.0.1:7070
up:
	@mkdir -p "$(HOME)/.majhi" "$(HOME)/.ssh"
	@touch "$(HOME)/.ssh/config" "$(HOME)/.ssh/known_hosts"
	$(COMPOSE) --profile runner $(LAYA_BUILD) build
	@if [ ! -s "$(SECRETS_KEY)" ]; then \
		echo "Creating the secrets key at $(SECRETS_KEY)"; \
		mkdir -p "$$(dirname "$(SECRETS_KEY)")" && chmod 700 "$$(dirname "$(SECRETS_KEY)")"; \
		( umask 077; docker run --rm --pull never majhi-server:dev node dist/cli.js gen-key > "$(SECRETS_KEY).tmp" ) \
			&& chmod 600 "$(SECRETS_KEY).tmp" && mv "$(SECRETS_KEY).tmp" "$(SECRETS_KEY)" \
			|| { rm -f "$(SECRETS_KEY).tmp"; exit 1; }; \
	fi
	@sh scripts/host.sh install
	@MAJHI_SSH_PUBKEYS="$$(sh scripts/host.sh pubkeys)" $(COMPOSE) run --rm --no-deps -T -e MAJHI_SSH_PUBKEYS server node dist/cli.js gen-override > docker-compose.override.yml.tmp \
		&& mv docker-compose.override.yml.tmp docker-compose.override.yml \
		|| { rm -f docker-compose.override.yml.tmp; exit 1; }
	$(COMPOSE) up -d --wait
	@echo "majhi is running on http://127.0.0.1:$${MAJHI_PORT:-7070}"

## Stop majhi and the host helper
down:
	$(COMPOSE) down
	@sh scripts/host.sh uninstall

logs:
	$(COMPOSE) logs -f --tail=200

## Follow the host helper's log: folder jobs and remounts
host-logs:
	@mkdir -p "$(HOME)/.majhi/logs" && touch "$(HOME)/.majhi/logs/host.log"
	tail -n 200 -f "$(HOME)/.majhi/logs/host.log"

## Check SSH agent, workspace mounts, git, disk space, config and the host helper from inside the container
doctor:
	@if [ -n "$$($(COMPOSE) ps -q server)" ]; then \
		$(COMPOSE) exec -T server node dist/cli.js doctor; \
	else \
		$(COMPOSE) run --rm --no-deps -T server node dist/cli.js doctor; \
	fi

ci:
	sh scripts/ci.sh

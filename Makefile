SHELL := /bin/sh
export HOST_UID := $(shell id -u)
export HOST_GID := $(shell id -g)
COMPOSE := docker compose

.PHONY: up down logs doctor ci

## Build, mount every workspace root from majhi.yaml, and start majhi on http://127.0.0.1:7070
up:
	@mkdir -p "$(HOME)/.majhi" "$(HOME)/.ssh"
	@touch "$(HOME)/.ssh/config" "$(HOME)/.ssh/known_hosts"
	$(COMPOSE) build
	@$(COMPOSE) run --rm --no-deps -T server node dist/cli.js gen-override > docker-compose.override.yml.tmp \
		&& mv docker-compose.override.yml.tmp docker-compose.override.yml \
		|| { rm -f docker-compose.override.yml.tmp; exit 1; }
	$(COMPOSE) up -d --wait
	@echo "majhi is running on http://127.0.0.1:$${MAJHI_PORT:-7070}"

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=200

## Check SSH agent, workspace mounts, git, disk space and config from inside the container
doctor:
	@if [ -n "$$($(COMPOSE) ps -q server)" ]; then \
		$(COMPOSE) exec -T server node dist/cli.js doctor; \
	else \
		$(COMPOSE) run --rm --no-deps -T server node dist/cli.js doctor; \
	fi

ci:
	sh scripts/ci.sh

SHELL := /bin/sh
# Every step lives in scripts/up.sh, which install.sh runs too; scripts/compose.sh gives the other
# targets the same environment. `make up LAYA=off` and `make up LAYA_GPU=off` reach up.sh as variables.
COMPOSE := sh scripts/compose.sh

.PHONY: up down logs host-logs doctor ci

## Build the server and runner images (and Laya's off Apple silicon), or get them from the release .env names, install the host helper, mount every workspace root from majhi.yaml, and start majhi on http://127.0.0.1:7070
up:
	@sh scripts/up.sh

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

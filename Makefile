SHELL := /bin/sh
export HOST_UID := $(shell id -u)
export HOST_GID := $(shell id -g)
UNAME_S := $(shell uname -s)
# The last NAME=value line for $(1) in .env, without quotes or CR. Compose reads .env too, but a value
# make exports wins over it there, so make reads it first.
dotenv = $(shell sed -n 's/^[[:space:]]*$(1)[[:space:]]*=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"'\r" | sed 's/^[[:space:]]*//; s/[[:space:]]*$$//')
# The commit baked into the image, so majhi can tell when newer code is on disk.
export MAJHI_COMMIT := $(shell git rev-parse HEAD 2>/dev/null || echo dev)
# This computer's time zone, for days, weeks and months of tokens and cost. Where /etc/localtime is a
# copy, not a link, systemd's timedatectl knows it.
export MAJHI_TZ := $(shell readlink /etc/localtime 2>/dev/null | sed -n 's|.*/zoneinfo/||p' | grep . || timeout 5 timedatectl show -p Timezone --value 2>/dev/null | grep . || echo UTC)
COMPOSE := docker compose
# The SSH agent socket the server gets for git (DECISIONS): MAJHI_SSH_AGENT from the command line, the
# environment or .env, else per OS. On macOS the socket OrbStack and Docker Desktop forward from the
# Mac, or an older SSH_AGENT_SOCK; on Linux and WSL2 the host helper's forwarder. `off`: no agent.
export MAJHI_SSH_AGENT := $(or $(MAJHI_SSH_AGENT),$(call dotenv,MAJHI_SSH_AGENT),$(if $(filter Darwin,$(UNAME_S)),$(or $(SSH_AGENT_SOCK),$(call dotenv,SSH_AGENT_SOCK),/run/host-services/ssh-auth.sock),$(HOME)/.majhi/run/ssh-agent.sock))
# Laya in Docker (PyTorch on the CPU, or CUDA on an NVIDIA GPU) everywhere but Apple silicon Macs,
# which run it natively (SPEC 5.12). `make up LAYA=docker` builds it on a Mac too, as the fallback;
# `LAYA=off` skips it.
LAYA ?= $(if $(filter Darwin-arm64,$(UNAME_S)-$(shell uname -m)),native,docker)
export COMPOSE_PROFILES := $(if $(filter docker,$(LAYA)),laya,)
LAYA_BUILD := $(if $(filter docker,$(LAYA)),--profile laya,)
# `make up` gives Laya an NVIDIA GPU when Docker can use one: Docker has the NVIDIA Container Toolkit's
# runtime, or WSL2 has the Windows driver. `LAYA_GPU=off` keeps the CPU; `LAYA_GPU=nvidia` skips the look.
ifeq ($(UNAME_S)-$(LAYA)-$(LAYA_GPU)-$(filter up,$(or $(MAKECMDGOALS),up)),Linux-docker--up)
  LAYA_GPU := $(shell { [ -e /usr/lib/wsl/lib/nvidia-smi ] || timeout 10 docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'; } && echo nvidia)
endif
export MAJHI_LAYA_GPU := $(if $(filter docker,$(LAYA)),$(filter nvidia,$(LAYA_GPU)),)
ifeq ($(MAJHI_LAYA_GPU),nvidia)
  # PyTorch for CUDA 13.0: amd64 and arm64, Turing (2018) or newer GPUs, driver 580 or newer. An older
  # GPU takes MAJHI_LAYA_TORCH_INDEX=https://download.pytorch.org/whl/cu126 in .env.
  export MAJHI_LAYA_TORCH_INDEX := $(or $(MAJHI_LAYA_TORCH_INDEX),$(call dotenv,MAJHI_LAYA_TORCH_INDEX),https://download.pytorch.org/whl/cu130)
  export MAJHI_LAYA_DEVICE := cuda
endif
# The secrets key file: MAJHI_SECRETS_KEY from the command line, the environment or .env, else the
# default. host.sh hands it to the helper, so its compose runs mount the same file.
SECRETS_KEY := $(or $(MAJHI_SECRETS_KEY),$(call dotenv,MAJHI_SECRETS_KEY),$(HOME)/.config/majhi/secrets.key)
export MAJHI_SECRETS_KEY := $(SECRETS_KEY)

.PHONY: up down logs host-logs doctor ci

## Build the server and runner images (and Laya's off Apple silicon), install the host helper, mount every workspace root from majhi.yaml, and start majhi on http://127.0.0.1:7070
up:
	@sh scripts/check.sh
	@mkdir -p "$(HOME)/.majhi" "$(HOME)/.ssh"
	@touch "$(HOME)/.ssh/config" "$(HOME)/.ssh/known_hosts"
	@if [ "$(MAJHI_LAYA_GPU)" = nvidia ]; then \
		echo "Laya gets the NVIDIA GPU: its image takes PyTorch for CUDA, a few GB more to download. make up LAYA_GPU=off keeps it on the CPU."; \
	fi
	$(COMPOSE) --profile runner $(LAYA_BUILD) build
	@# A key the keyring still holds (the host helper keeps a copy in the macOS Keychain or a Secret Service
	@# keyring) comes back before a new one is made. A locked keyring asks to be unlocked, so it gets a minute.
	@if [ ! -s "$(SECRETS_KEY)" ]; then \
		mkdir -p "$$(dirname "$(SECRETS_KEY)")" && chmod 700 "$$(dirname "$(SECRETS_KEY)")"; \
		if [ -x /usr/bin/security ] && ( umask 077; /usr/bin/security find-generic-password -s "majhi secrets key" -a secrets.key -w > "$(SECRETS_KEY).tmp" 2>/dev/null ) \
			&& grep -q '^AGE-SECRET-KEY-1' "$(SECRETS_KEY).tmp"; then \
			echo "Putting back the secrets key from the Keychain at $(SECRETS_KEY)"; \
		elif command -v secret-tool >/dev/null 2>&1 \
			&& ( umask 077; timeout 60 secret-tool lookup service "majhi secrets key" account secrets.key > "$(SECRETS_KEY).tmp" 2>/dev/null ) \
			&& grep -q '^AGE-SECRET-KEY-1' "$(SECRETS_KEY).tmp"; then \
			echo "Putting back the secrets key from the keyring at $(SECRETS_KEY)"; \
		else \
			echo "Creating the secrets key at $(SECRETS_KEY)"; \
			( umask 077; docker run --rm --pull never majhi-server:dev node dist/cli.js gen-key > "$(SECRETS_KEY).tmp" ) \
				|| { rm -f "$(SECRETS_KEY).tmp"; exit 1; }; \
		fi; \
		chmod 600 "$(SECRETS_KEY).tmp" && mv "$(SECRETS_KEY).tmp" "$(SECRETS_KEY)" \
			|| { rm -f "$(SECRETS_KEY).tmp"; exit 1; }; \
	fi
	@sh scripts/host.sh install
	@MAJHI_SSH_PUBKEYS="$$(sh scripts/host.sh pubkeys)" $(COMPOSE) run --rm --no-deps -T -e MAJHI_SSH_PUBKEYS -e MAJHI_SSH_AGENT -e MAJHI_LAYA_GPU server node dist/cli.js gen-override > docker-compose.override.yml.tmp \
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

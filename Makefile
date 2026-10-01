PREFIX ?= ~

.PHONY: all help build release clean install uninstall tray-windows tray-windows-setup build-web dev-web clean-web build-all release-all deploy-docs s3-up s3-down test-s3 verify-s3

all: help

help:
	@echo ""
	@echo "\033[1;36m  copa — Clipboard over HTTP\033[0m"
	@echo ""
	@echo "\033[1mBinaries:\033[0m"
	@echo "  copasrv   HTTP/WebSocket server with namespace support"
	@echo "  copacli   Local client (copy/paste/watch)"
	@echo ""
	@echo "\033[1mTargets:\033[0m"
	@echo "  \033[32mbuild\033[0m               Build debug binaries"
	@echo "  \033[32mrelease\033[0m             Build optimized release binaries"
	@echo "  \033[32mclean\033[0m               Remove build artifacts"
	@echo "  \033[32minstall\033[0m             Build release and install to \033[33m$(PREFIX)/bin\033[0m"
	@echo "  \033[32muninstall\033[0m           Remove binaries from \033[33m$(PREFIX)/bin\033[0m"
	@echo "  \033[32mtray-windows\033[0m        Cross-compile Windows tray client (.exe)"
	@echo "  \033[32mtray-windows-setup\033[0m  Install cross-compilation toolchain for Windows"
	@echo "  \033[32mbuild-web\033[0m           Build frontend (requires yarn v4)"
	@echo "  \033[32mdev-web\033[0m             Start frontend dev server"
	@echo "  \033[32mbuild-all\033[0m           Build frontend + Rust debug"
	@echo "  \033[32mrelease-all\033[0m         Build frontend + Rust release"
	@echo "  \033[32mdeploy-docs\033[0m         Build frontend and publish to docs/app/"
	@echo "  \033[32ms3-up\033[0m               Start + bootstrap the reference Garage S3 backend (docker)"
	@echo "  \033[32ms3-down\033[0m             Stop the reference Garage backend (data is kept)"
	@echo "  \033[32mtest-s3\033[0m             End-to-end file sharing test against Garage"
	@echo "  \033[32mverify-s3\033[0m           Garage + copasrv on the LAN to try by hand (HOST=name CERT=… KEY=… for HTTPS)"
	@echo ""

build:
	cargo build

release:
	cargo build --release

clean:
	cargo clean

build-web:
	cd web && yarn install && yarn build

dev-web:
	cd web && yarn install && yarn dev

clean-web:
	rm -rf web/dist web/node_modules

build-all: build-web build

release-all: build-web release

deploy-docs: build-web
	rm -rf docs/app/*
	cp -r web/dist/. docs/app/

s3-up:
	./deploy/garage/init.sh

s3-down:
	cd deploy/garage && docker compose --profile caddy down

test-s3:
	./scripts/test-s3.sh

# make verify-s3 [HOST=name] [CERT=cert.pem KEY=key.pem] [PORT=n] [S3_PORT=n] [TOKEN=t]
# Only values given on the make command line count (HOST/PORT are common shell variables).
arg = $(if $(filter command line,$(origin $(1))),$($(1)))
verify-s3:
	@COPA_VERIFY_HOST="$(call arg,HOST)" COPA_VERIFY_CERT="$(call arg,CERT)" COPA_VERIFY_KEY="$(call arg,KEY)" \
	 COPA_VERIFY_PORT="$(call arg,PORT)" COPA_VERIFY_S3_PORT="$(call arg,S3_PORT)" COPA_VERIFY_TOKEN="$(call arg,TOKEN)" \
	 ./scripts/verify-s3.sh

install: release
	install -d $(PREFIX)/bin
	install -m 755 target/release/copasrv  $(PREFIX)/bin/copasrv
	install -m 755 target/release/copacli  $(PREFIX)/bin/copacli
	@if [ -d web/dist ]; then \
	  install -d $(PREFIX)/share/copa; \
	  cp -r web/dist $(PREFIX)/share/copa/; \
	  echo "frontend installed to $(PREFIX)/share/copa/dist"; \
	fi

uninstall:
	rm -f $(PREFIX)/bin/copasrv $(PREFIX)/bin/copacli

tray-windows:
	cargo build --release --target x86_64-pc-windows-gnu --bin copa-tray
	@echo "→ target/x86_64-pc-windows-gnu/release/copa-tray.exe"

tray-windows-setup:
	rustup target add x86_64-pc-windows-gnu
	@echo "Also run: sudo apt install mingw-w64"

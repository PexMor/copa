PREFIX ?= ~

.PHONY: all help build release clean install uninstall tray-windows tray-windows-setup

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
	@echo ""

build:
	cargo build

release:
	cargo build --release

clean:
	cargo clean

install: release
	install -d $(PREFIX)/bin
	install -m 755 target/release/copasrv  $(PREFIX)/bin/copasrv
	install -m 755 target/release/copacli  $(PREFIX)/bin/copacli

uninstall:
	rm -f $(PREFIX)/bin/copasrv $(PREFIX)/bin/copacli

tray-windows:
	cargo build --release --target x86_64-pc-windows-gnu --bin copa-tray
	@echo "→ target/x86_64-pc-windows-gnu/release/copa-tray.exe"

tray-windows-setup:
	rustup target add x86_64-pc-windows-gnu
	@echo "Also run: sudo apt install mingw-w64"

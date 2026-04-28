BINARY := copa
# PREFIX ?= /usr/local
PREFIX ?= ~

.PHONY: all help build release clean install uninstall tray-windows tray-windows-setup

all: help

help:
	@echo ""
	@echo "\033[1;36m  📋 copa — Clipboard over HTTP\033[0m"
	@echo ""
	@echo "\033[1mTargets:\033[0m"
	@echo "  \033[32m🔨 build\033[0m              Build debug binary"
	@echo "  \033[32m📦 release\033[0m            Build optimized release binary"
	@echo "  \033[32m🧹 clean\033[0m              Remove build artifacts"
	@echo "  \033[32m🚀 install\033[0m            Build release and install to \033[33m$(PREFIX)/bin\033[0m"
	@echo "  \033[32m🗑️ uninstall\033[0m          Remove binary from \033[33m$(PREFIX)/bin\033[0m"
	@echo "  \033[32m🪟 tray-windows\033[0m       Cross-compile Windows tray client (.exe)"
	@echo "  \033[32m⚙️ tray-windows-setup\033[0m Install cross-compilation toolchain for Windows"
	@echo ""

build:
	cargo build

release:
	cargo build --release

clean:
	cargo clean

install: release
	install -d $(PREFIX)/bin
	install -m 755 target/release/$(BINARY) $(PREFIX)/bin/$(BINARY)

uninstall:
	rm -f $(PREFIX)/bin/$(BINARY)

tray-windows:
	cargo build --release --target x86_64-pc-windows-gnu --bin copa-tray
	@echo "→ target/x86_64-pc-windows-gnu/release/copa-tray.exe"

tray-windows-setup:
	rustup target add x86_64-pc-windows-gnu
	@echo "Also run: sudo apt install mingw-w64"

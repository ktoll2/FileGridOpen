.PHONY: help install ci current-version build watch test run package clean

VERSION := $(shell node -p "require('fs').readFileSync('VERSION', 'utf8').trim()")

help:
	@echo "Targets:"
	@echo "  install         - npm install dependencies (updates package-lock.json)"
	@echo "  ci              - npm ci; reproducible install from package-lock.json, for CI"
	@echo "  current-version - print the current version (from the VERSION file)"
	@echo "  build           - compile TypeScript to out/"
	@echo "  watch           - compile in watch mode"
	@echo "  test            - compile and run the unit test suite"
	@echo "  run             - launch an Extension Development Host with this extension loaded"
	@echo "  package         - build FileGridOpen.vsix with vsce, stamped to VERSION's value"
	@echo "  clean           - remove build output and packaged artifacts"

install:
	npm install

ci:
	npm ci

current-version:
	@echo $(VERSION)

build:
	npm run compile

watch:
	npm run watch

test:
	npm test

run: build
	code --extensionDevelopmentPath="$(CURDIR)" .

package: build
	npx --yes @vscode/vsce package $(VERSION) --no-git-tag-version --out FileGridOpen.vsix

clean:
	rm -rf out *.vsix *.tsbuildinfo

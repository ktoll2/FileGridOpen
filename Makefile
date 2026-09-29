.PHONY: help install ci current-version build watch test run package publish-vscode publish-ovsx publish clean

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
	@echo "  package         - build a .vsix package with vsce, stamped to VERSION's value"
	@echo "  publish-vscode  - publish the packaged vsix to the VS Code Marketplace (needs VSCE_PAT)"
	@echo "  publish-ovsx    - publish the packaged vsix to Open VSX (needs OVSX_PAT)"
	@echo "  publish         - publish to both marketplaces"
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
	npx --yes @vscode/vsce package $(VERSION) --no-git-tag-version --out file-grid-open.vsix

publish-vscode: package
	npx --yes @vscode/vsce publish --packagePath file-grid-open.vsix

publish-ovsx: package
	npx --yes ovsx publish file-grid-open.vsix

publish: publish-vscode publish-ovsx

clean:
	rm -rf out *.vsix *.tsbuildinfo

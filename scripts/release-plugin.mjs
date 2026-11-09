#!/usr/bin/env node
/**
 * Releases a new version of the Obsidian plugin: `pnpm release:plugin 0.2.0`.
 *
 * Bumps the version in apps/obsidian/, commits, tags it with the bare version (Obsidian wants
 * "0.2.0", not "v0.2.0") and pushes both at once. The tag starts .github/workflows/release-plugin.yml,
 * which builds the plugin, publishes the GitHub release and only then updates the root manifest.json
 * that Obsidian reads, so Obsidian never sees a version whose release doesn't exist yet.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (message) => {
	console.error(`release:plugin: ${message}`);
	process.exit(1);
};

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail('give the new version as x.y.z, e.g. `pnpm release:plugin 0.2.0`.');

if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('release from main.');
if (git('status', '--porcelain')) fail('commit or stash your changes first.');
git('fetch', '--quiet', '--tags', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main is not in sync with origin/main: pull or push first.');
if (git('tag', '--list', version)) fail(`tag ${version} already exists.`);

const files = ['apps/obsidian/manifest.json', 'apps/obsidian/package.json'];
const current = JSON.parse(readFileSync(`${root}${files[0]}`, 'utf8')).version;
const newer = (a, b) => {
	const [x, y] = [a, b].map((v) => v.split('.').map(Number));
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
	return false;
};
// The current version is fine too while it has no tag: that's releasing it for the first time.
if (version !== current && !newer(version, current)) fail(`${version} must be newer than the current ${current}.`);

if (version !== current) {
	for (const file of files) {
		const json = JSON.parse(readFileSync(`${root}${file}`, 'utf8'));
		json.version = version;
		writeFileSync(`${root}${file}`, `${JSON.stringify(json, null, '\t')}\n`);
	}
	git('add', ...files);
	git('commit', '--quiet', '-m', `Obsidian plugin ${version}`);
}
git('tag', '-a', version, '-m', `Obsidian plugin ${version}`);
// Atomic: the commit and its tag land together, or neither does.
git('push', '--quiet', '--atomic', 'origin', 'main', version);
console.log(`Pushed ${version}. GitHub is building the release: https://github.com/AlbertAhnfelt/brian/actions`);

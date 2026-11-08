import esbuild from 'esbuild';

const production = process.argv[2] === 'production';

const context = await esbuild.context({
	entryPoints: ['src/main.ts'],
	bundle: true,
	// Provided by Obsidian at runtime.
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
	format: 'cjs',
	target: 'es2022',
	platform: 'browser',
	sourcemap: production ? false : 'inline',
	minify: production,
	treeShaking: true,
	outfile: 'dist/main.js',
	logLevel: 'info'
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}

/**
 * Starting BRIAN.md files. Version 1: the wording will be tuned. Both are living documents that
 * agents keep up to date as the user works, so the user never has to write them.
 *
 * Usernames and brian names follow NAME_RULES ([a-z0-9-]), so they're safe to put in markdown.
 */

/** `brian/BRIAN.md` in the user's own Brian: how agents should work with this person. */
export function personalBrianMd(username: string): string {
	return `# ${username}'s Brian

How agents work with ${username}'s Brian. **Agents: read this first, and keep it up to date.** When you learn something lasting about ${username} or how they like to work, add it here, without being asked. Keep it short: put details in pages under \`brian/${username}/\` and link them from here.

## Layout

These hold for every Brian.

- Everything outside \`brian/\` is ${username}'s own notes. Edit a page there only when ${username} asks you to, or is working on that page with you. Don't create AI-written pages there.
- \`brian/${username}/\` is yours. Write freely there: session logs, summaries, research, context for later.
- Every other folder in \`brian/\` is a brian shared with other people. Its own BRIAN.md says what's in it.
- Don't add links between brians: other members can't follow them.

## About ${username}

_Who they are, what they work on, what they care about. Fill this in as you learn._

## How ${username} likes to work

_Preferences as they come up: tone, formats, things to always or never do._

## Map

_The most important places in this Brian, and what's in them._
`;
}

/** `brian/<name>/BRIAN.md` in a shared brian: a guide to what this brian holds. */
export function sharedBrianMd(id: string, name: string): string {
	return `---
brian: ${id}
---
# ${name}

A guide to this brian for the people and agents who use it. **Agents: keep it current.** When you add, move or remove pages, update the map. It's a summary of what's here, not a copy. Keep the \`brian:\` line at the top: it's how Brian recognises this folder.

## About

_What this brian is for, in a few sentences._

## Map

_The main folders and pages, and what's in each._

## Conventions

_How pages here are named and organised, and anything to know before editing._
`;
}

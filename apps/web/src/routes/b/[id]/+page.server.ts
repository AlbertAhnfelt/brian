import { error, fail, redirect } from '@sveltejs/kit';
import type { Outcome } from '@brian/shared';
import { account } from '#lib/server/account.ts';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(`/b/${params.id}`)}`);
	// Private brians look the same as missing ones to non-members.
	const view = await account().viewBrian(locals.user.id, params.id);
	if (!view) error(404, 'No such brian.');
	// Friends not yet in the brian, suggested when adding members.
	const inside = new Set(view.member ? view.members.map((m) => m.username) : []);
	const friends = view.member && view.brian.role === 'owner' ? (await account().friends(locals.user.id)).filter((f) => !inside.has(f)) : [];
	return { view, friends };
};

/** Runs a membership change as the signed-in user. The server checks their role. */
async function act(event: RequestEvent, change: (userId: string, form: FormData) => Promise<Outcome<unknown>>) {
	const { locals, params, request } = event;
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(`/b/${params.id}`)}`);
	const result = await change(locals.user.id, await request.formData());
	if (!result.ok) return fail(400, { message: result.message });
}

const field = (form: FormData, name: string) => String(form.get(name) ?? '');
const memberRole = (form: FormData) => (field(form, 'role') === 'editor' ? 'editor' : 'viewer');

export const actions: Actions = {
	join: (event) => act(event, (userId) => account().join(userId, event.params.id)),
	leave: async (event) => {
		const failed = await act(event, (userId) => account().leave(userId, event.params.id));
		if (failed) return failed;
		redirect(303, '/brians');
	},
	add: (event) =>
		act(event, (userId, form) => account().addMember(userId, event.params.id, field(form, 'username'), memberRole(form))),
	role: (event) =>
		act(event, (userId, form) => account().setRole(userId, event.params.id, field(form, 'username'), memberRole(form))),
	remove: (event) => act(event, (userId, form) => account().removeMember(userId, event.params.id, field(form, 'username'))),
	visibility: (event) =>
		act(event, (userId, form) =>
			account().setVisibility(userId, event.params.id, field(form, 'visibility') === 'public' ? 'public' : 'private')
		),
	delete: async (event) => {
		const failed = await act(event, async (userId, form) => {
			const view = await account().viewBrian(userId, event.params.id);
			if (!view?.member || field(form, 'confirm').trim().toLowerCase() !== view.brian.name) {
				return { ok: false, message: 'Type the brian’s name exactly to confirm.' };
			}
			return account().deleteBrian(userId, event.params.id);
		});
		if (failed) return failed;
		redirect(303, '/brians');
	}
};

import { loginAllowed } from '@brian/shared';
import { describe, expect, it } from 'vitest';

describe('loginAllowed', () => {
	it('lets everyone in when not restricted', () => {
		expect(loginAllowed({}, 'a@x.com')).toBe(true);
		expect(loginAllowed({ RESTRICT_LOGIN: 'false', ALLOWED_EMAILS: 'b@x.com' }, 'a@x.com')).toBe(true);
	});

	it('only lets listed emails in when restricted, ignoring case and spaces', () => {
		const config = { RESTRICT_LOGIN: 'true', ALLOWED_EMAILS: ' Me@Gmail.com , other@x.com' };
		expect(loginAllowed(config, 'me@gmail.com')).toBe(true);
		expect(loginAllowed(config, 'OTHER@x.com')).toBe(true);
		expect(loginAllowed(config, 'stranger@x.com')).toBe(false);
		expect(loginAllowed(config, 'gmail.com')).toBe(false);
	});

	it('lets nobody in when restricted and the list is missing or empty', () => {
		expect(loginAllowed({ RESTRICT_LOGIN: 'true' }, 'me@gmail.com')).toBe(false);
		expect(loginAllowed({ RESTRICT_LOGIN: 'true', ALLOWED_EMAILS: ' , ' }, '')).toBe(false);
	});
});

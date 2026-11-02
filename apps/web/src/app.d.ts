import type { User } from '@brian/shared';

declare global {
	namespace App {
		interface Locals {
			user: User | null;
		}
	}
}

export {};

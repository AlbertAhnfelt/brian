import type { AccountRpc } from '@brian/shared';
import { env } from 'cloudflare:workers';

/** The server's Account entrypoint over the SERVER service binding. */
export const account = () => env.SERVER as unknown as AccountRpc;

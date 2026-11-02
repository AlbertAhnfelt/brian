import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { oauthOptions } from './oauth';

export default new OAuthProvider<Env>(oauthOptions);

export { Account } from './account';
export { Vault } from './vault/vault';

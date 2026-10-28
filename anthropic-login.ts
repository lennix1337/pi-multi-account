import type { Provider } from "@earendil-works/pi-ai";
import type { AuthBlob } from "./slot-proxy-auth.ts";

export type ReadLoginCredential = (id: string) => AuthBlob | undefined;

/** A provider id stores one credential; changing auth type must use a separate account slot. */
export function protectAnthropicLogin<T extends unknown[], R>(
	id: string,
	type: "oauth" | "api_key",
	read: ReadLoginCredential,
	login: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
	const check = () => {
		const current = read(id)?.type;
		if ((current === "oauth" || current === "api_key") && current !== type) {
			throw new Error(
				`${id} already has ${current === "oauth" ? "an OAuth subscription" : "an API key"}. ` +
				"It was not replaced. Run /multi-account add anthropic, then /login and select the free anthropic-account-N slot for the other login type.",
			);
		}
	};
	return async (...args) => {
		check();
		const credential = await login(...args);
		// A different process may have filled the spare while the dialog was open.
		check();
		return credential;
	};
}

/** Expose the native secret-input API-key flow for numbered slots as well as the base provider. */
export function anthropicLoginProvider(
	base: Provider,
	id: string,
	read: ReadLoginCredential,
	models?: Provider["getModels"],
): Provider & { getAllModels: Provider["getModels"] } {
	const apiKey = base.auth.apiKey;
	const oauth = base.auth.oauth;
	const catalog = base as Provider & { getAllModels?: Provider["getModels"] };
	return {
		...base,
		id,
		name: `Anthropic (${id})`,
		getModels: () => (models?.() ?? base.getModels()).map((model) => ({ ...model, provider: id })),
		// Pi 1.x reads this catalog before getModels; never inherit the base slot identity.
		getAllModels: () => (models?.() ?? catalog.getAllModels?.() ?? base.getModels())
			.map((model) => ({ ...model, provider: id })),
		auth: {
			...base.auth,
			apiKey: apiKey?.login
				? { ...apiKey, login: protectAnthropicLogin(id, "api_key", read, apiKey.login.bind(apiKey)) }
				: apiKey,
			oauth: oauth
				? { ...oauth, login: protectAnthropicLogin(id, "oauth", read, oauth.login.bind(oauth)) }
				: oauth,
		},
	};
}

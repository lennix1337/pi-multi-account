type Shape = (payload: any, model: any, options: any) => any;
type Api = { streamSimple: (model: any, context: any, options: any) => any };
let registry: Promise<typeof import("@earendil-works/pi-ai/compat")> | undefined;

async function nativeApi(api: string): Promise<Api> {
	// external: Pi binds bare SDK imports to the running host, including bundled or virtual hosts.
	registry ??= import("@earendil-works/pi-ai/compat").catch((error) => {
		registry = undefined;
		throw error;
	});
	const native = await registry;
	const provider = native.getApiProvider?.(api as any);
	if (!provider) throw new Error(`Pi host API is unavailable: ${api}`);
	return provider;
}

/** Provider-level shaping applies to every public Pi client, including calls
 * outside the interactive agent's before_provider_request event lifecycle. */
export function createPayloadStream(shape: Shape, resolveApi: (api: string) => Api | Promise<Api> = nativeApi) {
	return (model: any, context: any, options: any = {}) => {
		const start = (api: Api) => api.streamSimple(model, context, {
			...options,
			onPayload: async (payload: any, actualModel: any) => {
				const replacement = await options.onPayload?.(payload, actualModel);
				const current = replacement === undefined ? payload : replacement;
				const shaped = await shape(current, actualModel, options);
				return shaped === undefined ? current : shaped;
			},
		});
		const api = resolveApi(model.api);
		if (!(api instanceof Promise)) return start(api);
		const stream = api.then(start);
		// external: Pi stream functions must return synchronously.
		void stream.catch(() => {});
		return {
			async *[Symbol.asyncIterator]() { yield* await stream; },
			async result() { return (await stream).result(); },
		};
	};
}

export const cursorPayloadStream = createPayloadStream((payload, _model, options) => {
	if (payload && typeof payload === "object" && typeof options.sessionId === "string" && options.sessionId.trim()) {
		payload.pi_session_id = options.sessionId;
	}
	return payload;
});
